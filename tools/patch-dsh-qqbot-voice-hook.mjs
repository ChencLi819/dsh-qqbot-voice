// 给 dsh-qqbot 打一个「机器人注册表」补丁(幂等,可重复执行)。
//
// 为什么需要:
//   dsh-qqbot 把 QQBot 实例关在 bootstrap 里,外面拿不到。语音插件要挂入站中间件
//   (bot.use)、要发语音(mediaSender.sendVoice),都必须摸到这个实例。
//
// 补丁做的事:
//   在 dist/gateway/bootstrap.js 里 mediaSender 建好之后,把 { appId, bot, manager,
//   mediaSender, config, logger } 注册进一个 Cordis 服务 qqbot-bots(第一次由本补丁
//   provide,之后每个机器人复用同一个注册表)。消费方:qqbot-voice 的
//   ctx.inject(['qqbot-bots'], ...)。
//
// 用法:node qqbot-voice/tools/patch-dsh-qqbot-voice-hook.mjs [--profile-dir <path>] [--check]
//   pnpm 更新 @tencent-connect/dsh-qqbot 后要重跑(patch 会被整包替换掉);
//   打完补丁要重启 DSH(改的是插件模块,热重载不一定重新导入)。
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = resolve(argOf('profile-dir', process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')))
const CHECK_ONLY = args.includes('--check')

const PLUGIN = join(PROFILE_DIR, 'node_modules', '@tencent-connect', 'dsh-qqbot')
const BOOTSTRAP = join(PLUGIN, 'dist', 'gateway', 'bootstrap.js')

/** 补丁标记:出现它就认为已打过 */
const SENTINEL = "ctx.provide('qqbot-bots'"

const ANCHOR = "    const deliverablesDeliverer = new DeliverablesDeliverer(sender, mediaSender, config, logger);"

const INSERT = `    // ── 机器人注册表(本地补丁):别的插件(如 qqbot-voice)要挂中间件 / 发语音 ──
    try {
        let registry;
        try {
            registry = ctx.get('qqbot-bots');
        }
        catch {
            registry = undefined;
        }
        if (!registry) {
            const bots = new Map();
            const listeners = new Set();
            registry = {
                list: bots,
                onBot(listener) {
                    listeners.add(listener);
                    for (const entry of bots.values()) {
                        try {
                            listener(entry);
                        }
                        catch (error) {
                            logger?.warn?.(\`qqbot-bots listener 出错: \${error?.message ?? error}\`);
                        }
                    }
                    return () => listeners.delete(listener);
                },
                register(entry) {
                    bots.set(entry.appId, entry);
                    for (const listener of listeners) {
                        try {
                            listener(entry);
                        }
                        catch (error) {
                            logger?.warn?.(\`qqbot-bots listener 出错: \${error?.message ?? error}\`);
                        }
                    }
                },
            };
            try {
                ctx.provide('qqbot-bots', registry);
            }
            catch (error) {
                logger?.warn?.(\`provide qqbot-bots 失败: \${error?.message ?? error}\`);
            }
        }
        registry.register({ appId: config.appId, bot, manager, mediaSender, config, logger });
    }
    catch (error) {
        logger?.warn?.(\`qqbot-bots 注册失败: \${error?.message ?? error}\`);
    }
${ANCHOR}`

if (!existsSync(PLUGIN)) {
  console.error(`找不到 ${PLUGIN} —— 先确认 @tencent-connect/dsh-qqbot 已装在 ${PROFILE_DIR}`)
  process.exit(1)
}

const bootstrap = await readFile(BOOTSTRAP, 'utf8')
const patched = bootstrap.includes(SENTINEL)
const anchorOk = bootstrap.includes(ANCHOR)

if (CHECK_ONLY) {
  console.log(`bootstrap — ${patched ? 'OK(已提供 qqbot-bots 服务)' : anchorOk ? '未打补丁' : '锚点缺失(插件版本可能变了)'}`)
  process.exit(patched ? 0 : 2)
}

if (patched) {
  console.log('PATCHED   — qqbot-bots 注册表补丁已在位,无需重复打')
  process.exit(0)
}
if (!anchorOk) {
  console.error('锚点缺失,补丁未应用(插件版本可能变了): ' + ANCHOR.trim())
  console.error('请对照 dsh-qqbot 的 src/gateway/bootstrap.ts 重新核对后更新本脚本。')
  process.exit(3)
}

const backup = BOOTSTRAP + '.pre-voicehook.bak'
if (!existsSync(backup)) await copyFile(BOOTSTRAP, backup)
await writeFile(BOOTSTRAP, bootstrap.replace(ANCHOR, INSERT))
console.log(`done      — ${BOOTSTRAP}(原文件备份在 ${backup})`)
console.log('注意:改完要重启 DSH 才会生效。')
