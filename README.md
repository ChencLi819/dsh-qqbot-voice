# dsh-qqbot-voice

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.3.0-brightgreen.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-5b6cff.svg)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）插件，为 [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)
提供语音能力：入站语音消息自动转写并注入 agent 上下文，助手回复可合成为语音消息发送，
并提供对讲模式的连续语音交互。

---

## 目录

- [1. 功能](#1-功能)
- [2. 兼容性与依赖](#2-兼容性与依赖)
- [3. 安装](#3-安装)
- [4. 使用](#4-使用)
- [5. 引擎](#5-引擎)
- [6. 配置](#6-配置)
- [7. 工作原理](#7-工作原理)
- [8. 运行状态与故障排查](#8-运行状态与故障排查)
- [9. 安全与隐私](#9-安全与隐私)
- [10. 已知限制](#10-已知限制)
- [11. 开发](#11-开发)
- [12. 许可证](#12-许可证)
- [English Overview](#english-overview)

---

## 1. 功能

| 能力 | 说明 |
| --- | --- |
| 语音转写（ASR） | 入站语音消息转写为文本并注入 agent 上下文，格式为 `[Voice message] <文本>` |
| 语音合成（TTS） | 将回复合成为 QQ 语音消息；支持按指令或按模式自动执行 |
| 语音通话（对讲） | 通话期间双方以语音消息往返；静默超时自动挂断；文本回复同时保留 |
| 引擎可替换 | ASR 与 TTS 均为可配置的引擎链，支持云端接口与本地命令 |
| 运行时可观测 | 落盘诊断文件，记录引擎链、机器人实例与最近入站事件 |

---

## 2. 兼容性与依赖

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| DSH | 与 `dsh-qqbot` 声明的兼容范围一致：`0.1.0-rc.8`（CLI）、`0.2.0-rc.2`（Desktop） | 插件依赖 `dsh-qqbot` 的内部模块结构，故兼容范围随其声明 |
| Node.js | `>= 20.3.0` | 使用内置 `fetch`、`node:zlib` 等 |
| `@tencent-connect/dsh-qqbot` | `>= 0.5.0` | 必需；插件通过补丁获取其 QQBot 实例 |
| ASR / TTS 服务 | 默认阿里云百炼 | 需配置 `DASHSCOPE_API_KEY`；亦可使用任意 OpenAI 兼容端点或本地命令 |
| `silk-wasm` | 可选 | 用于解码平台未提供 WAV 的 SILK 语音附件 |

> **平台能力说明**：QQ 官方机器人 API 不提供实时语音通话（RTC）能力，
> 开放平台未提供拨号、SDP 或音频流接口。因此本插件的「通话」为基于语音消息的
> 对讲模式，每次交互为一条独立的语音消息。

---

## 3. 安装

### 3.1 通过 DSH CLI 安装

```bash
dsh plugin --profile web add github:ChencLi819/dsh-qqbot-voice

# Desktop 版
dsh plugin --profile desktop add github:ChencLi819/dsh-qqbot-voice
```

本插件需通过补丁获取 `dsh-qqbot` 的机器人实例，安装后需执行补丁步骤：

```powershell
node tools/install.mjs                            # 幂等：补全依赖、bundle 与补丁
node tools/patch-dsh-qqbot-voice-hook.mjs         # 或仅执行补丁
```

完成后重启 DSH。

### 3.2 通过仓库脚本安装

```powershell
node tools/install.mjs
```

脚本为幂等操作，依次执行：

1. `pnpm add link:<包目录>`，以软链方式装入 profile；
2. 在 profile 的 `dsh.profile.bundles` 中登记 `dsh-qqbot-voice`；
3. 对 `dsh-qqbot` 应用机器人注册表补丁。

```powershell
node tools/install.mjs --check                 # 检查安装与补丁状态
node tools/install.mjs --profile-dir <path>    # 指定 profile（默认 ~/.dsh/profiles/desktop）
node tools/install.mjs --no-patch              # 跳过补丁步骤
```

### 3.3 补丁说明

`dsh-qqbot` 将 `QQBot` 实例封装在 `bootstrap` 内部，插件无法直接访问，而语音功能需要：

1. 注册入站中间件（`bot.use`）；
2. 发送语音消息（`mediaSender.sendVoice`）。

补丁将 `{ appId, bot, manager, mediaSender, config, logger }` 注册为 Cordis 服务 `qqbot-bots`，
**不修改原有逻辑**。`dsh-qqbot` 升级后补丁会被覆盖，需重新执行。

---

## 4. 使用

### 4.1 指令

指令格式为 `/` 或 `／` 开头，可在私聊直接发送，或在群聊中 @ 机器人后发送。

| 指令 | 说明 |
| --- | --- |
| `/语音` | 查询当前状态（模式、ASR/TTS 引擎链） |
| `/语音 开` | 开启语音回复：文本照常发送，并额外发送一条语音 |
| `/语音 关` | 关闭语音回复 |
| `/通话` | 开始语音通话（对讲模式） |
| `/挂断` | 结束语音通话 |
| `/打电话` | 等同于 `/通话` |

指令支持自然语言参数，例如 `/语音 打开`、`/语音 关闭`、`/通话 开始`、`/通话 结束`。

### 4.2 工具

插件向模型注册 2 个工具。

#### `qqbot_say`

将文本合成为语音并发送至当前会话。仅在 QQ 会话中可用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 待合成文本，建议为口语化短句，不使用 Markdown；超出长度上限时截断 |

#### `qqbot_voice_call`

控制语音通话与语音回复模式。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | `start` 开始通话 / `end` 结束 / `voice` 开启语音回复 / `off` 全部关闭 / `status` 查询状态 |

---

## 5. 引擎

ASR 与 TTS 均为引擎链，`engine: 'auto'` 时按可用性依次选择。

### 5.1 语音转写（ASR）

| engine | 说明 |
| --- | --- |
| `dashscope`（默认） | 阿里云百炼 `qwen3-asr-flash`，多模态原生接口 |
| `http` | OpenAI 兼容接口 `POST {baseURL}/audio/transcriptions` |
| `command` | 本地命令模板，`{audio}` 替换为音频路径，取 stdout 作为结果 |
| `qq` | 平台自带转写（`asr_refer_text`），无需外部调用，可用性由平台决定 |

`stt.preferQq: true` 时优先使用平台自带转写。

### 5.2 语音合成（TTS）

| engine | 说明 |
| --- | --- |
| `dashscope`（默认） | `qwen3-tts-flash`，音色 `Cherry` / `Serena` / `Ethan` / `Chelsie` |
| `http` | OpenAI 兼容接口 `POST {baseURL}/audio/speech` |
| `command` | 本地命令模板，`{text}`、`{out}`、`{voice}` 为占位符 |

本地命令示例（edge-tts）：

```
edge-tts --voice {voice} --text {text} --write-media {out}
```

> 未内置 Edge 朗读接口：该服务要求 `Sec-MS-GEC v2` 校验参数，算法随服务端更新而变化，
> 因此以 `command` 引擎提供接入方式，避免内置实现失效。

### 5.3 凭据解析顺序

`config.apiKey` → 环境变量（由 `apiKeyEnv` 指定，默认 `DASHSCOPE_API_KEY`）→ `~/.dsh/.credentials.yaml` 中的同名条目。

---

## 6. 配置

默认值定义于 `lib/config.js` 的 `DEFAULTS`。在 profile 的 `cordis.patch.yml` 中按需覆盖，配置为深合并：

```yaml
- id: qqbot-voice
  config:
    stt:
      preferQq: true
    tts:
      voice: Serena
    call:
      maxIdleMinutes: 5
      greetText: 在的，请讲
```

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 插件总开关 |
| `stateDir` | string | `~/.dsh/qqbot-voice` | 状态、诊断与日志目录 |
| `stt.engine` | string | `auto` | `auto` / `dashscope` / `http` / `command` / `qq` / `off` |
| `stt.preferQq` | boolean | `false` | 优先使用平台自带转写 |
| `stt.timeoutMs` | number | `30000` | 转写超时，超时后回退至平台转写 |
| `stt.maxMB` | number | `20` | 语音附件大小上限 |
| `stt.language` | string | `zh` | 识别语言 |
| `stt.cacheSize` | number | `200` | 转写结果缓存条数 |
| `stt.dashscope.apiKeyEnv` | string | `DASHSCOPE_API_KEY` | 凭据对应的环境变量名 |
| `stt.dashscope.model` | string | `qwen3-asr-flash` | 识别模型 |
| `tts.engine` | string | `auto` | `auto` / `dashscope` / `http` / `command` / `off` |
| `tts.timeoutMs` | number | `60000` | 合成超时 |
| `tts.maxChars` | number | `180` | 单条语音文本上限，超出按句子截断 |
| `tts.dashscope.voice` | string | `Cherry` | 音色 |
| `tts.dashscope.model` | string | `qwen3-tts-flash` | 合成模型 |
| `call.enabled` | boolean | `true` | 是否允许语音通话 |
| `call.maxIdleMinutes` | number | `8` | 静默自动挂断时长 |
| `call.announce` | boolean | `true` | 开始与结束时播报提示音 |
| `call.greetText` | string | `喂？在呢，你说。` | 开始通话时的播报文本 |
| `call.byeText` | string | `那我先挂了，回头聊。` | 结束通话时的播报文本 |
| `call.hintChars` | number | `40` | 通话期间对文本回复长度的提示阈值 |
| `voiceReply.sanitize` | boolean | `true` | 合成前移除 Markdown、链接与 emoji |
| `voiceReply.minChars` | number | `2` | 短于该长度不合成 |
| `promptEnabled` | boolean | `true` | 是否注入内置提示词段 |
| `promptText` | string | 空 | 覆盖内置提示词段 |

---

## 7. 工作原理

### 7.1 处理链路

```
入站
  └─ 中间件（挂载于 QQBot 实例）
       ├─ 指令识别与短路（/语音、/通话、/挂断）
       ├─ 语音附件转写 → 写入 ctx.state.processedAttachments
       └─ 语音/通话模式下追加回复方式提示

出站
  └─ 监听 session/event
       └─ 通话或语音回复模式下合成并发送语音消息
```

转写结果写入 `ctx.state.processedAttachments`（`dsh-qqbot` 为扩展预留的字段），
使 agent 接收到文本而非音频链接。

### 7.2 机器人实例获取与容错

- **注册表**：由补丁提供的 `qqbot-bots` 服务保存机器人实例及其关联对象。
- **实例变更处理**：插件重载时 `dsh-qqbot` 会创建新的 `QQBot` 实例。插件按实例标识去重，
  实例变更时卸载旧中间件并挂载至新实例。
- **周期校验**：每 60 秒比对一次实例与中间件状态，自动修复实例变更或中间件被移除的情况。
- **监听注册**：`session/event` 监听在 apply 阶段仅注册一次，避免重复播报。
- **入站活性**：`diagnostic.json` 的 `lastInbound` 时间戳用于判断中间件是否仍在链路中。

### 7.3 语音附件处理

平台返回的语音附件通常包含 `url`（SILK）与 `voice_wav_url`（WAV）。插件优先使用 WAV；
仅提供 SILK 时，使用 `silk-wasm` 解码；两者均不可用时回退至平台自带转写。

### 7.4 运行状态文件

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/qqbot-voice/diagnostic.json` | 版本、引擎链、`qqbot-bots` 服务状态、已挂载机器人、最近入站事件 |
| `~/.dsh/qqbot-voice/state.json` | 各会话的模式（`call` / `voice` / `off`） |
| `~/.dsh/qqbot-voice/voice.log` | 语音发送与合成日志 |

`diagnostic.json` 示例：

```json
{
  "version": "0.1.0+7",
  "stt": ["dashscope", "qq"],
  "tts": ["dashscope"],
  "qqbotBotsService": true,
  "bots": [{ "appId": "<appId>", "attachedAt": "2026-01-01T00:00:00.000Z", "reason": "register" }],
  "lastInbound": "2026-01-01T00:00:00.000Z"
}
```

---

## 8. 运行状态与故障排查

```powershell
node tools/fake-host.mjs              # 端到端自检（覆盖听、说、通话三条链路）
node tools/fake-host.mjs --no-network # 仅验证接线，不调用外部服务
node tools/probe-roundtrip.mjs        # 合成 → 识别闭环，验证凭据与引擎
node tools/probe-asr.mjs [wav]        # 逐一测试 ASR 通道
node tools/probe-voice.mjs            # 逐一测试 TTS / ASR 通道
node tools/make-voice.mjs "文本"       # 单独验证语音合成，不发送至 QQ
node tools/check-live.mjs             # 输出语音链路现场信息（只读）
node tools/install.mjs --check        # 安装与补丁状态检查
```

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 插件无任何语音行为 | 补丁未执行或未重启 | 执行补丁脚本并重启 DSH；检查 `diagnostic.json` 的 `qqbotBotsService` 与 `bots` |
| 转写缺失 | 语音附件未识别；ASR 引擎不可用 | 检查 `diagnostic.json` 的 `lastVoice` 与 `stt` 引擎链；确认凭据可用 |
| 语音回复仅返回文本 | TTS 引擎不可用；发送参数异常 | 查看 `voice.log`；确认 TTS 引擎链非空 |
| 通话中无响应 | 中间件未挂载至当前实例 | 等待周期校验自动修复，或重启 DSH；检查 `lastInbound` 是否更新 |
| 平台转写与插件转写同时出现 | 两者并存 | 设置 `stt.preferQq: true` 仅保留平台转写 |
| 群内主动消息失败 | 未开启机器人主动发言权限 | 由群管理员在群设置中开启 |

---

## 9. 安全与隐私

- **语音数据外发**：使用云端 ASR 引擎时，语音内容将发送至所配置的服务（默认阿里云百炼）。
  如不允许外发，请改用 `command` 引擎在本地完成识别。
- **凭据管理**：凭据读取自环境变量或 `~/.dsh/.credentials.yaml`，不写入仓库或日志。
- **本地落盘**：语音临时文件位于 `~/.dsh-qqbot/media`，受 qqbot 的过期清理策略管理。
- **权限范围**：补丁仅将机器人实例注册为服务，不改变 `dsh-qqbot` 原有行为。

---

## 10. 已知限制

- 不支持实时语音通话（平台无 RTC 接口），通话为语音消息对讲模式。
- 单条语音时长受平台限制（约 60 秒），超长文本将被截断或分段。
- 群内主动消息需群管理员开启机器人主动发言权限。
- 依赖对 `dsh-qqbot` 的补丁；该插件升级后需重新执行补丁。
- 语音附件为 SILK 且平台未提供 WAV 时，需安装 `silk-wasm` 方可解码。

---

## 11. 开发

### 11.1 目录结构

```
index.js                    插件入口：服务接线、工具注册、提示词段
lib/config.js               默认值、配置合并、凭据解析
lib/store.js                会话模式状态
lib/audio.js                语音附件下载、SILK 解码、落盘
lib/stt.js                  语音转写引擎链
lib/tts.js                  语音合成引擎链、文本清洗与发送
lib/middleware.js           入站处理：指令识别、转写、模式提示
lib/call.js                 模式状态机与出站播报
lib/session-log.js          会话日志辅助记录
tools/                      安装、补丁、探针与自检脚本
```

### 11.2 本地验证

```powershell
node tools/fake-host.mjs --no-network   # 不依赖外部服务的接线验证
```

未配置 TTS 引擎时，语音合成相关用例将被跳过而非失败。

---

## 12. 许可证

[MIT](LICENSE)

---

## English Overview

**dsh-qqbot-voice** adds voice capabilities to [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)
within DeepSeek Harness:

- **Listen** — inbound voice messages are transcribed and injected into the agent context as `[Voice message] <text>`;
- **Speak** — replies can be synthesized and sent as QQ voice messages, on demand or automatically;
- **Voice call** — a walkie-talkie mode in which both sides exchange voice messages, with automatic hang-up after a silent period.

The official QQ bot API provides no real-time audio (RTC) interface, so the call mode operates on discrete
voice messages. ASR and TTS are pluggable engine chains (`dashscope` / `http` / `command` / `qq`).

```bash
dsh plugin --profile web add github:ChencLi819/dsh-qqbot-voice
node tools/install.mjs    # apply the dsh-qqbot bot-registry patch, then restart DSH
```

Requires a `DASHSCOPE_API_KEY` (or any OpenAI-compatible endpoint) for the default engines.
Licensed under the MIT License.
