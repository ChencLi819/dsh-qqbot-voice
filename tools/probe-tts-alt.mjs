// 小探针:① DashScope 有没有能用的 TTS 模型 ② npm 上 silk-wasm / ws 的版本
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const creds = {}
const cf = join(homedir(), '.dsh', '.credentials.yaml')
if (existsSync(cf)) {
  for (const line of readFileSync(cf, 'utf8').split('\n')) {
    const m = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/.exec(line)
    if (m) creds[m[1]] = m[2]
  }
}
const KEY = (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY)

async function post(name, url, body, headers = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${KEY}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    console.log(`[${name}] ${res.status} ${text}`)
  } catch (err) {
    console.log(`[${name}] 失败 ${err?.message ?? err}`)
  }
}

console.log('=== DashScope TTS 候选 ===')
// 原生 text2speech / multimodal-generation 两条路都试几个模型名
for (const model of ['cosyvoice-v1', 'cosyvoice-v2', 'sambert-zhichu-v1', 'qwen3-tts-flash', 'qwen-tts-latest']) {
  await post(`multimodal-generation / ${model}`, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    model,
    input: { text: '喂，能听见吗？', voice: 'Cherry' },
  })
}
await post('text2speech / sambert-zhichu-v1', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2speech/synthesis', {
  model: 'sambert-zhichu-v1',
  input: { text: '喂，能听见吗？' },
  parameters: { format: 'mp3' },
})

console.log('\n=== npm 包版本 ===')
for (const pkg of ['silk-wasm', 'ws', 'msedge-tts']) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) {
      console.log(`${pkg}: HTTP ${res.status}`)
      continue
    }
    const json = await res.json()
    console.log(`${pkg}: latest=${json['dist-tags']?.latest} (${json.versions?.[json['dist-tags']?.latest]?.description ?? ''})`)
  } catch (err) {
    console.log(`${pkg}: 失败 ${err?.message ?? err}`)
  }
}
