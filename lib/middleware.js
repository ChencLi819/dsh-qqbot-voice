// 入站这一层:① 先认指令(/语音、/通话、/挂断)② 再给语音消息做转写
// ③ 在语音模式/通话里给消息加一句「怎么回」的提示。
//
// 转写结果写进 ctx.state.processedAttachments —— 这是 dsh-qqbot 留给扩展的
// 口子(inbound.ts 里读 state.processedAttachments,形如
// { type: 'voice', voiceText, voiceSource }),写进去之后 agent 看到的就是
// [Voice message] 文字,而不是一个它读不懂的音频链接。
import { isVoiceAttachment } from './audio.js'
import { peerKey } from './store.js'

const CMD_RE = /^[\/／](语音|语音通话|通话|挂断|打电话)\s*(.*)$/

function normAction(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return 'status'
  if (/^(开|开启|打开|开始|on|start|yes|要|来|打)$/.test(text)) return 'on'
  if (/^(关|关闭|取消|off|stop|no|挂断|结束|不打了)$/.test(text)) return 'off'
  if (/^(状态|status|\?|？)$/.test(text)) return 'status'
  if (/^(通话|打电话|语音通话|call)$/.test(text)) return 'call'
  if (/^(语音|voice)$/.test(text)) return 'voice'
  return 'unknown'
}

