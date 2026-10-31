// dsh-qqbot-voice —— 让 QQ 机器人长耳朵和嘴:
//   · 听:群里/私聊有人发语音,自动转成文字进上下文(ASR);
//   · 说:能用语音回话(TTS),也能按指令开口;
//   · 通话:对讲机式的语音通话 —— 通话期间你发语音、机器人回语音,静默自动挂断。
//
// QQ 官方机器人 API 没有实时语音通话(RTC),所以「通话」是语音消息一来一回的
// 对讲模式;文字回复照发,当字幕用。
//
// 三个接线点:
//   1. 入站中间件(挂在 QQBot 实例上):转写 + 指令 + 语音模式提示;
//   2. 出站:监听 session/event,通话/语音模式下把助手回复念出来;
//   3. 工具:qqbot_say(说一句)、qqbot_voice_call(开/关通话)。
//
// 机器人实例从哪来:dsh-qqbot 只 provide 了 qqbot-sessions,拿不到 bot 实例,
// 所以 tools/patch-dsh-qqbot-voice-hook.mjs 会在 dsh-qqbot 的 bootstrap 里挂一个
// qqbot-bots 注册表(装了没打补丁就在日志里说清楚)。
import { mergeConfig, stateDirOf, DEFAULT_PROMPT, LIB_VERSION } from './lib/config.js'
import { createStore, peerKey } from './lib/store.js'
import { createStt } from './lib/stt.js'
import { createTts, createSpeaker } from './lib/tts.js'
import { createCallKit } from './lib/call.js'
import { createInbound } from './lib/middleware.js'
import { createLogger } from './lib/log.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'qqbot-voice'

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

const sessionIdOf = (exec) => {
  try {
    return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
  } catch {
    return ''
  }
}

