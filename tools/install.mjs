// 把 dsh-qqbot-voice 装进 DSH profile(幂等,可重复执行)。
//
// 做三件事:
//   1. pnpm add link:<本包目录> —— link 协议 = 软链,改工作区里的代码即改插件;
//   2. profile package.json 的 dsh.profile.bundles 里加上 dsh-qqbot-voice
//      (插件的 cordis.patch.yml 负责插行);
//   3. 给 dsh-qqbot 打「机器人注册表」补丁 —— 语音插件要摸到 QQBot 实例才能挂
//      入站中间件、发语音(补丁本身幂等,详见 tools/patch-dsh-qqbot-voice-hook.mjs)。
//
// 用法: node qqbot-voice/tools/install.mjs [--profile-dir <path>] [--no-pnpm] [--no-patch] [--check]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-qqbot-voice'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const PROFILE_DIR = resolve(argOf('profile-dir', process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')))
const CHECK_ONLY = args.includes('--check')
const SKIP_PNPM = args.includes('--no-pnpm')
const SKIP_PATCH = args.includes('--no-patch')

const pkgJsonPath = join(PROFILE_DIR, 'package.json')
if (!existsSync(pkgJsonPath)) {
  console.error(`找不到 ${pkgJsonPath} —— 用 --profile-dir 指定 DSH profile 目录`)
  process.exit(1)
}

/** 1) 依赖:pnpm add link:<包目录> */
function ensureDependency() {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const current = pkg.dependencies?.[PACKAGE_NAME] ?? ''
  const wanted = `link:${PACKAGE_DIR}`
  if (current === wanted) return `已装(=${wanted})`
  if (CHECK_ONLY) return current ? `依赖是 ${current},期望 ${wanted}` : '未安装'
  if (SKIP_PNPM) return '跳过 pnpm(--no-pnpm)'
  const result = spawnSync('pnpm', ['add', wanted], { cwd: PROFILE_DIR, encoding: 'utf8', shell: true })
  if (result.status !== 0) {
    console.error('pnpm add 失败:\n' + (result.stdout ?? '') + (result.stderr ?? ''))
    process.exit(2)
  }
  return `已安装(${wanted})`
}

/** 2) bundles 列表:加上包名 */
function ensureBundle() {
  const raw = readFileSync(pkgJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (bundles.includes(PACKAGE_NAME)) return '已在 bundles 里'
  if (CHECK_ONLY) return 'bundles 里没有它'
  bundles.push(PACKAGE_NAME)
  pkg.dsh.profile.bundles = bundles
  copyFileSync(pkgJsonPath, pkgJsonPath + '.pre-qqbot-voice.bak')
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  return '已加入 bundles(原文件备份 .pre-qqbot-voice.bak)'
}

/** 3) dsh-qqbot 补丁:挂 qqbot-bots 注册表 */
function ensurePatch() {
  if (SKIP_PATCH) return '跳过补丁(--no-patch)'
  const script = join(PACKAGE_DIR, 'tools', 'patch-dsh-qqbot-voice-hook.mjs')
  const result = spawnSync(process.execPath, [script, '--profile-dir', PROFILE_DIR, ...(CHECK_ONLY ? ['--check'] : [])], {
    encoding: 'utf8',
    shell: false,
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0] ?? ''
  if (CHECK_ONLY) {
    // 补丁脚本的 --check:0 = 已打,2 = 未打,其它 = 锚点缺失
    if (result.status === 0) return `已打(${out})`
    if (result.status === 2) return `未打(${out})`
    return `检查失败(status=${result.status}):${out}`
  }
  if (result.status !== 0) return `补丁没打上:${out}`
  return out
}

console.log(`profile : ${PROFILE_DIR}`)
console.log(`插件包  : ${PACKAGE_DIR}`)
console.log(`1. 依赖  : ${ensureDependency()}`)
console.log(`2. bundle: ${ensureBundle()}`)
console.log(`3. 补丁  : ${ensurePatch()}`)
if (CHECK_ONLY) {
  console.log('\n(--check 只检查,不改动)')
} else {
  console.log('\n下一步:')
  console.log('  · 重启 DSH(补丁改的是 dsh-qqbot 的模块,热重载不一定重新导入);')
  console.log('  · 日志里出现 [qqbot-voice] 听:… 说:… 就说明起来了;')
  console.log('  · 在群里 @ 它发一条语音试试;想让它开口:/语音 开;想打电话:/通话。')
  console.log('  · 自测(不用重启):node qqbot-voice/tools/fake-host.mjs')
}