export function createInbound({ appId, settings, logger, stt, call, speaker, onVoiceProbe, onInbound }) {
  const log = (level, message) => logger?.[level]?.(`[qqbot-voice] ${message}`)

  async function handleCommand(ctx) {
    const content = String(ctx.message?.content ?? '').trim()
    const match = CMD_RE.exec(content)
    if (!match) return false
    const [, verb, rest] = match
    const bare = !String(rest ?? '').trim()
    let action = bare ? '' : normAction(rest)
    // 不带参数的动词本身就有含义:/通话 = 开始通话,/挂断 = 挂断,/语音 = 看状态
    if (bare) {
      if (verb === '通话' || verb === '语音通话' || verb === '打电话') action = 'call'
      else if (verb === '挂断') action = 'off'
      else action = 'status'
    } else if (action === 'on' && (verb === '通话' || verb === '语音通话' || verb === '打电话')) {
      action = 'call'
    }
    const scope = ctx.message.kind === 'group' ? 'group' : 'c2c'
    const peerId = scope === 'group' ? (ctx.message.groupOpenid ?? ctx.message.senderId) : ctx.message.senderId
    const target = ctx.replyTarget
    const key = peerKey(appId, scope, peerId)
    const current = call.modeOf(appId, scope, peerId)

    const say = async (text) => {
      try {
        await ctx.bot.sendMarkdown(target, text)
      } catch (error) {
        log('warn', `指令回执发送失败:${error?.message ?? error}`)
      }
    }

    const startCall = async () => {
      const { changed } = call.setMode({ appId, scope, peerId, mode: 'call', target })
      await say(
        changed
          ? '📞 语音通话开始——你直接发语音就行，我会用语音回你。静默太久我会自己挂断，想挂就说「挂断」。'
          : '已经在通话里了，说吧。',
      )
      if (changed && settings.call.announce) await speaker.say(settings.call.greetText, target)
    }
    const endCall = async () => {
      const wasOn = current !== 'off'
      call.setMode({ appId, scope, peerId, mode: 'off', target })
      await say(wasOn ? '📴 挂了。' : '本来就没在通话。')
      if (wasOn && settings.call.announce) await speaker.say(settings.call.byeText, target)
    }

    switch (action) {
      case 'on':
      case 'voice': {
        if (!settings.enabled) return await say('语音插件现在是关的。'), true
        call.setMode({ appId, scope, peerId, mode: 'voice', target })
        await say('🔊 语音回复开了：我回的每条都会再念一遍。想关就说「/语音 关」。')
        return true
      }
      case 'call':
        return await startCall(), true
      case 'off':
        return await endCall(), true
      case 'status':
      default: {
        const mode = call.modeOf(appId, scope, peerId)
        const lines = [
          mode === 'call' ? '📞 通话中' : mode === 'voice' ? '🔊 语音回复开着' : '🔇 语音回复关着',
          `听：${stt.chain.length > 0 ? stt.chain.join(' → ') : '只用 QQ 自带转写'}`,
          `说：${speaker.tts.chain.length > 0 ? speaker.tts.chain.join(' → ') : '没配引擎，发不了语音'}`,
          '指令：/语音 开｜/语音 关｜/通话｜/挂断',
        ]
        await say(lines.join('\n'))
        return true
      }
    }
  }

  return async function inbound(ctx, next) {
    // 「我还在链上」的活证据:每条进来的消息都记一笔(diagnostic.json 的 lastInbound)。
    // 插件哑掉时第一件事就是看这个时间戳有没有在动。
    try {
      const scope0 = ctx.message?.kind === 'group' ? 'group' : 'c2c'
      onInbound?.({
        at: new Date().toISOString(),
        kind: ctx.message?.kind,
        scope: scope0,
        peerId: scope0 === 'group' ? (ctx.message?.groupOpenid ?? ctx.message?.senderId) : ctx.message?.senderId,
        attachments: Array.isArray(ctx.message?.attachments) ? ctx.message.attachments.length : 0,
        preview: String(ctx.message?.content ?? '').slice(0, 60),
      })
    } catch {
      /* 探针失败不影响主流程 */
    }
    try {
      const handled = await handleCommand(ctx)
      if (handled) {
        ctx.stop('qqbot-voice:command')
        return
      }
    } catch (error) {
      log('warn', `指令处理出错:${error?.message ?? error}`)
    }

    try {
      const attachments = Array.isArray(ctx.message?.attachments) ? ctx.message.attachments : []
      const voices = attachments.filter(isVoiceAttachment)
      if (voices.length > 0) {
        // 留一份「QQ 到底给了什么字段」的证据(diagnostic.json),排查时不用猜
        try {
          onVoiceProbe?.(voices.map((att) => ({
            keys: Object.keys(att ?? {}),
            contentType: att?.content_type,
            hasWavUrl: Boolean(att?.voice_wav_url),
            hasAsrText: Boolean(att?.asr_refer_text),
            filename: att?.filename,
          })))
        } catch {
          /* 探针失败不影响主流程 */
        }
      }
      if (voices.length > 0 && settings.stt.engine !== 'off') {
        const processed = []
        for (const att of voices) {
          const result = await stt.transcribe(att)
          if (result?.text) {
            processed.push({ type: 'voice', voiceText: result.text, voiceSource: result.source })
            log('info', `语音转写(${result.source}${result.via ? `/${result.via}` : ''}):${result.text.slice(0, 60)}`)
          }
        }
        if (processed.length > 0) ctx.state.processedAttachments = processed
      }
    } catch (error) {
      log('warn', `语音转写出错:${error?.message ?? error}`)
    }

    try {
      // 通话/语音模式下给模型一句提示:回复会被念出来
      const scope = ctx.message?.kind === 'group' ? 'group' : 'c2c'
      const peerId = scope === 'group' ? (ctx.message.groupOpenid ?? ctx.message.senderId) : ctx.message.senderId
      const mode = call.modeOf(appId, scope, peerId)
      if (mode !== 'off') {
        const hint = mode === 'call'
          ? '[语音通话中：像打电话一样回我，一两句口语，别用列表/Markdown/链接；想挂断就说挂了]'
          : '[语音模式：你的回复会被念出来，尽量口语、短句]'
        ctx.message.content = `${hint}\n${ctx.message.content ?? ''}`.trim()
      }
    } catch (error) {
      log('warn', `语音提示注入失败:${error?.message ?? error}`)
    }

    await next()
  }
}
