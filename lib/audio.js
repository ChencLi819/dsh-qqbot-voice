// 音频这一层:把 QQ 的语音附件变成「能被 ASR 吃掉的字节」,以及落盘/清理。
//
// QQ 语音附件一般长这样:
//   { content_type: 'voice', url: 'https://.../xxx.silk', voice_wav_url: 'https://.../xxx.wav', asr_refer_text: '…' }
// url 是 silk(QQ 自家的编码),voice_wav_url 是平台转好的 wav —— 有 wav 就直接用,
// 没有就自己解 silk(要装 silk-wasm,没装就明说)。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function isVoiceAttachment(att) {
  const ct = att?.content_type
  if (ct === 'voice' || (typeof ct === 'string' && ct.startsWith('audio/'))) return true
  const name = String(att?.filename ?? '').toLowerCase()
  return ['.silk', '.slk', '.amr', '.wav', '.mp3', '.m4a', '.ogg'].some((ext) => name.endsWith(ext))
}

/** 协议相对 URL(//host/path)补 https */
function normalizeUrl(url) {
  return String(url).startsWith('//') ? `https:${String(url)}` : String(url)
}

/** 下载一个 https 地址,带超时和大小上限 */
async function download(url, { maxBytes, timeoutMs }) {
  const parsed = new URL(normalizeUrl(url))
  if (parsed.protocol !== 'https:') throw new Error(`只下 https(${parsed.protocol})`)
  const res = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) throw new Error(`音频超过 ${Math.round(maxBytes / 1024 / 1024)}MB`)
  return buf
}

/** PCM(s16le) 套一个 wav 头 */
export function pcmToWav(pcm, sampleRate = 24_000, channels = 1) {
  const header = Buffer.alloc(44)
  const dataSize = pcm.length
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcm])
}

/** silk → wav(要 silk-wasm;没装就抛一句人话) */
export async function silkToWav(buffer, sampleRate = 24_000) {
  let silk
  try {
    silk = await import('silk-wasm')
  } catch {
    throw new Error('收到 silk 语音但没装 silk-wasm(在 profile 里 pnpm add silk-wasm 即可解码)')
  }
  const raw = buffer.subarray(0, 10).toString('ascii') === '#!SILK_V3' ? buffer.subarray(10) : buffer
  const result = await silk.decode(raw, sampleRate)
  const pcm = Buffer.from(result.data.buffer ?? result.data, result.data.byteOffset ?? 0, result.data.byteLength ?? result.data.length)
  return pcmToWav(pcm, sampleRate)
}

/**
 * 把一条语音附件取成本地可用的音频。
 * @returns {Promise<{buffer: Buffer, mime: string, ext: string, via: string}>}
 */
export async function fetchVoiceAudio(att, { maxMB = 20, timeoutMs = 30_000, log } = {}) {
  const maxBytes = maxMB * 1024 * 1024
  const wavUrl = att?.voice_wav_url
  if (wavUrl) {
    try {
      const buffer = await download(wavUrl, { maxBytes, timeoutMs })
      return { buffer, mime: 'audio/wav', ext: '.wav', via: 'voice_wav_url' }
    } catch (error) {
      log?.('warn', `voice_wav_url 下载失败(${error?.message ?? error}),改试原始 url`)
    }
  }
  if (!att?.url) throw new Error('这条语音没有可下载的 url')
  const raw = await download(att.url, { maxBytes, timeoutMs })
  const head = raw.subarray(0, 16).toString('ascii')
  if (head.startsWith('#!SILK')) {
    const wav = await silkToWav(raw)
    return { buffer: wav, mime: 'audio/wav', ext: '.wav', via: 'silk(url)' }
  }
  const ext = head.startsWith('RIFF') ? '.wav' : head.startsWith('ID3') || head.startsWith('ÿû') ? '.mp3' : '.bin'
  return { buffer: raw, mime: ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream', ext, via: 'url' }
}

let counter = 0
/** 落盘到 dir,返回路径(调用方负责目录存在) */
export function writeAudio(dir, buffer, ext) {
  mkdirSync(dir, { recursive: true })
  counter = (counter + 1) % 1000
  const name = `voice-${Date.now()}-${process.pid}-${counter}${ext}`
  const file = join(dir, name)
  writeFileSync(file, buffer)
  return file
}
