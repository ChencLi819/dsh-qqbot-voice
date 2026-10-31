// 语音模式 / 语音通话(对讲)的状态机 + 出站把回复念出来。
//
// 说明白一点:QQ 官方机器人 API 没有实时语音通话(RTC),机器人不能真的「拨号」。
// 这里做的是**对讲机式语音通话**:通话期间你发语音 → 机器人听(ASR)→ 机器人回语音(TTS),
// 静默一段时间自动挂断。文字回复仍然照发,当字幕用。
import { peerKey } from './store.js'

/** 从 dsh session/event 里抠出助手说的整段话 */
export function extractAssistantText(raw) {
  if (raw?.type !== 'assistant/message') return ''
  const content = raw?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function createCallKit({ settings, logger, store, speaker, resolveRecord, onModeChange, sendText }) {
  const log = (level, message) => logger?.[level]?.(`[qqbot-voice] ${message}`)
  /** key → 静默挂断定时器 */
  const timers = new Map()
  /** sessionId → 本轮是否已经用 qqbot_say 说过话(避免重复念) */
  const spoken = new Set()
  /** sessionId → 本轮攒下来的助手文本 */
  const pending = new Map()

  function clearTimer(key) {
    const timer = timers.get(key)
    if (timer) {
      clearTimeout(timer)
      timers.delete(key)
    }
  }

  function scheduleIdleHangup(key, peer, target) {
    clearTimer(key)
    const minutes = Number(settings.call.maxIdleMinutes) || 0
    if (minutes <= 0) return
    const timer = setTimeout(async () => {
      timers.delete(key)
      const entry = store.entry(key)
      if (!entry || entry.mode !== 'call') return
      store.set(key, 'off')
      onModeChange?.(key, 'off')
      log('info', `${key} 静默 ${minutes} 分钟,自动挂断`)
      if (settings.call.announce) {
        // 这时候多半已经过了被动回复窗口(要靠主动消息),群里还可能没开「主动发言」权限 ——
        // 发不出去就退回一条文字,别让「挂断」这件事静默消失。
        const target2 = target ?? { scope: peer.scope, targetId: peer.peerId }
        const said = await speaker.say(settings.call.byeText, target2)
        if (!said?.ok && sendText) await sendText(target2, '（语音没发出去，先挂了啊）')
      }
    }, minutes * 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    timers.set(key, timer)
  }

  return {
    key: peerKey,
    /** 该会话当前模式 */
    modeOf(appId, scope, peerId) {
      return store.mode(peerKey(appId, scope, peerId))
    },
    markSpoken(sessionId) {
      if (sessionId) spoken.add(sessionId)
    },

    /**
     * 切模式。mode: 'off' | 'voice' | 'call'
     * @returns {{changed: boolean, mode: string}}
     */
    setMode({ appId, scope, peerId, mode, target }) {
      const key = peerKey(appId, scope, peerId)
      const before = store.mode(key)
      if (mode === 'off') {
        store.set(key, 'off')
        clearTimer(key)
      } else {
        store.set(key, mode)
        if (mode === 'call') scheduleIdleHangup(key, { scope, peerId }, target)
      }
      if (before !== mode) onModeChange?.(key, mode)
      return { changed: before !== mode, mode }
    },

    /** 出站:攒助手文本,轮末念出来 */
    onSessionEvent(session, raw) {
      try {
        const sessionId = session?.header?.id ?? session?.id
        if (!sessionId) return
        if (raw?.type === 'assistant/message') {
          const text = extractAssistantText(raw)
          if (text) {
            const list = pending.get(sessionId) ?? []
            list.push(text)
            pending.set(sessionId, list)
          }
          return
        }
        if (raw?.type !== 'turn/end') return
        const chunks = pending.get(sessionId) ?? []
        pending.delete(sessionId)
        const alreadySpoken = spoken.delete(sessionId)
        if (alreadySpoken || chunks.length === 0) return

        const record = resolveRecord?.(sessionId)
        if (!record) return
        const mode = store.mode(peerKey(record.appId, record.scope, record.peerId))
        if (mode === 'off') return
        const text = chunks.join('\n').trim()
        if (text.length < (Number(settings.voiceReply.minChars) || 0)) return
        store.touch(peerKey(record.appId, record.scope, record.peerId))
        void speaker.say(text, record.replyTarget).catch((error) => {
          log('warn', `念回复失败:${error?.message ?? error}`)
        })
      } catch (error) {
        log('warn', `出站语音处理出错:${error?.message ?? error}`)
      }
    },

    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
      spoken.clear()
    },
  }
}
