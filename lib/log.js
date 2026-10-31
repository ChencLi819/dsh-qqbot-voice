// 日志:既写给宿主 logger,也追加到 ~/.dsh/qqbot-voice/voice.log。
//
// 为什么要落盘:桌面版看不到 stdout,而「语音没发出去」这类失败只写日志 ——
// 用户那边表现成「只回文字」,一点线索都没有。落一份盘,check-live 就能看。
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 512 * 1024

export function createLogger(stateDir, hostLogger) {
  const file = join(stateDir, 'voice.log')
  const write = (level, message) => {
    const text = String(message)
    const line = `${new Date().toISOString()} [${level}] ${text}\n`
    try {
      mkdirSync(stateDir, { recursive: true })
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* 文件还不存在 */
      }
      appendFileSync(file, line)
    } catch {
      /* 写不动就算了 */
    }
    try {
      const fn = hostLogger?.[level]
      if (typeof fn === 'function') fn.call(hostLogger, text.startsWith('[qqbot-voice]') ? text : `[qqbot-voice] ${text}`)
      else if (level === 'error' || level === 'warn') console.log(`[qqbot-voice] ${text}`)
    } catch {
      /* 日志失败不连坐 */
    }
  }
  return {
    file,
    log: write,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}
