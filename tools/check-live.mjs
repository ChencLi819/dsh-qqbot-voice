// 「到底听见了吗」——把语音链路的现场证据打出来(只读,不改任何东西)。
//
// 用法:node qqbot-voice/tools/check-live.mjs [--lines 5]
//   1. diagnostic.json:插件起没起来、挂到哪个机器人、最近一条语音附件里 QQ 给了什么字段
//   2. state.json:谁开着语音回复 / 谁在通话
//   3. ~/.dsh/sessions 里最近动过的会话日志:有没有 [Voice message] / qqbot_say 的痕迹
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readSessionLog } from '../lib/session-log.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const MAX_HITS = Number(argOf('lines', 5))
const voiceDir = join(homedir(), '.dsh', 'qqbot-voice')

console.log(`== 1. 插件体检 (${join(voiceDir, 'diagnostic.json')}) ==`)
if (!existsSync(join(voiceDir, 'diagnostic.json'))) {
  console.log('❌ 没有 diagnostic.json —— 插件没起来(装了吗?重启了吗?)')
} else {
  const diag = JSON.parse(readFileSync(join(voiceDir, 'diagnostic.json'), 'utf8'))
  console.log(`  版本 ${diag.version} · 起来于 ${diag.startedAt} · 更新于 ${diag.updatedAt}`)
  console.log(`  听: ${(diag.stt ?? []).join(' → ') || '(空)'}   说: ${(diag.tts ?? []).join(' → ') || '(空)'}`)
  console.log(`  qqbot-bots 服务: ${diag.qqbotBotsService ? '✅ 在' : '❌ 不在(补丁没打?没重启?)'}`)
  console.log(`  挂上的机器人: ${(diag.bots ?? []).map((b) => `${b.appId}(${b.reason ?? '?'} @${new Date(b.attachedAt).toLocaleTimeString()})`).join(', ') || '(无)'}`)
  if (diag.warning) console.log(`  ⚠️ ${diag.warning}`)
  if (diag.lastInbound) {
    const at = new Date(diag.lastInbound.at)
    const ageMin = ((Date.now() - at.getTime()) / 60000).toFixed(1)
    console.log(`  最近收到的消息(${at.toLocaleTimeString()},${ageMin} 分钟前):${diag.lastInbound.scope} ${String(diag.lastInbound.peerId ?? '').slice(0, 10)}… 附件 ${diag.lastInbound.attachments} 条「${diag.lastInbound.preview}」`)
    console.log('    ↑ 中间件还在链上的活证据:它不动 = 插件哑了(旧版本就是在这里漏的)')
  } else {
    console.log('  最近还没有消息经过中间件(发一条试试;一直不动说明中间件没挂上)')
  }
  if (diag.lastVoice) {
    console.log(`  最近一条语音(${diag.lastVoice.at}):`)
    for (const att of diag.lastVoice.attachments ?? []) {
      console.log(`    - content_type=${att.contentType} 字段=[${att.keys.join(', ')}] wav_url=${att.hasWavUrl ? '有' : '没有'} QQ转写=${att.hasAsrText ? '有' : '没有'}`)
    }
  } else {
    console.log('  最近还没有语音消息经过(群里/私聊发一条试试)')
  }
}

console.log(`\n== 2. 语音模式状态 (${join(voiceDir, 'state.json')}) ==`)
if (existsSync(join(voiceDir, 'state.json'))) {
  const state = JSON.parse(readFileSync(join(voiceDir, 'state.json'), 'utf8'))
  const peers = Object.entries(state.peers ?? {})
  if (peers.length === 0) console.log('  (没人开着语音回复/通话)')
  for (const [key, value] of peers) {
    const [appId, scope, peerId] = key.split(':')
    console.log(`  ${scope} ${peerId?.slice(0, 12)}… · ${value.mode === 'call' ? '📞 通话中' : '🔊 语音回复'} · 起于 ${new Date(value.since).toLocaleTimeString()} · 最后活动 ${new Date(value.lastAt).toLocaleTimeString()}`)
  }
} else {
  console.log('  (还没有 state.json)')
}

console.log('\n== 3. 会话日志里的语音痕迹 ==')
const sessionsRoot = join(homedir(), '.dsh', 'sessions')
if (!existsSync(sessionsRoot)) {
  console.log('  (没有 ~/.dsh/sessions)')
} else {
  const files = []
  for (const dir of readdirSync(sessionsRoot)) {
    const full = join(sessionsRoot, dir)
    let entries = []
    try {
      entries = readdirSync(full, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const inner = join(full, entry.name)
      for (const name of readdirSync(inner)) {
        if (!name.startsWith('session.')) continue
        const file = join(inner, name)
        try {
          files.push({ file, mtime: statSync(file).mtimeMs })
        } catch {
          /* skip */
        }
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  let hits = 0
  for (const { file, mtime } of files.slice(0, 12)) {
    let text = ''
    try {
      text = /\.zstd$/.test(file) ? readSessionLog(file) : readFileSync(file, 'utf8')
    } catch (error) {
      console.log(`  ${file}: 读不动(${error?.message ?? error})`)
      continue
    }
    const lines = text.split('\n').filter((line) => /Voice message|qqbot_say|qqbot_voice_call|语音通话/.test(line))
    if (lines.length === 0) continue
    console.log(`  ── ${file.replace(sessionsRoot, '…')} (${new Date(mtime).toLocaleString()})`)
    for (const line of lines.slice(-MAX_HITS)) {
      const snippet = line.length > 260 ? `${line.slice(0, 260)}…` : line
      console.log(`     ${snippet}`)
    }
    hits++
  }
  if (hits === 0) console.log('  (最近 12 个会话日志里没有语音相关记录)')
}
