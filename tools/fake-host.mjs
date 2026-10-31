// 假宿主自测:不装插件、不重启 DSH,直接给 apply() 一个最小 ctx,
// 把「听 / 说 / 通话」三条链路真跑一遍(含真·ASR/TTS 网络调用)。
//
// 用法:node qqbot-voice/tools/fake-host.mjs [--no-network]
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const noNetwork = process.argv.includes('--no-network')
const stateDir = mkdtempSync(join(tmpdir(), 'qqbot-voice-state-'))
const audioDir = mkdtempSync(join(tmpdir(), 'qqbot-voice-audio-'))
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/** 有没有可用的 TTS 引擎(读插件落的 diagnostic.json)——没配 key 时相关用例跳过而不是报红 */
const ttsChain = () => {
  try { return JSON.parse(readFileSync(join(stateDir, 'diagnostic.json'), 'utf8')).tts ?? [] } catch { return [] }
}
const noTts = () => ttsChain().length === 0
const skipTts = (why) => console.log(`(跳过:${why})`)

// ── 假 ctx / 假机器人 ──
const registered = new Map()
const sections = []
const effects = []
const middlewares = []
const sentVoices = []
const sentTexts = []
const logs = []
const records = new Map()

const fakeTools = {
  register(def) {
    if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
    registered.set(def.name, def)
    return () => registered.delete(def.name)
  },
  get: () => undefined,
}

// 假机器人:照着真 QQBot 的脾气 —— middlewares 是个能看能改的数组,
// use() 返回 this(不给卸载函数),getMiddlewares() 能拿到链子。
const makeFakeBot = (appId = 'app-1') => {
  const bot = {
    appId,
    middlewares: [],
    getMiddlewares() { return this.middlewares },
    use(...mws) {
      for (const mw of mws) { this.middlewares.push(mw); middlewares.push(mw) }
      return bot
    },
    sendMarkdown: async (target, content) => { sentTexts.push({ target, content }); return {} },
  }
  return bot
}

const fakeBot = makeFakeBot()

const fakeManager = {
  findBySessionId: (id) => records.get(id) ?? undefined,
}

const fakeMediaSender = {
  // 照着真 SDK 的脾气来:第二个参数必须是 { localPath }(或 {url}/{buffer}),
  // 传裸路径会在 normalizeSource 里炸 —— 0.1.0+5 就是这么静悄悄只回文字的。
  sendVoice: async (target, source) => {
    if (typeof source === 'string') {
      throw new Error("sendVoice 第二个参数必须是 { localPath },裸路径会炸(Cannot use 'in' operator)")
    }
    const file = source?.localPath
    if (!file || !existsSync(file)) throw new Error(`语音文件不存在:${file}`)
    sentVoices.push({ target, file, size: statSync(file).size })
    return { upload: { file_uuid: 'x' }, message: { id: 'm1' } }
  },
}

const registry = {
  list: new Map(),
  listeners: new Set(),
  onBot(listener) {
    this.listeners.add(listener)
    for (const entry of this.list.values()) listener(entry)
    return () => this.listeners.delete(listener)
  },
  register(entry) {
    this.list.set(entry.appId, entry)
    for (const listener of this.listeners) listener(entry)
  },
}

const scopeFor = (deps) => ({
  get: (name) => deps[name],
  ...Object.fromEntries(Object.entries(deps)),
  effect: (fn) => { const disposer = fn(); effects.push(typeof disposer === 'function' ? disposer : () => {}) },
  systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
  tools: fakeTools,
})

const ctx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => { logs.push(['error', m]); console.log('  [logger.error]', m) },
  },
  get: (name) => (name === 'qqbot-bots' ? registry : name === 'tools' ? fakeTools : undefined),
  inject: (deps, callback) => callback(scopeFor(Object.fromEntries(deps.map((d) => [d, d === 'qqbot-bots' ? registry : d === 'tools' ? fakeTools : d === 'systemPrompt' ? { section: () => () => {} } : undefined])))),
  effect: (fn) => { const disposer = fn(); effects.push(typeof disposer === 'function' ? disposer : () => {}) },
  on: () => {},
}

// 语音模式下的出站事件要能被 call.js 收到:这里手动转交
const sessionListeners = []
ctx.on = (name, handler) => { if (name === 'session/event') sessionListeners.push(handler) }

apply(ctx, { stateDir, audioDir })

// ── 1. 挂载 ──
console.log('== 挂载 ==')
registry.register({ appId: 'app-1', bot: fakeBot, manager: fakeManager, mediaSender: fakeMediaSender, config: {}, logger: ctx.logger })
check('入站中间件已挂上', middlewares.length === 1)
check('session/event 监听已注册', sessionListeners.length === 1)
check('提示词段已注入', sections.length === 1 && sections[0].name === 'qqbot-voice:speech', sections[0]?.text?.slice(0, 18))
check('工具已注册', registered.has('qqbot_say') && registered.has('qqbot_voice_call'), [...registered.keys()].join(','))
check('启动日志说明了引擎链', logs.some(([, m]) => m.includes('听:') && m.includes('说:')), logs.find(([, m]) => m.includes('听:'))?.[1])

