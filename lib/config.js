// 配置默认值 + 合并 + key 解析。
//
// 想改配置不用动这个文件:在 profile 的 cordis.patch.yml 里补一行
//   - id: qqbot-voice
//     config: { tts: { voice: Cherry } }
// 就行(深合并,没写的字段仍用这里的默认值)。
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DASHSCOPE_GEN_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

/** 代码版本标记:写进 diagnostic.json,用来确认「热重载后到底加载的是不是新代码」 */
export const LIB_VERSION = '0.1.0+7'

export const DEFAULTS = {
  enabled: true,
  stateDir: '',
  /** 语音识别(听) */
  stt: {
    /** auto | dashscope | qq | http | command | off */
    engine: 'auto',
    /** true = 有 QQ 自带转写就直接用,不花外部引擎的钱 */
    preferQq: false,
    timeoutMs: 30_000,
    maxMB: 20,
    language: 'zh',
    /** 转写结果留在内存里的条数(同一条语音重复投递不重复转) */
    cacheSize: 200,
    dashscope: {
      baseURL: DASHSCOPE_GEN_URL,
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      apiKey: '',
      model: 'qwen3-asr-flash',
    },
    http: {
      baseURL: '',
      apiKeyEnv: '',
      apiKey: '',
      model: 'whisper-1',
    },
    /** 本地命令模板,{audio} 换成音频文件路径,stdout 当识别结果 */
    command: '',
  },
  /** 语音合成(说) */
  tts: {
    /** auto | dashscope | http | command | off */
    engine: 'auto',
    timeoutMs: 60_000,
    /** 一次最多念多少字(超了截断,别让语音长得像播客) */
    maxChars: 180,
    /** 音量/语速/音调(edge 引擎用;dashscope 只认音色) */
    dashscope: {
      baseURL: DASHSCOPE_GEN_URL,
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      apiKey: '',
      model: 'qwen3-tts-flash',
      /** Cherry / Serena / Ethan / Chelsie */
      voice: 'Cherry',
    },
    http: {
      baseURL: '',
      apiKeyEnv: '',
      apiKey: '',
      model: 'tts-1',
      voice: 'alloy',
      format: 'mp3',
    },
    /** 本地命令模板:{text} 文本、{out} 输出文件、{voice} 音色 */
    command: '',
    /** 自己装过 edge-tts(免费)的,把 engine 设成 command 再用这条模板:
     *  edge-tts --voice {voice} --text {text} --write-media {out}  (音色填 zh-CN-XiaoxiaoNeural) */
  },
  /** 语音通话(对讲)模式 */
  call: {
    enabled: true,
    /** 静默多久自动挂断(分钟) */
    maxIdleMinutes: 8,
    /** 开/挂断时说一句 */
    announce: true,
    greetText: '喂？在呢，你说。',
    byeText: '那我先挂了，回头聊。',
    /** 通话中把文字回复压到多短(0 = 不干预) */
    hintChars: 40,
  },
  /** 语音回复模式(回复照发文字,另外再念一遍) */
  voiceReply: {
    /** 念之前把回复里的 markdown/链接/emoji 清掉 */
    sanitize: true,
    /** 太短就别念了(比如「嗯」) */
    minChars: 2,
  },
  promptEnabled: true,
  promptText: '',
}

export const DEFAULT_PROMPT = [
  '【语音——听和说】',
  '- 群里/私聊里有人发语音,会自动转成文字给你(形如 [Voice message] xxx),你看文字就行,别提「转写」这件事。',
  '- 想开口说话(发一条真语音)用 qqbot_say;对方说「打电话」「语音通话」「打给我」就用 qqbot_voice_call(action=start)。',
  '- 通话中回话要短、要口语,像打电话,别用列表、别用 Markdown、别长篇。挂断用 qqbot_voice_call(action=end)。',
].join('\n')

/** 深合并:对象递归,数组/标量直接覆盖 */
export function mergeConfig(config) {
  const merge = (base, patch) => {
    if (patch === undefined || patch === null) return base
    if (Array.isArray(base) || typeof base !== 'object') return patch
    const out = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in base && typeof base[key] === 'object' && !Array.isArray(base[key])
        ? merge(base[key], value)
        : value
    }
    return out
  }
  return merge(DEFAULTS, config && typeof config === 'object' ? config : {})
}

let credentialsCache
/** 读 ~/.dsh/.credentials.yaml 里的 refs(DSH 自己的凭据文件,一行一个 KEY: value) */
export function readCredentials() {
  if (credentialsCache !== undefined) return credentialsCache
  const out = {}
  try {
    const file = join(homedir(), '.dsh', '.credentials.yaml')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/.exec(line)
        if (m) out[m[1]] = m[2]
      }
    }
  } catch {
    /* 读不到就当没有 */
  }
  credentialsCache = out
  return out
}

/** 按 spec.apiKey → 环境变量 → ~/.dsh/.credentials.yaml 的顺序找 key */
export function resolveApiKey(spec = {}) {
  if (spec.apiKey) return String(spec.apiKey).trim()
  const envName = spec.apiKeyEnv ? String(spec.apiKeyEnv).trim() : ''
  if (!envName) return ''
  const fromEnv = process.env[envName]
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  const fromFile = readCredentials()[envName]
  return fromFile ? String(fromFile).trim() : ''
}

export function stateDirOf(settings) {
  return settings.stateDir || join(homedir(), '.dsh', 'qqbot-voice')
}
