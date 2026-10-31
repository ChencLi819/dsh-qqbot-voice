// 探针:先看谁能「说」(TTS),再拿它生成的音频去看谁能「听」(ASR)。
// 只打印状态码和响应片段,不打印 key。
//
// 用法:node qqbot-voice/tools/probe-voice.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, '..', '.probe')
mkdirSync(DIR, { recursive: true })

function readCredentials() {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}
const creds = readCredentials()
const brief = (t, n = 300) => t.replace(/\s+/g, ' ').slice(0, n)

async function tryJson(name, url, apiKey, body, { saveTo } = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    const ct = res.headers.get('content-type') ?? ''
    if (res.ok && ct.startsWith('audio/')) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (saveTo) writeFileSync(saveTo, buf)
      console.log(`[${name}] ${res.status} audio ${ct} ${(buf.length / 1024).toFixed(1)}KB (${Date.now() - t0}ms)${saveTo ? ' -> ' + saveTo : ''}`)
      return { ok: true, audio: buf, file: saveTo }
    }
    const text = await res.text()
    console.log(`[${name}] ${res.status} ${res.statusText} (${Date.now() - t0}ms)\n   ${brief(text)}`)
    return { ok: res.ok, text }
  } catch (err) {
    console.log(`[${name}] 失败 ${err?.name ?? ''}: ${err?.message ?? err}`)
    return { ok: false }
  }
}

console.log('=== TTS 候选 ===')

// 1) OpenAI 兼容 /audio/speech(MZ 中转、wx 通道都试)
const speech = await tryJson('mz / tts-1', 'https://ai.mztest1.top/v1/audio/speech', creds.MZ_API_KEY, {
  model: 'tts-1', voice: 'alloy', input: '喂，能听见吗？这是一条语音测试。', response_format: 'mp3',
}, { saveTo: join(DIR, 'mz-tts-1.mp3') })

await tryJson('mz / gpt-4o-mini-tts', 'https://ai.mztest1.top/v1/audio/speech', creds.MZ_API_KEY, {
  model: 'gpt-4o-mini-tts', voice: 'alloy', input: '喂，能听见吗？', response_format: 'mp3',
}, { saveTo: join(DIR, 'mz-gpt4o-mini-tts.mp3') })

await tryJson('wx / tts-1', 'https://chatapi.weixin.qq.com/openai/v1/audio/speech', creds.WX_API_KEY, {
  model: 'tts-1', voice: 'alloy', input: '喂，能听见吗？', response_format: 'mp3',
}, { saveTo: join(DIR, 'wx-tts-1.mp3') })

// 2) DashScope qwen-tts(原生接口,返回音频 URL)
const qwenTts = await tryJson('dashscope / qwen-tts', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY), {
  model: 'qwen-tts',
  input: { text: '喂，能听见吗？这是一条语音测试。', voice: 'Cherry' },
})
if (qwenTts.ok && qwenTts.text) {
  const url = /"(https?:\/\/[^"]+\.(?:wav|mp3))"/.exec(qwenTts.text)?.[1]
  if (url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      const buf = Buffer.from(await r.arrayBuffer())
      const ext = url.endsWith('.mp3') ? 'mp3' : 'wav'
      const file = join(DIR, `qwen-tts.${ext}`)
      writeFileSync(file, buf)
      console.log(`   ↳ 音频下载成功 ${(buf.length / 1024).toFixed(1)}KB -> ${file}`)
    } catch (err) {
      console.log(`   ↳ 音频下载失败: ${err?.message ?? err}`)
    }
  }
}

console.log('\n=== ASR 候选(拿上面生成的音频来试) ===')
const probeAudio = [speech.file, join(DIR, 'qwen-tts.mp3'), join(DIR, 'qwen-tts.wav'), join(DIR, 'wx-tts-1.mp3')]
  .find((p) => p && existsSync(p))
if (!probeAudio) {
  console.log('没有可用的测试音频,先解决 TTS。')
  process.exit(0)
}
console.log(`测试音频: ${probeAudio}`)
const audio = readFileSync(probeAudio)
const mime = probeAudio.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'
const b64 = audio.toString('base64')

async function tryTranscription(name, url, apiKey, model) {
  const form = new FormData()
  form.append('file', new Blob([audio], { type: mime }), probeAudio.split(/[\\/]/).pop())
  form.append('model', model)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(90_000),
    })
    const text = await res.text()
    console.log(`[${name}] ${res.status} ${res.statusText} (${Date.now() - t0}ms)\n   ${brief(text, 400)}`)
  } catch (err) {
    console.log(`[${name}] 失败 ${err?.name ?? ''}: ${err?.message ?? err}`)
  }
}

await tryTranscription('mz / whisper-1', 'https://ai.mztest1.top/v1/audio/transcriptions', creds.MZ_API_KEY, 'whisper-1')
await tryTranscription('mz / gpt-4o-transcribe', 'https://ai.mztest1.top/v1/audio/transcriptions', creds.MZ_API_KEY, 'gpt-4o-transcribe')
await tryTranscription('bupt / whisper-1', 'https://myai.bupt.edu.cn/llm-gw/v1/audio/transcriptions', creds.BUPT_API_KEY, 'whisper-1')
await tryTranscription('wx / whisper-1', 'https://chatapi.weixin.qq.com/openai/v1/audio/transcriptions', creds.WX_API_KEY, 'whisper-1')
await tryTranscription('dashscope / paraformer-v2', 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions', (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY), 'paraformer-v2')
await tryTranscription('dashscope / qwen3-asr-flash', 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions', (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY), 'qwen3-asr-flash')

// DashScope 原生多模态 ASR(base64 直塞)
await tryJson('dashscope native / qwen3-asr-flash', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY), {
  model: 'qwen3-asr-flash',
  input: { messages: [{ role: 'user', content: [{ audio: `data:${mime};base64,${b64}` }] }] },
  parameters: { asr_options: { language: 'zh' } },
})
