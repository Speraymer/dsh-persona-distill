/**
 * 源探测 —— 默认不假设用户装了任何东西。
 *
 * 已知的三个源：B站 / 微博 / 知乎。
 * 每个源只要在自己的目录里放一份 source.json，蒸馏就能发现它。
 * 插件不负责刷内容，只负责「有原料就蒸馏」。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './paths.mjs'

/** 已知源：dir 是家目录下的目录名，plugin 是「能产原料」的插件名（空 = 还没有现成的） */
export const KNOWN_SOURCES = [
  {
    id: 'bili',
    name: 'B站',
    dir: 'bili-duty',
    plugin: 'dsh-bili-scroll',
    provides: '每天刷一轮 B 站，把说话样本 / 踩过的坑 / 看过的片子记成三份原料',
  },
  {
    id: 'weibo',
    name: '微博',
    dir: 'weibo-duty',
    plugin: '',
    provides: '还没有现成插件；可以自己建目录，按同样的形状往里写原料',
  },
  {
    id: 'zhihu',
    name: '知乎',
    dir: 'zhihu-duty',
    plugin: '',
    provides: '还没有现成插件；可以自己建目录，按同样的形状往里写原料',
  },
]

/** 扫描 <家>/*\/source.json，返回真实存在的源 */
export function scanRegisteredSources() {
  const home = dshHome()
  const out = []
  let dirs = []
  try { dirs = readdirSync(home, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const file = join(home, d.name, 'source.json')
    if (!existsSync(file)) continue
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8'))
      out.push({
        id: String(meta.id || d.name),
        name: String(meta.name || meta.id || d.name),
        dir: d.name,
        enabled: meta.enabled !== false,
        voice: meta.voice || 'voice.md',
        notes: meta.notes || 'notes.md',
        digestDir: meta.digestDir || 'digest',
      })
    } catch { /* 坏的 source.json 跳过，别让整个探测失败 */ }
  }
  return out
}

/**
 * 完整探测：已知的三个源各是什么状态。
 * 返回给设置页用 —— 「有了 / 没装 / 已接上」三种状态一目了然。
 */
export function probeSources() {
  const home = dshHome()
  const registered = scanRegisteredSources()
  const regById = new Map(registered.map((s) => [s.id, s]))

  const rows = KNOWN_SOURCES.map((k) => {
    const dirExists = existsSync(join(home, k.dir))
    const reg = regById.get(k.id)
    return {
      id: k.id,
      name: k.name,
      dir: k.dir,
      plugin: k.plugin,
      provides: k.provides,
      // 目录在不在、有没有登记、有没有被蒸馏接上
      dirExists,
      registered: Boolean(reg),
      connected: Boolean(reg && reg.enabled),
      status: reg && reg.enabled
        ? 'connected'
        : dirExists
          ? 'detected'   // 目录有了，但没登记 / 没接上
          : 'absent',    // 连目录都没有
    }
  })

  // 还可能有自定义源（不在已知清单里）
  const knownIds = new Set(KNOWN_SOURCES.map((k) => k.id))
  const extra = registered
    .filter((s) => !knownIds.has(s.id))
    .map((s) => ({
      id: s.id, name: s.name, dir: s.dir, plugin: '',
      provides: '自定义源', dirExists: true, registered: true,
      connected: s.enabled, status: s.enabled ? 'connected' : 'detected',
    }))

  return [...rows, ...extra]
}
