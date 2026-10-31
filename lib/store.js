// 「谁在通话 / 谁开了语音回复」的状态,落在 ~/.dsh/qqbot-voice/state.json。
//
// 键是 `${appId}:${scope}:${peerId}`(scope = group | c2c),值:
//   { mode: 'voice' | 'call', since, lastAt, until }
// mode=off 直接删键 —— 文件里只有「开着」的会话,重启后还在。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 1

export function peerKey(appId, scope, peerId) {
  return `${appId}:${scope}:${peerId}`
}

export function createStore(stateDir) {
  const file = join(stateDir, 'state.json')
  let state = load()
  function load() {
    try {
      if (!existsSync(file)) return { version: VERSION, peers: {} }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.version !== VERSION || typeof parsed.peers !== 'object' || parsed.peers === null) {
        return { version: VERSION, peers: {} }
      }
      return parsed
    } catch {
      return { version: VERSION, peers: {} }
    }
  }

  function save() {
    try {
      mkdirSync(stateDir, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
      renameSync(tmp, file)
    } catch {
      /* 写不动就算了,内存里的状态还能用 */
    }
  }

  // 建 store 时先把文件落一下:这样「插件到底起没起来」看一眼 state.json 的
  // mtime 就知道,不用去翻宿主日志。
  save()

  return {
    file,
    /** 'off' | 'voice' | 'call' */
    mode(key) {
      return state.peers[key]?.mode ?? 'off'
    },
    entry(key) {
      return state.peers[key] ?? null
    },
    all() {
      return Object.entries(state.peers).map(([key, value]) => ({ key, ...value }))
    },
    set(key, mode, patch = {}) {
      if (mode === 'off') {
        delete state.peers[key]
        save()
        return null
      }
      const now = Date.now()
      const prev = state.peers[key]
      const entry = { mode, since: prev?.since ?? now, lastAt: now, ...patch }
      state.peers[key] = entry
      save()
      return entry
    },
    touch(key) {
      const entry = state.peers[key]
      if (!entry) return null
      entry.lastAt = Date.now()
      save()
      return entry
    },
  }
}
