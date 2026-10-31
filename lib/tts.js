// 语音合成(说):把一句话变成能发出去的音频文件。
//
// 引擎:
//   dashscope  qwen3-tts-flash(阿里云百炼,音色 Cherry/Serena/Ethan/Chelsie)
//   http       OpenAI 兼容的 /audio/speech
//   command    本地命令模板:{text} 文本、{out} 输出文件、{voice} 音色
//              (自己 pip 装了 edge-tts / piper / GPT-SoVITS 就用这个接)
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveApiKey } from './config.js'
import { writeAudio } from './audio.js'

/** QQ 的媒体目录(qqbot 插件默认的富媒体根,自带过期清理) */
export const QQ_MEDIA_ROOT = join(homedir(), '.dsh-qqbot', 'media')

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu

/**
 * 把「给人看的回复」洗成「适合念出来的话」。
 * 去代码块/行内代码/链接/markdown 记号/emoji,保留中文标点。
 */
export function sanitizeForSpeech(input, maxChars = 180) {
  let text = String(input ?? '')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  text = text.replace(/https?:\/\/\S+/g, ' ')
  text = text.replace(/<[^>]{1,40}>/g, ' ')
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  text = text.replace(/^\s{0,3}[-*+>]\s+/gm, '')
  text = text.replace(/^\s{0,3}\d+[.、)]\s+/gm, '')
  text = text.replace(/[*_~|]+/g, '')
  text = text.replace(EMOJI_RE, '')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\s*\n\s*/g, '，')
  text = text.replace(/，{2,}/g, '，')
  text = text.replace(/^[，、。！？!?~\s]+/, '')
  text = text.trim()
  const limit = Math.max(20, Number(maxChars) || 180)
  if (text.length > limit) {
    const cut = text.slice(0, limit)
    const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'))
    text = stop > limit * 0.5 ? cut.slice(0, stop + 1) : `${cut}…`
  }
  return text
}

/** 取出 dashscope TTS 返回里的音频地址 */
function pickAudioUrl(json) {
  const audio = json?.output?.audio
  if (typeof audio === 'string') return audio
  if (audio && typeof audio.url === 'string') return audio.url
  return ''
}

export function createTts({ settings, log }) {
  const tts = settings.tts
  const chain = buildChain()

  function buildChain() {
    if (tts.engine === 'off') return []
    const available = {
      dashscope: Boolean(resolveApiKey(tts.dashscope)),
      http: Boolean(tts.http.baseURL),
      command: Boolean(tts.command),
    }
    if (tts.engine !== 'auto') return available[tts.engine] ? [tts.engine] : []
    return ['dashscope', 'http', 'command'].filter((name) => available[name])
  }

  async function runDashscope(text) {
    const cfg = tts.dashscope
    const key = resolveApiKey(cfg)
    if (!key) throw new Error('没有 dashscope key')
    const res = await fetch(cfg.baseURL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, input: { text, voice: cfg.voice } }),
      signal: AbortSignal.timeout(tts.timeoutMs),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`dashscope ${res.status}: ${JSON.stringify(json ?? {}).slice(0, 200)}`)
    const url = pickAudioUrl(json)
    if (!url) throw new Error(`dashscope 没返回音频:${JSON.stringify(json ?? {}).slice(0, 200)}`)
    const audioRes = await fetch(url, { signal: AbortSignal.timeout(tts.timeoutMs) })
    if (!audioRes.ok) throw new Error(`音频下载失败 HTTP ${audioRes.status}`)
    const buffer = Buffer.from(await audioRes.arrayBuffer())
    const ext = /\.mp3(\?|$)/i.test(url) ? '.mp3' : '.wav'
    return { buffer, ext, mime: ext === '.mp3' ? 'audio/mpeg' : 'audio/wav' }
  }

  async function runHttp(text) {
    const cfg = tts.http
    const key = resolveApiKey(cfg)
    const format = cfg.format || 'mp3'
    const res = await fetch(cfg.baseURL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: format }),
      signal: AbortSignal.timeout(tts.timeoutMs),
    })
    if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0) throw new Error('http 引擎返回空音频')
    return { buffer, ext: `.${format}`, mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }
  }

  async function runCommand(text) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const out = join(tmpdir(), 'dsh-qqbot-voice', `tts-${Date.now()}-${process.pid}.mp3`)
    mkdirSync(join(tmpdir(), 'dsh-qqbot-voice'), { recursive: true })
    const template = String(tts.command)
      .replaceAll('{text}', text)
      .replaceAll('{out}', out)
      .replaceAll('{voice}', tts.dashscope.voice || '')
    const [cmd, ...args] = template.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? []
    if (!cmd) throw new Error('command 模板是空的')
    await run(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: tts.timeoutMs })
    const buffer = readFileSync(out)
    rmSync(out, { force: true })
    if (buffer.length === 0) throw new Error('本地合成命令没产出音频')
    return { buffer, ext: '.mp3', mime: 'audio/mpeg' }
  }

  return {
    chain,
    /** @returns {Promise<{buffer: Buffer, ext: string, mime: string, engine: string}|null>} */
    async synthesize(rawText) {
      const text = sanitizeForSpeech(rawText, tts.maxChars)
      if (!text) return null
      if (chain.length === 0) {
        log?.('warn', 'tts 没有可用引擎(engine=off 或没配 key),发不了语音')
        return null
      }
      for (const engine of chain) {
        try {
          const audio = engine === 'dashscope' ? await runDashscope(text)
            : engine === 'http' ? await runHttp(text)
              : await runCommand(text)
          return { ...audio, engine, text }
        } catch (error) {
          log?.('warn', `语音合成 ${engine} 失败:${error?.message ?? error}`)
        }
      }
      return null
    },
  }
}

/**
 * 「开口说话」:合成 → 落盘到 QQ 媒体目录 → 交给 qqbot 的发送器。
 * @param {{mediaSender: object, appId: string}} entry
 */
export function createSpeaker({ entry, settings, logger, tts }) {
  const dir = settings.audioDir || QQ_MEDIA_ROOT
  const log = (level, message) => logger?.[level]?.(`[qqbot-voice] ${message}`)
  return {
    tts,
    async say(text, target) {
      const audio = await tts.synthesize(text)
      if (!audio) return { ok: false, error: '合成失败(看日志里的引擎报错)' }
      const file = writeAudio(dir, audio.buffer, audio.ext)
      try {
        // 注意:SDK 的 sendVoice 要的是 { localPath }(或 {url}/{buffer}),
        // 传裸路径会在 normalizeSource 里炸 —— 而且炸得很安静,用户只看到「只回文字」。
        await entry.mediaSender.sendVoice(target, { localPath: file })
        log('info', `语音已发出(${audio.engine},${(audio.buffer.length / 1024).toFixed(1)}KB):${audio.text.slice(0, 40)}`)
        return { ok: true, file, engine: audio.engine, spoken: audio.text }
      } catch (error) {
        log('warn', `发语音失败:${error?.message ?? error}`)
        return { ok: false, error: error?.message ?? String(error), file }
      }
    },
  }
}