const runTool = async (name, args, sessionId) => {
  const def = registered.get(name)
  const value = await def.execute(args, { agent: { id: sessionId, session: { id: sessionId } } })
  return { value, text: def.output.render(args, value).map((b) => b.text).join('\n') }
}

// ── 2. 听:入站语音转文字 ──
console.log('\n== 听(ASR)==')
const makeInboundCtx = ({ attachments, content = '', kind = 'c2c', senderId = 'U-1', msgId = 'msg-1' }) => {
  const state = {}
  let stopped = false
  return {
    message: { content, kind, senderId, messageId: msgId, groupOpenid: kind === 'group' ? 'G-1' : undefined, attachments },
    state,
    replyTarget: { scope: kind, targetId: kind === 'group' ? 'G-1' : 'U-1', msgId },
    bot: fakeBot,
    log: ctx.logger,
    stop: () => { stopped = true },
    get stopped() { return stopped },
  }
}

// 2a. QQ 自带转写(不联网)
{
  const mwCtx = makeInboundCtx({ attachments: [{ content_type: 'voice', url: 'https://example.com/a.silk', asr_refer_text: '喂，听得到吗' }] })
  await middlewares[0](mwCtx, async () => {})
  const processed = mwCtx.state.processedAttachments
  check('QQ 自带转写被用上', processed?.[0]?.voiceText === '喂，听得到吗', JSON.stringify(processed))
}

// 2b. 真·外部 ASR(用公开的中文测试音频当 voice_wav_url)
if (!noNetwork) {
  const sample = 'https://isv-data.oss-cn-hangzhou.aliyuncs.com/ics/MaaS/ASR/test_audio/asr_example_zh.wav'
  const mwCtx = makeInboundCtx({ attachments: [{ content_type: 'voice', url: 'https://example.com/real-asr.silk', voice_wav_url: sample }] })
  await middlewares[0](mwCtx, async () => {})
  const text = mwCtx.state.processedAttachments?.[0]?.voiceText ?? ''
  check('外部 ASR 转出了文字', text.length > 5, `「${text}」(${mwCtx.state.processedAttachments?.[0]?.voiceSource})`)
  check('转写结果进了 processedAttachments(agent 看得到)', Boolean(mwCtx.state.processedAttachments))
} else {
  console.log('(跳过:--no-network)')
}

// ── 3. 说:qqbot_say ──
console.log('\n== 说(TTS)==')
records.set('sess-1', { scope: 'c2c', peerId: 'U-1', senderId: 'U-1', replyTarget: { scope: 'c2c', targetId: 'U-1', msgId: 'msg-1' } })
if (!noNetwork && !noTts()) {
  const said = await runTool('qqbot_say', { text: '喂，这条是语音回的。' }, 'sess-1')
  check('qqbot_say 发出去了一条语音', sentVoices.length === 1, said.text.slice(0, 60))
  check('语音文件落在 audioDir', sentVoices[0]?.file?.startsWith(audioDir), sentVoices[0]?.file)
  check('语音文件不是空的', (sentVoices[0]?.size ?? 0) > 2000, `${sentVoices[0]?.size} bytes`)
} else {
  skipTts(noNetwork ? '--no-network' : '没有可用的 TTS 引擎 —— 配好 key(如 DASHSCOPE_API_KEY)再跑这一项')
}

