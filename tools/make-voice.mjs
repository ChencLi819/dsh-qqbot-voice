// 单独试「说」:用插件的 TTS 引擎合成一条语音到本地文件(不碰 QQ)。
// 用法:node qqbot-voice/tools/make-voice.mjs [文本] [输出文件] [音色]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { mergeConfig } from '../lib/config.js'
import { createTts } from '../lib/tts.js'

const text = process.argv[2] ?? '喂，这条语音是用插件合成的。'
const out = resolve(process.argv[3] ?? join(import.meta.dirname, '..', '.probe', 'make-voice.wav'))
const voice = process.argv[4]

const settings = mergeConfig(voice ? { tts: { dashscope: { voice } } } : {})
const tts = createTts({ settings, log: (level, message) => console.log(`[${level}] ${message}`) })
console.log(`引擎链: ${tts.chain.join(' → ') || '(空,发不了语音)'}`)

const t0 = Date.now()
const audio = await tts.synthesize(text)
if (!audio) {
  console.log('❌ 合成失败(看上面的日志)')
  process.exit(1)
}
const file = out.replace(/\.[a-z0-9]+$/i, audio.ext)
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, audio.buffer)
console.log(`✅ ${audio.engine} · 念的是「${audio.text}」`)
console.log(`   ${(audio.buffer.length / 1024).toFixed(1)}KB (${Date.now() - t0}ms) -> ${file}`)
