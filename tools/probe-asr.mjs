// 探针:看看手头这些 key 里哪个能真的做语音转写。
//
// 用法:node qqbot-voice/tools/probe-asr.mjs [wav 路径]
// 结果只打印状态码和响应前几百字,不打印任何 key。
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const WAV = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '.probe', 'test-voice.wav'))
if (!existsSync(WAV)) {
  console.error(`找不到音频文件: ${WAV}`)
  process.exit(1)
}
const bytes = readFileSync(WAV)

/** 极简 yaml 取值:只认 `  KEY: value` 这种一行 */
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

async function postForm(name, url, apiKey, model, extra = {}) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'test-voice.wav')
  form.append('model', model)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const text = (await res.text()).slice(0, 400)
    console.log(`\n[${name}] ${res.status} ${res.statusText} (${Date.now() - started}ms)\n  ${text.replace(/\s+/g, ' ')}`)
    return res.ok
  } catch (err) {
    console.log(`\n[${name}] 失败: ${err?.name ?? ''} ${err?.message ?? err}`)
    return false
  }
}

async function postJson(name, url, apiKey, body) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = (await res.text()).slice(0, 500)
    console.log(`\n[${name}] ${res.status} ${res.statusText} (${Date.now() - started}ms)\n  ${text.replace(/\s+/g, ' ')}`)
    return res.ok
  } catch (err) {
    console.log(`\n[${name}] 失败: ${err?.name ?? ''} ${err?.message ?? err}`)
    return false
  }
}

console.log(`音频: ${WAV} (${(bytes.length / 1024).toFixed(1)} KB)`)
console.log(`手上有的 key: ${Object.keys(creds).join(', ') || '(没读到)'}`)

// ── 1) OpenAI 兼容的 /audio/transcriptions(各家都试一遍) ──
const transcriptions = [
  ['mz / whisper-1', 'https://ai.mztest1.top/v1/audio/transcriptions', creds.MZ_API_KEY, 'whisper-1'],
  ['mz / gpt-4o-transcribe', 'https://ai.mztest1.top/v1/audio/transcriptions', creds.MZ_API_KEY, 'gpt-4o-transcribe'],
  ['bupt / whisper-1', 'https://myai.bupt.edu.cn/llm-gw/v1/audio/transcriptions', creds.BUPT_API_KEY, 'whisper-1'],
  ['dashscope / paraformer-v2', 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions', (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY), 'paraformer-v2'],
  ['dashscope / qwen3-asr-flash', 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions', (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY), 'qwen3-asr-flash'],
  ['wx / whisper-1', 'https://chatapi.weixin.qq.com/openai/v1/audio/transcriptions', creds.WX_API_KEY, 'whisper-1'],
]
for (const [name, url, key, model] of transcriptions) {
  await postForm(name, url, key, model)
}

// ── 2) DashScope 原生多模态(音频走 base64 data url) ──
const b64 = bytes.toString('base64')
await postJson('dashscope native / qwen3-asr-flash', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY), {
  model: 'qwen3-asr-flash',
  input: {
    messages: [
      { role: 'system', content: [{ text: '' }] },
      { role: 'user', content: [{ audio: `data:audio/wav;base64,${b64}` }] },
    ],
  },
  parameters: { asr_options: { language: 'zh' } },
})

// ── 3) OpenAI 兼容 chat/completions 里塞 input_audio(mz 的 gpt 系) ──
await postJson('mz chat / gpt-5.6-luna + input_audio', 'https://ai.mztest1.top/v1/chat/completions', creds.MZ_API_KEY, {
  model: 'gpt-5.6-luna',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '把这段音频逐字转写成中文,只输出转写结果。' },
        { type: 'input_audio', input_audio: { data: b64, format: 'wav' } },
      ],
    },
  ],
})
