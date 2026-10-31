// 语音识别(听):把一条 QQ 语音附件变成文字。
//
// 引擎(按需降级,谁先能用谁上):
//   dashscope  qwen3-asr-flash(阿里云百炼,多模态原生接口,key 走 ~/.dsh/.credentials.yaml)
//   http       OpenAI 兼容的 /audio/transcriptions(whisper 之类)
//   command    本地命令模板,{audio} 换路径、stdout 当结果(自己装 whisper.cpp 就用这个)
//   qq         QQ 平台自带的转写(asr_refer_text,免费但有时没有)
import { fetchVoiceAudio } from './audio.js'
import { resolveApiKey } from './config.js'

/** 取出 dashscope 多模态返回里的文字 */
function pickDashscopeText(json) {
  const content = json?.output?.choices?.[0]?.message?.content
  if (Array.isArray(content)) {
    const text = content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
    if (text.trim()) return text.trim()
  }
  if (typeof json?.output?.text === 'string' && json.output.text.trim()) return json.output.text.trim()
  return ''
}

export function createStt({ settings, log }) {
  const stt = settings.stt
  const cache = new Map()
  const chain = buildChain()
  let warned = false

  function buildChain() {
    if (stt.engine === 'off') return []
    const available = {
      dashscope: Boolean(resolveApiKey(stt.dashscope)),
      http: Boolean(stt.http.baseURL),
      command: Boolean(stt.command),
      qq: true,
    }
    if (stt.engine !== 'auto') return available[stt.engine] ? [stt.engine] : []
    const order = stt.preferQq
      ? ['qq', 'dashscope', 'http', 'command']
      : ['dashscope', 'http', 'command', 'qq']
    return order.filter((name) => available[name])
  }

  async function withTimeout(promise, what) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} 超时(${stt.timeoutMs}ms)`)), stt.timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function runDashscope(audio) {
    const cfg = stt.dashscope
    const key = resolveApiKey(cfg)
    if (!key) throw new Error('没有 dashscope key')
    const res = await fetch(cfg.baseURL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.model,
        input: {
          messages: [{ role: 'user', content: [{ audio: `data:${audio.mime};base64,${audio.buffer.toString('base64')}` }] }],
        },
        parameters: { asr_options: { language: stt.language || 'zh' } },
      }),
      signal: AbortSignal.timeout(stt.timeoutMs),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`dashscope ${res.status}: ${JSON.stringify(json ?? {}).slice(0, 200)}`)
    const text = pickDashscopeText(json)
    if (!text) throw new Error(`dashscope 没返回文字:${JSON.stringify(json ?? {}).slice(0, 200)}`)
    return text
  }

  async function runHttp(audio) {
    const cfg = stt.http
    const form = new FormData()
    form.append('file', new Blob([audio.buffer], { type: audio.mime }), `voice${audio.ext}`)
    form.append('model', cfg.model)
    if (stt.language) form.append('language', stt.language)
    const key = resolveApiKey(cfg)
    const res = await fetch(cfg.baseURL, {
      method: 'POST',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: form,
      signal: AbortSignal.timeout(stt.timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`http ${res.status}: ${text.slice(0, 200)}`)
    try {
      const json = JSON.parse(text)
      if (typeof json?.text === 'string' && json.text.trim()) return json.text.trim()
    } catch {
      /* 不是 json 就当地纯文本 */
    }
    if (text.trim()) return text.trim()
    throw new Error('http 引擎没返回文字')
  }

  async function runCommand(audio, file) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const template = String(stt.command).replaceAll('{audio}', file).replaceAll('{lang}', stt.language || 'zh')
    const [cmd, ...args] = template.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? []
    if (!cmd) throw new Error('command 模板是空的')
    const { stdout } = await withTimeout(run(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }), '本地识别命令')
    const text = String(stdout).trim()
    if (!text) throw new Error('本地识别命令没输出文字')
    return text
  }

  return {
    chain,
    /** 引擎链里第一个是 qq 时,能不能直接用平台自带的转写 */
    canUseQq: chain.includes('qq'),

    /**
     * @param {object} att QQ 语音附件
     * @returns {Promise<{text: string, source: string}|null>}
     */
    async transcribe(att) {
      const cacheKey = att?.url ?? att?.voice_wav_url ?? ''
      if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)
      if (chain.length === 0) {
        if (!warned) {
          warned = true
          log?.('warn', 'stt 没有可用引擎(engine=off 或没配 key),语音只会用 QQ 自带的转写')
        }
        return null
      }

      let audio = null
      let audioFile = null
      for (const engine of chain) {
        try {
          if (engine === 'qq') {
            const text = String(att?.asr_refer_text ?? '').trim()
            if (!text) continue
            const result = { text, source: 'qq' }
            if (cacheKey) cache.set(cacheKey, result)
            return result
          }
          if (!audio) audio = await fetchVoiceAudio(att, { maxMB: stt.maxMB, timeoutMs: stt.timeoutMs, log })
          if (engine === 'command' && !audioFile) {
            const { writeAudio } = await import('./audio.js')
            const { tmpdir } = await import('node:os')
            const { join } = await import('node:path')
            audioFile = writeAudio(join(tmpdir(), 'dsh-qqbot-voice'), audio.buffer, audio.ext)
          }
          const text = await withTimeout(
            engine === 'dashscope' ? runDashscope(audio)
              : engine === 'http' ? runHttp(audio)
                : runCommand(audio, audioFile),
            `语音识别(${engine})`,
          )
          const result = { text, source: engine, via: audio.via }
          if (cacheKey) {
            cache.set(cacheKey, result)
            while (cache.size > Math.max(10, stt.cacheSize || 200)) cache.delete(cache.keys().next().value)
          }
          return result
        } catch (error) {
          log?.('warn', `语音识别 ${engine} 失败:${error?.message ?? error}`)
        }
      }
      return null
    },
  }
}
