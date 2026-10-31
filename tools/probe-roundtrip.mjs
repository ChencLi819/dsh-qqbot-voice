// 闭环探针:先说(TTS)→ 再听(ASR),看两头的字对不对得上。
// 用法:node qqbot-voice/tools/probe-roundtrip.mjs [文本] [音色]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, '..', '.probe')
mkdirSync(DIR, { recursive: true })

const creds = {}
const cf = join(homedir(), '.dsh', '.credentials.yaml')
if (existsSync(cf)) {
  for (const line of readFileSync(cf, 'utf8').split('\n')) {
    const m = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/.exec(line)
    if (m) creds[m[1]] = m[2]
  }
}
const KEY = (process.env.DASHSCOPE_API_KEY || creds.DASHSCOPE_API_KEY)
if (!KEY) throw new Error('没读到 DASHSCOPE_API_KEY')

const text = process.argv[2] ?? '喂，能听见吗？今天下午三点提醒我买米。'
const voice = process.argv[3] ?? 'Cherry'
const GEN = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

console.log(`=== TTS:qwen3-tts-flash / ${voice} ===`)
const t0 = Date.now()
const res = await fetch(GEN, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text, voice } }),
  signal: AbortSignal.timeout(90_000),
})
const json = await res.json()
if (!res.ok) {
  console.log(`FAIL ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  process.exit(1)
}
const url = json?.output?.audio?.url
console.log(`HTTP ${res.status} (${Date.now() - t0}ms) audio.url=${url ? url.slice(0, 80) + '…' : '(无)'}`)
if (!url) {
  console.log(JSON.stringify(json).slice(0, 400))
  process.exit(1)
}
const audioRes = await fetch(url, { signal: AbortSignal.timeout(60_000) })
const audio = Buffer.from(await audioRes.arrayBuffer())
const ext = url.includes('.mp3') ? 'mp3' : 'wav'
const file = join(DIR, `tts-roundtrip.${ext}`)
writeFileSync(file, audio)
console.log(`音频 ${(audio.length / 1024).toFixed(1)}KB -> ${file}`)

console.log('\n=== ASR:qwen3-asr-flash ===')
const t1 = Date.now()
const asr = await fetch(GEN, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: 'qwen3-asr-flash',
    input: { messages: [{ role: 'user', content: [{ audio: `data:audio/${ext};base64,${audio.toString('base64')}` }] }] },
    parameters: { asr_options: { language: 'zh' } },
  }),
  signal: AbortSignal.timeout(90_000),
})
const asrJson = await asr.json()
const got = asrJson?.output?.choices?.[0]?.message?.content?.[0]?.text
console.log(`HTTP ${asr.status} (${Date.now() - t1}ms)`)
console.log(`  原文:${text}`)
console.log(`  识别:${got ?? JSON.stringify(asrJson).slice(0, 300)}`)
console.log(`  用时/音频秒:${asrJson?.usage?.seconds ?? '-'}`)
