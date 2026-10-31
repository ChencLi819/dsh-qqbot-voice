// 会话日志是「一帧一帧追加」的 zstd,Node 的 zstdDecompressSync 只认第一帧。
// 这个脚本按 zstd magic(28 B5 2F FD)切帧,逐帧解,再拼起来。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function readSessionLog(file) {
  const raw = readFileSync(file)
  const starts = []
  let index = raw.indexOf(MAGIC)
  while (index >= 0) {
    starts.push(index)
    index = raw.indexOf(MAGIC, index + 4)
  }
  if (starts.length === 0) return raw.toString('utf8')
  const parts = []
  for (let i = 0; i < starts.length; i++) {
    const slice = raw.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : raw.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
    } catch (error) {
      parts.push(`\n{"__decode_error":"${error.message}"}\n`)
    }
  }
  return parts.join('')
}

// 直接跑这个文件时才当 CLI 用(被 check-live.mjs import 时不要抢它的参数)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain && process.argv[2]) {
  const text = readSessionLog(process.argv[2])
  const lines = text.split('\n').filter(Boolean)
  console.log(`解出 ${text.length} 字符 / ${lines.length} 行`)
  const patterns = process.argv.slice(3)
  if (patterns.length === 0) {
    console.log('--- 最后 5 行 ---')
    for (const line of lines.slice(-5)) console.log(line.slice(0, 500))
  } else {
    for (const pattern of patterns) {
      const hits = lines.filter((line) => line.includes(pattern))
      console.log(`\n=== 「${pattern}」命中 ${hits.length} 行 ===`)
      for (const line of hits.slice(-4)) console.log(line.slice(0, 600))
    }
  }
}
