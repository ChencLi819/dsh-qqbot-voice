# dsh-qqbot-voice —— 给 QQ 机器人装上耳朵和嘴

给 DSH 的 QQ 机器人（[`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)）加语音能力：

| 能力 | 说明 |
| --- | --- |
| **听**（ASR） | 群里/私聊有人发语音，自动转成文字进 agent 上下文——模型看到的是 `[Voice message] 帮我记一下三点买米`，而不是一个读不懂的音频链接 |
| **说**（TTS） | 能把回复念成语音发出去；也可以被要求「用语音说一句」 |
| **语音通话**（对讲） | 通话期间：你发语音 → 机器人听 → 机器人回语音。静默太久自动挂断 |

## 先说清楚：为什么「通话」是对讲机式的

QQ 官方机器人 API **没有实时语音通话（RTC）** 能力——开放平台的服务端接口里只有
消息收发 / 富媒体上传 / 流式消息 / 互动回调，没有任何拨号、SDP、音频流接口，
SDK（`@tencent-connect/qqbot-nodejs`）里也没有。所以机器人没法真的「打电话」。

这个插件做的是**对讲机式语音通话**：一段一段的语音消息，配上自动转写和自动语音回复，
体感上接近「打电话」，但每一句都是独立的一条 QQ 语音消息。文字回复仍然照发，当字幕用。

## 安装

### 方式一：一条命令装进 profile

```bash
# 从 GitHub 源码安装
dsh plugin --profile web add github:ChencLi819/dsh-qqbot-voice

# Desktop 版把 profile 换成 desktop
dsh plugin --profile desktop add github:ChencLi819/dsh-qqbot-voice
```

> ⚠️ 这个插件**还需要给 `dsh-qqbot` 打一个补丁**才能拿到机器人实例（原因见下）。
> 用 CLI 装完之后，补打一步：

```powershell
node tools/install.mjs        # 幂等：会补 pnpm link、bundles 和 dsh-qqbot 补丁
# 或者只打补丁：
node tools/patch-dsh-qqbot-voice-hook.mjs
```

装完**重启 DSH**（补丁改的是插件模块，热重载不一定重新导入）。

### 方式二：用插件自带的安装脚本（一步到位）

```powershell
node tools/install.mjs
```

它会做三件事：

1. `pnpm add link:<本包目录>`（软链，改代码即改插件）；
2. 往 profile 的 `dsh.profile.bundles` 里加上 `dsh-qqbot-voice`；
3. 给 `dsh-qqbot` 打一个**机器人注册表**补丁（`qqbot-bots` 服务）。

```powershell
node tools/install.mjs --check                    # 看装没装、补丁打没打
node tools/install.mjs --profile-dir <path>       # 指定 profile（默认 ~/.dsh/profiles/desktop）
```

**第 3 步为什么需要**：`dsh-qqbot` 把 `QQBot` 实例关在 `bootstrap` 里，外面拿不到，
而语音插件必须摸到它才能 ① 挂入站中间件（`bot.use`）② 发语音（`mediaSender.sendVoice`）。
补丁只是把 `{appId, bot, manager, mediaSender, config, logger}` 注册成一个 Cordis 服务，
**不改任何原有逻辑**；`pnpm` 更新 dsh-qqbot 后补丁会被整包覆盖，重跑一次 install 即可。

装完**重启 DSH**（补丁改的是插件模块，热重载不一定重新导入）。日志里看到这行就对了：

```
[qqbot-voice] 听:dashscope → qq · 说:dashscope · 状态:~/.dsh/qqbot-voice/state.json
```

### 怎么确认真的挂上了

桌面版看不到 stdout，所以插件会写两个文件：

- `~/.dsh/qqbot-voice/diagnostic.json` —— 插件起没起来、听/说各用什么引擎、
  挂到了哪个机器人、最近一条语音附件里 QQ 给了什么字段（排查「为什么没转写」看这里）；
- `~/.dsh/qqbot-voice/state.json` —— 谁开着语音回复 / 谁在通话。

正常的 `diagnostic.json` 长这样：

```json
{
  "version": "0.1.0+7",
  "stt": ["dashscope", "qq"],
  "tts": ["dashscope"],
  "qqbotBotsService": true,
  "bots": [{ "appId": "<你的机器人 appId>", "attachedAt": "..." }]
}
```

`qqbotBotsService: false` 或 `bots` 是空的 = 补丁没打上 / 没重启，重跑一次 install。

## 用法

群里 @ 机器人发语音就行。指令（私聊直接发，群里 @ 之后发）：

| 指令 | 作用 |
| --- | --- |
| `/语音` | 看状态（听/说各用什么引擎、当前模式） |
| `/语音 开` / `/语音 关` | 语音回复模式：回复照发文字，另外再念一条语音 |
| `/通话` | 开始语音通话（对讲）：机器人回语音、你发语音，静默 `maxIdleMinutes` 分钟自动挂断 |
| `/挂断` | 挂断 |

模型侧还有两个工具（模型也能自己用）：

- `qqbot_say(text)` —— 说一句话（发语音）
- `qqbot_voice_call(action)` —— `start` / `end` / `voice` / `off` / `status`

## 引擎：听谁、说谁

都做成**可替换的引擎链**，默认 `auto`（谁先能用谁上），配置里改。

### 听（ASR）

| engine | 说明 |
| --- | --- |
| `dashscope`（默认） | 阿里云百炼 `qwen3-asr-flash`，多模态原生接口。key 从环境变量 `DASHSCOPE_API_KEY` 或 `~/.dsh/.credentials.yaml` 里同名条目取 |
| `http` | OpenAI 兼容的 `POST {baseURL}/audio/transcriptions`（whisper 之类） |
| `command` | 本地命令模板，`{audio}` 换成音频路径、stdout 当结果（自己装了 whisper.cpp 就用这个） |
| `qq` | QQ 平台自带的转写（`asr_refer_text`），免费但有时没有 |

`stt.preferQq: true` 可以让平台自带转写优先，省掉外部调用。

### 说（TTS）

| engine | 说明 |
| --- | --- |
| `dashscope`（默认） | `qwen3-tts-flash`，音色 `Cherry` / `Serena` / `Ethan` / `Chelsie` |
| `http` | OpenAI 兼容的 `POST {baseURL}/audio/speech` |
| `command` | 本地命令模板：`{text}` 文本、`{out}` 输出文件、`{voice}` 音色。自己 `pip install edge-tts` 的话填 `edge-tts --voice {voice} --text {text} --write-media {out}` 就能用免费音色 |

> 为什么内置不带 Edge 朗读接口：它要一个反爬的 `Sec-MS-GEC v2` token（自定义哈希），
> 拿老算法一律 403——与其塞一段随时会坏的逆向代码，不如留 `command` 口子。

## 实现要点（踩过的坑）

**语音附件**：QQ 给的字段通常是 `[asr_refer_text, content_type, filename, size, url, voice_wav_url]`——
**有 `voice_wav_url` 就直接用**，不用解 silk；只有 silk 且平台没给 wav 时，插件才用 `silk-wasm` 自己解码（纯 WASM，不用编译）。
两条路都走不通才退回 QQ 自带转写。

**0.1.0+6：`sendVoice` 的参数形状**
一开始给 `mediaSender.sendVoice(target, 文件路径)` 传了裸字符串，而 SDK 要的是 `{ localPath }`——
在 `normalizeSource` 里直接抛 `Cannot use 'in' operator`，错误被 try/catch 吞成日志，
用户那边表现成「通话/语音模式只回文字」，一点线索都没有。现在：① 参数改成 `{ localPath }`；
② 日志落盘 `~/.dsh/qqbot-voice/voice.log`；③ 自测的假发送器照着真 SDK 的脾气来，传裸路径就炸，回归用例盯住这个形状。

**0.1.0+7：热重载后中间件挂在死实例上**
插件热重载时 `dsh-qqbot` 会**新建一个 QQBot 实例**，注册表里的 entry 跟着换。
原来的 `attachBot` 用 `bots.has(appId)` 去重——一看 appId 有了就直接 return，中间件留在**已经死掉的旧实例**上。
症状极像「插件没装」：`diagnostic.json` 里机器人挂得好好的，但转写、指令、语音回复**全哑**，连日志都不写一行。现在：
① 按**实例身份**去重，实例换了就把中间件摘下来重新挂到新实例；
② 每 60 秒对一次账（watchdog），实例换了、或者中间件被人从链上摘了，都会自动修回来；
③ `session/event` 监听改成 apply 级只注册一次（以前每重挂一次就多一个，会重复念）；
④ `diagnostic.json` 多一个 `lastInbound` 字段——「中间件还在不在链上」看它时间戳动不动就知道。

**双份转写**：`- ASR: …`（QQ 自带）和 `[Voice message] …`（插件转写）会同时出现在上下文里。
两条一起看反而更容易认出人名（QQ 那条有时比外部 ASR 更准）。嫌啰嗦就把 `stt.preferQq` 打开，只留 QQ 那条。

## 配置

默认值都在 `lib/config.js` 的 `DEFAULTS`，想改就在 profile 的 `cordis.patch.yml` 里补一行（深合并）：

```yaml
- id: qqbot-voice
  config:
    tts:
      voice: Serena
    call:
      maxIdleMinutes: 5
      greetText: 喂，在呢，说吧
    stt:
      preferQq: true
```

常用项：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `stt.engine` / `tts.engine` | `auto` | 也可以写死 `dashscope` / `http` / `command` / `qq` / `off` |
| `stt.dashscope.apiKeyEnv` | `DASHSCOPE_API_KEY` | 取 key 的环境变量名（也会去 `~/.dsh/.credentials.yaml` 找同名条目） |
| `stt.timeoutMs` | `30000` | 转写超时，超了就退回 QQ 自带转写 |
| `tts.maxChars` | `180` | 一条语音最多念多少字（超了按句子截断） |
| `call.maxIdleMinutes` | `8` | 静默多久自动挂断 |
| `call.announce` | `true` | 开始/挂断时说一句 |
| `voiceReply.minChars` | `2` | 太短的回复（「嗯」）就不念了 |
| `stateDir` | `~/.dsh/qqbot-voice` | 状态/诊断/日志落盘处 |

key 的解析顺序：`config.apiKey` → 环境变量（`apiKeyEnv`）→ `~/.dsh/.credentials.yaml` 里的同名条目。

## 自测

```powershell
node tools/fake-host.mjs                 # 假宿主:把听/说/通话三条链路真跑一遍(含真 ASR/TTS)
node tools/fake-host.mjs --no-network    # 只跑接线,不联网
node tools/probe-roundtrip.mjs           # 说→听 闭环(验证 key 和两个引擎)
node tools/make-voice.mjs "试一句"        # 单独试「说」:合成一条语音到本地(不碰 QQ)
node tools/probe-asr.mjs [wav]           # 挨个试手头的 ASR 通道
node tools/probe-voice.mjs               # 挨个试 TTS / ASR 通道
node tools/check-live.mjs                # 把语音链路的现场证据打出来(只读)
node tools/install.mjs --check           # 看装没装、补丁打没打
```

在 QQ 里的验证清单（建议按顺序）：

1. 私聊发一条语音 → 机器人应该能听懂并回答（这就是「听」）；
2. `/语音 开` → 之后每条回复都会多一条语音（这就是「说」）；
3. `/通话` → 进入对讲模式：发语音、机器人回语音；说 `/挂断` 结束，或者放着不管，静默 8 分钟自动挂断；
4. 说「打个电话给我」→ 模型应该自己调 `qqbot_voice_call(start)`（这就是「通话」的模型侧入口）。

## 已知限制

- **没有真·实时通话**（见上），对讲模式而已。
- 一条语音最长 60 秒左右（QQ 平台限制），长文本会被截断/分段。
- 群里**主动**发消息（比如静默挂断时那句「先挂了」）需要群主给机器人开「机器人主动在群聊内发言」；
  没开的话只会在日志里报一句失败，不影响被动回复。
- 转写会把语音内容发到外部 ASR 服务（默认阿里云百炼）；不想外发就换 `command` 引擎跑本地模型。
- 需要给 `dsh-qqbot` 打补丁才能拿到机器人实例——**这是本插件最大的耦合点**，官方插件更新后要重跑 install。

## 结构

```
index.js              插件入口:接线(机器人注册表 / 工具 / 提示词)
lib/config.js         默认值、深合并、key 解析(env → ~/.dsh/.credentials.yaml)
lib/store.js          「谁在通话」的状态,落 ~/.dsh/qqbot-voice/state.json
lib/audio.js          语音附件下载、silk→wav、落盘
lib/stt.js            听的引擎链
lib/tts.js            说的引擎链 + 文本清洗(去 markdown/链接/emoji)+ 发送
lib/middleware.js     入站:指令截获 / 转写 / 模式提示
lib/call.js           模式状态机 + 出站把回复念出来
lib/session-log.js    往会话日志里留一行(排查用)
tools/                install / patch / 探针 / 假宿主自测 / make-voice
```

## English

**dsh-qqbot-voice — give your QQ bot ears and a mouth.**

A [DeepSeek Harness](https://deepseek.com/harness/) plugin for [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot):

- **Listen** — inbound voice messages are transcribed into the agent context as `[Voice message] …`;
- **Speak** — replies can be spoken as QQ voice messages, on demand or automatically;
- **Voice call (walkie-talkie)** — you send voice, it answers with voice; auto-hangs up after a silent period.

The official QQ bot API has no real-time (RTC) audio, so "call" is a walkie-talkie style exchange of voice messages,
with the text reply kept as subtitles. Pluggable ASR/TTS engine chains (`dashscope` / `http` / `command` / `qq`).

```bash
dsh plugin --profile web add github:ChencLi819/dsh-qqbot-voice   # install
node tools/install.mjs                                           # then patch dsh-qqbot's bot registry
```

The patch exposes the `QQBot` instance (which `dsh-qqbot` keeps private) as a Cordis service, without changing any
existing behaviour. Requires a `DASHSCOPE_API_KEY` (or any OpenAI-compatible endpoint) for the default engines. MIT licensed.

## License

MIT