export function apply(ctx, config = {}) {
  const settings = mergeConfig(config)
  const stateDir = stateDirOf(settings)
  // 日志落盘:桌面版看不到 stdout,而「语音没发出去」这种失败只写日志
  const fileLog = createLogger(stateDir, ctx.logger ?? console)
  const log = (level, message) => fileLog.log(level, message)
  const logger = fileLog

  if (settings.enabled === false) {
    log('info', '插件已停用(enabled: false)')
    return
  }

  const store = createStore(stateDir)
  const stt = createStt({ settings, log })
  const tts = createTts({ settings, log })
  log('info', `听:${stt.chain.join(' → ') || 'off(只用 QQ 自带转写)'} · 说:${tts.chain.join(' → ') || 'off(发不了语音)'} · 状态:${store.file}`)

  /** appId → { entry, speaker, call } */
  const bots = new Map()

  /**
   * 体检文件:插件起没起来、挂到哪个机器人了、听/说用什么引擎 ——
   * 桌面版看不到 stdout 的时候,看一眼 ~/.dsh/qqbot-voice/diagnostic.json 就知道。
   */
  const diagnostics = {
    version: LIB_VERSION,
    startedAt: new Date().toISOString(),
    stt: stt.chain,
    tts: tts.chain,
    qqbotBotsService: false,
    bots: [],
  }
  const diagFile = join(stateDir, 'diagnostic.json')
  const writeDiagnostics = () => {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(diagFile, `${JSON.stringify({ ...diagnostics, updatedAt: new Date().toISOString() }, null, 2)}\n`)
    } catch {
      /* 写不动就算了 */
    }
  }
  writeDiagnostics()

  // ── 出站:只注册一个监听器,分发给所有已挂上的机器人 ──
  // (以前是每次 attach 注册一个 —— 重挂几次就会重复念。sessionId 怎么取交给 call 自己判断)
  ctx.on('session/event', (session, event) => {
    for (const state of bots.values()) {
      try {
        state.call.onSessionEvent(session, event)
      } catch (error) {
        log('warn', `出站处理出错:${error?.message ?? error}`)
      }
    }
  })

  /** 拿某个会话的「往哪发」材料(会遍历所有机器人) */
  const resolveRecord = (sessionId) => {
    if (!sessionId) return null
    for (const [appId, state] of bots) {
      try {
        const record = state.entry.manager?.findBySessionId?.(sessionId)
        if (record) {
          return {
            appId,
            scope: record.scope,
            peerId: record.peerId,
            senderId: record.senderId,
            replyTarget: record.replyTarget,
            agent: record.agent,
          }
        }
      } catch {
        /* 这个机器人查不到就换下一个 */
      }
    }
    return null
  }

  const modeText = (mode) => (mode === 'call' ? '通话中' : mode === 'voice' ? '语音回复开着' : '语音回复关着')

  /** 我们挂在某个机器人上的中间件还在不在链上 */
  const hasMiddleware = (bot, middleware) => {
    try {
      const list = bot?.getMiddlewares?.() ?? bot?.middlewares
      return Array.isArray(list) ? list.includes(middleware) : true
    } catch {
      return true
    }
  }

  /** 从机器人的中间件链上摘掉自己(SDK 的 use() 只返回 this,不给卸载函数) */
  const removeMiddleware = (bot, middleware) => {
    try {
      const list = bot?.getMiddlewares?.() ?? bot?.middlewares
      if (!Array.isArray(list)) return
      const index = list.indexOf(middleware)
      if (index >= 0) list.splice(index, 1)
    } catch {
      /* 摘不掉就算了,旧实例通常已经死了 */
    }
  }

  function attachBot(entry, opts = {}) {
    const prev = bots.get(entry.appId)
    // 同一个机器人实例、中间件也还在链上 —— 什么都不用做
    if (prev && prev.bot === entry.bot && hasMiddleware(entry.bot, prev.inbound)) return
    if (prev) {
      // 机器人实例被换掉了(插件重载会新建一个 QQBot):旧链上的中间件从此收不到消息,
      // 必须重新挂 —— 之前就是这里漏了,表现为「插件看着好好的,但语音功能全哑了」。
      removeMiddleware(prev.bot, prev.inbound)
      try {
        prev.call.dispose()
      } catch {
        /* ignore */
      }
      log('info', `机器人实例换了(${opts.reason ?? 'register'}),把中间件重新挂到新实例上:${entry.appId}`)
    }
    const speaker = createSpeaker({ entry, settings, logger, tts })
    const call = createCallKit({
      settings,
      logger,
      store,
      speaker,
      sendText: async (target, text) => {
        try {
          await entry.bot.sendMarkdown(target, text)
        } catch (error) {
          log('warn', `退回文字也失败了:${error?.message ?? error}`)
        }
      },
      resolveRecord: (sessionId) => {
        try {
          const record = entry.manager?.findBySessionId?.(sessionId)
          if (!record) return null
          return { appId: entry.appId, scope: record.scope, peerId: record.peerId, replyTarget: record.replyTarget }
        } catch {
          return null
        }
      },
    })
    const inbound = createInbound({
      appId: entry.appId,
      settings,
      logger,
      stt,
      call,
      speaker,
      onVoiceProbe: (attachments) => {
        diagnostics.lastVoice = { at: new Date().toISOString(), attachments }
        writeDiagnostics()
      },
      onInbound: (info) => {
        diagnostics.lastInbound = info
        writeDiagnostics()
      },
    })
    try {
      entry.bot.use(inbound)
    } catch (error) {
      log('warn', `挂入站中间件失败:${error?.message ?? error}`)
    }
    bots.set(entry.appId, {
      entry,
      bot: entry.bot,
      inbound,
      speaker,
      call,
      detach() {
        removeMiddleware(entry.bot, inbound)
        try {
          call.dispose()
        } catch {
          /* ignore */
        }
      },
      dispose() {
        call.dispose()
      },
    })
    diagnostics.bots.push({ appId: entry.appId, attachedAt: new Date().toISOString(), reason: opts.reason ?? 'register' })
    writeDiagnostics()
    log('info', `已挂到机器人 ${entry.appId}(听/说/通话就绪)`)
  }

  // ── 1) 机器人实例(需要 qqbot-bots 服务;见 tools/patch-dsh-qqbot-voice-hook.mjs) ──
  let warnedNoRegistry = false
  let watchdog = null
  ctx.inject(['qqbot-bots'], (scope) => {
    const registry = scope['qqbot-bots'] ?? scope.get?.('qqbot-bots')
    diagnostics.qqbotBotsService = Boolean(registry?.onBot)
    writeDiagnostics()
    if (!registry?.onBot) {
      log('warn', 'qqbot-bots 服务在,但形状不对(版本不匹配?)')
      return
    }
    const off = registry.onBot((entry) => attachBot(entry, { reason: 'register' }))
    // 对账:插件热重载会新建一个 QQBot 实例,注册表里的 entry 跟着换 —— 光靠注册回调
    // 有可能漏(服务重新 provide 时监听器才补上),所以再定期核对一次,顺带把
    // 「中间件被人从链上摘掉了」这种也修回来。
    watchdog = setInterval(() => {
      try {
        const list = registry?.list
        if (!list?.values) return
        for (const entry of list.values()) attachBot(entry, { reason: 'watchdog' })
      } catch (error) {
        log('warn', `对账出错:${error?.message ?? error}`)
      }
    }, 60_000)
    if (typeof watchdog.unref === 'function') watchdog.unref()
    scope.effect(() => () => {
      off?.()
      clearInterval(watchdog)
    }, 'qqbot-voice: bot registry')
  })
  // 服务一直没出现 = 补丁没打,给一句人话(延迟几秒,等插件都加载完)
  const warnTimer = setTimeout(() => {
    if (bots.size === 0 && !warnedNoRegistry) {
      warnedNoRegistry = true
      diagnostics.warning = '没拿到任何机器人实例:qqbot-bots 服务没出现,或机器人还没建起来'
      writeDiagnostics()
      log('warn', '没拿到任何机器人实例 —— dsh-qqbot 需要打补丁:node qqbot-voice/tools/patch-dsh-qqbot-voice-hook.mjs(打完重启 DSH)')
    }
  }, 15_000)
  if (typeof warnTimer.unref === 'function') warnTimer.unref()

  // ── 2) 工具:qqbot_say / qqbot_voice_call ──
  ctx.inject(['tools'], (scope) => {
    const tools = scope.tools
    if (!tools?.register) {
      log('warn', 'tools 服务不可用,qqbot_say / qqbot_voice_call 没注册')
      return
    }

    const disposes = []
    disposes.push(tools.register({
      name: 'qqbot_say',
      description:
        '用语音说一句话(合成后作为 QQ 语音消息发到当前会话)。适合被要求「说给我听」「用语音回」,或者语气比文字更合适的时候。' +
        '一句话就行,别太长(超过约 180 字会被截断)。只在 QQ 会话里能用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要念出来的话(口语、短句,不要 Markdown)' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const record = resolveRecord(sessionId)
        if (!record) return { text: '这个会话不是 QQ 会话(或者机器人还没挂上),发不了语音。' }
        const state = bots.get(record.appId)
        const result = await state.speaker.say(String(args.text ?? ''), record.replyTarget)
        if (!result.ok) return { text: `语音没发出去:${result.error}` }
        state.call.markSpoken(sessionId)
        return { text: `已用语音说了:「${result.spoken}」(${result.engine})` }
      },
    }))

    disposes.push(tools.register({
      name: 'qqbot_voice_call',
      description:
        '语音通话(对讲)开关。start = 开始通话(之后你的回复会自动转成语音发出去,对方发语音也会自动转文字给你),' +
        'end = 挂断,voice = 只开语音回复(文字照发,另配一条语音),off = 全关,status = 看当前状态。' +
        '对方说「打个电话」「语音聊」「别打字了」时用 start;说「挂了」时用 end。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'start | end | voice | off | status' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const record = resolveRecord(sessionId)
        if (!record) return { text: '这个会话不是 QQ 会话,通话开关只对 QQ 生效。' }
        const state = bots.get(record.appId)
        const action = String(args.action ?? 'status').toLowerCase()
        const key = peerKey(record.appId, record.scope, record.peerId)
        if (action === 'status') {
          return { text: `当前:${modeText(store.mode(key))}。听:${stt.chain.join(' → ') || 'QQ 自带转写'};说:${tts.chain.join(' → ') || '没配引擎'}` }
        }
        if (action === 'start') {
          const { changed } = state.call.setMode({ appId: record.appId, scope: record.scope, peerId: record.peerId, mode: 'call', target: record.replyTarget })
          if (changed && settings.call.announce) await state.speaker.say(settings.call.greetText, record.replyTarget)
          return { text: changed ? '通话开始了,接下来用语音聊(静默太久会自己挂断)。' : '本来就在通话里。' }
        }
        if (action === 'end') {
          const was = store.mode(key) !== 'off'
          state.call.setMode({ appId: record.appId, scope: record.scope, peerId: record.peerId, mode: 'off', target: record.replyTarget })
          if (was && settings.call.announce) await state.speaker.say(settings.call.byeText, record.replyTarget)
          return { text: was ? '挂了。' : '本来就没在通话。' }
        }
        if (action === 'voice' || action === 'off') {
          const mode = action === 'voice' ? 'voice' : 'off'
          state.call.setMode({ appId: record.appId, scope: record.scope, peerId: record.peerId, mode, target: record.replyTarget })
          return { text: mode === 'voice' ? '语音回复开了:回复会再念一遍。' : '语音回复关了。' }
        }
        return { text: `不认识 action=${action}(用 start / end / voice / off / status)` }
      },
    }))

    log('info', '工具已注册:qqbot_say / qqbot_voice_call')
    scope.effect(() => () => {
      for (const dispose of disposes) {
        try {
          dispose?.()
        } catch {
          /* 卸载失败不连坐 */
        }
      }
    }, 'qqbot-voice: tools')
  })

  // ── 3) 提示词:让模型知道耳朵和嘴怎么用 ──
  ctx.inject(['systemPrompt'], (scope) => {
    if (settings.promptEnabled === false) return
    scope.effect(() => scope.systemPrompt.section({
      name: 'qqbot-voice:speech',
      order: 9400,
      interpolate: false,
      text: settings.promptText || DEFAULT_PROMPT,
    }), 'qqbot-voice: prompt section')
  })

  // ── 卸载 ──
  ctx.effect(() => () => {
    clearTimeout(warnTimer)
    for (const state of bots.values()) {
      try {
        state.dispose()
      } catch {
        /* ignore */
      }
    }
    bots.clear()
  }, 'qqbot-voice: lifecycle')
}

export { mergeConfig, DEFAULT_PROMPT, peerKey }