// ── 4. 通话:指令 + 出站念回复 ──
console.log('\n== 通话(对讲)==')
{
  const cmdCtx = makeInboundCtx({ content: '/通话', attachments: [] })
  await middlewares[0](cmdCtx, async () => { throw new Error('指令应该短路,不该继续往下走') })
  check('指令被截获并短路', cmdCtx.stopped === true)
  check('回了文字回执', sentTexts.some((t) => t.content.includes('语音通话开始')), sentTexts.at(-1)?.content?.slice(0, 40))

  const stateFile = join(stateDir, 'state.json')
  check('状态落盘', existsSync(stateFile))
  const { createStore } = await import('../lib/store.js')
  const store = createStore(stateDir)
  check('这个会话记成 call 模式', store.mode('app-1:c2c:U-1') === 'call', store.mode('app-1:c2c:U-1'))

  // 出站:助手说了一句 → 轮末应该转成语音
  // (换一个 sessionId:qqbot_say 会把「本轮已经说过话」标在 session 上,别撞车)
  records.set('sess-call', { scope: 'c2c', peerId: 'U-1', senderId: 'U-1', replyTarget: { scope: 'c2c', targetId: 'U-1', msgId: 'msg-1' } })
  const before = sentVoices.length
  for (const listener of sessionListeners) {
    listener({ header: { id: 'sess-call' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在呢，你说。' }] } } })
    listener({ header: { id: 'sess-call' } }, { type: 'turn/end', data: { reason: { kind: 'done' } } })
  }
  await new Promise((r) => setTimeout(r, noNetwork ? 50 : 3000))
  if (noTts()) {
    skipTts('没有可用的 TTS 引擎 —— 配好 key(如 DASHSCOPE_API_KEY)再跑这一项')
  } else {
    check('通话中回复被念成语音', sentVoices.length === before + 1, `语音数 ${before} → ${sentVoices.length}${sentVoices.length === before ? ' · ' + logs.filter(([l]) => l === 'warn').slice(-2).map(([, m]) => m).join(' | ') : ''}`)
  }

  // 挂断
  const endCtx = makeInboundCtx({ content: '/挂断', attachments: [] })
  await middlewares[0](endCtx, async () => {})
  check('挂断后状态清掉', createStore(stateDir).mode('app-1:c2c:U-1') === 'off')
  check('挂断有回执', sentTexts.some((t) => t.content.includes('挂了')))

  // 语音模式:只开 voice
  const voiceCtx = makeInboundCtx({ content: '/语音 开', attachments: [] })
  await middlewares[0](voiceCtx, async () => {})
  check('语音模式记成 voice', createStore(stateDir).mode('app-1:c2c:U-1') === 'voice')

  // 通话中给消息加了提示
  const hintCtx = makeInboundCtx({ content: '在吗', attachments: [] })
  await middlewares[0](hintCtx, async () => {})
  check('语音模式下注入了提示', hintCtx.message.content.includes('[语音模式'), hintCtx.message.content.slice(0, 40))
}

// ── 5. silk 兜底:QQ 没给 wav 时的解码路径 ──
console.log('\n== silk → wav(兜底)==')
{
  const { silkToWav, pcmToWav } = await import('../lib/audio.js')
  let silk = null
  try {
    silk = await import('silk-wasm')
  } catch {
    silk = null
  }
  if (!silk) {
    console.log('(跳过:silk-wasm 没装 —— 平台不给 voice_wav_url 时就解不了 silk)')
  } else {
    const sr = 24_000
    const pcm = Buffer.alloc(sr * 2)
    for (let i = 0; i < sr; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 8000), i * 2)
    const { data } = await silk.encode(pcm, sr)
    const silkBuf = Buffer.from(data)
    const wav = await silkToWav(silkBuf, sr)
    check('silk → wav 解出来了', wav.subarray(0, 4).toString() === 'RIFF' && wav.length > 2048, `${silkBuf.length} → ${wav.length} bytes`)
    check('pcm 套的 wav 头正确', pcmToWav(pcm, sr).readUInt32LE(24) === sr)
  }
}

// ── 6. 工具:qqbot_voice_call ──
console.log('\n== qqbot_voice_call ==')
{
  const status = await runTool('qqbot_voice_call', { action: 'status' }, 'sess-1')
  check('status 能看到当前模式', status.text.includes('当前:'), status.text.slice(0, 50))
  const end = await runTool('qqbot_voice_call', { action: 'end' }, 'sess-1')
  check('end 关掉语音模式', end.text.includes('挂了') || end.text.includes('关了') || end.text.includes('本来就没'), end.text.slice(0, 40))
  const notQq = await runTool('qqbot_voice_call', { action: 'status' }, 'sess-web')
  check('非 QQ 会话如实拒绝', notQq.text.includes('不是 QQ 会话'), notQq.text.slice(0, 40))
}

// ── 7. 机器人实例被换掉(插件热重载就是这么换的)—— 中间件必须跟过去 ──
// 这就是「插件看着好好的,语音功能全哑」的元凶:旧实例上的中间件收不到消息了。
console.log('\n== 机器人实例换了(热重载)==')
{
  const bot2 = makeFakeBot()
  registry.register({ appId: 'app-1', bot: bot2, manager: fakeManager, mediaSender: fakeMediaSender, config: {}, logger: ctx.logger })
  check('中间件跟到了新实例上', bot2.getMiddlewares().length === 1, `链长 ${bot2.getMiddlewares().length}`)
  check('旧实例的中间件被摘掉', fakeBot.getMiddlewares().length === 0, `旧链长 ${fakeBot.getMiddlewares().length}`)
  const mwCtx = makeInboundCtx({ attachments: [{ content_type: 'voice', asr_refer_text: '喂，还在吗' }] })
  await bot2.getMiddlewares()[0](mwCtx, async () => {})
  check('新实例上真能干活', mwCtx.state.processedAttachments?.[0]?.voiceText === '喂，还在吗', JSON.stringify(mwCtx.state.processedAttachments))
  // 再注册一次同一个实例:不应该重复挂(否则会重复念)
  registry.register({ appId: 'app-1', bot: bot2, manager: fakeManager, mediaSender: fakeMediaSender, config: {}, logger: ctx.logger })
  check('同一个实例不会重复挂', bot2.getMiddlewares().length === 1, `链长 ${bot2.getMiddlewares().length}`)
}

// ── 清理 ──
for (const effect of effects) { try { effect() } catch { /* disposer */ } }
rmSync(stateDir, { recursive: true, force: true })
rmSync(audioDir, { recursive: true, force: true })

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
