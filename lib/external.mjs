/**
 * 外部记忆源适配器
 * ============================================================================
 * 有些插件不按我们的「三份原料」形状写东西 —— 比如 dsh-bili-humanism 写的是
 * 按天分篇的长文手账（inbox.md）。
 *
 * 这一层的活：**把别人的形状，转成我们的形状**。
 *   · 不写别人的目录（只读）
 *   · 镜像到 <家>/external-<id>/，蒸馏照常扫 source.json
 *   · 加新接口 = 往 ADAPTERS 里加一条，主流程不动
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './paths.mjs'

// ---------------------------------------------------------------- 切分工具

/** 按篇切：优先 `## ` 标题，其次 `---` 分隔线，都没有就整篇一条 */
function splitByEntry(text) {
  // 1) 优先按 `## ` 切；第一个 ## 之前的东西（一般是 H1 标题）不算一篇
  const parts = String(text).split(/^##\s+/m)
  if (parts.length > 1) {
    const chunks = parts.slice(1).map((s) => s.trim()).filter(Boolean)
    if (chunks.length) return chunks
  }
  // 2) 退到 `---` 分隔线
  const byHr = String(text).split(/^\s*---+\s*$/m).map((s) => s.trim()).filter(Boolean)
  if (byHr.length > 1) return byHr
  // 3) 整篇一条（去掉纯 H1 标题行）
  const whole = String(text).replace(/^#\s+.*$/m, '').trim()
  return whole ? [whole] : []
}

/** 从一段里抠出：日期 / 标题 / 摘要（按篇，不按句 —— 断章比漏记更糟） */
function toEntry(chunk, fallbackDate = '') {
  const raw = chunk.replace(/^##\s+/, '').trim()
  if (!raw) return null
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const head = lines[0] || ''
  const body = lines.slice(1).join(' ').replace(/\s+/g, ' ').trim()
  const date = (raw.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || fallbackDate
  const title = head.replace(/\d{4}-\d{2}-\d{2}/, '').replace(/^[·\-—\s]+/, '').trim() || '一篇手账'
  return { date, title, excerpt: body.slice(0, 300) || '（无正文摘要）' }
}

// ---------------------------------------------------------------- 适配器清单

/**
 * 每个适配器：
 *   id      —— 源 id（写进 source.json，也是来源前缀）
 *   name    —— 人看的名字
 *   source  —— 去哪找它的产出（返回路径）
 *   parse   —— 把文件内容切成条目
 *   note    —— 一句话说明「这个源擅长教什么」
 *
 * 加新接口（微博 / 知乎 / 别的）：照抄形状加一条就行。
 */
export const ADAPTERS = [
  {
    id: 'humanism',
    name: 'B站手账',
    note: '来自 dsh-bili-humanism 的 inbox.md —— 整篇反思，擅长教「怎么活」',
    source: (home) => join(home, 'bili-humanism', 'inbox.md'),
    parse: (text) => splitByEntry(text).map((c) => toEntry(c)).filter(Boolean),
  },
  {
    id: 'humanism-world',
    name: 'B站人格笔记本',
    note: '来自 dsh-bili-humanism 的 human-world.md —— 它自己选出的「一句自我反思」，最接近「怎么活」',
    source: (home) => join(home, 'bili-humanism', 'human-world.md'),
    parse: (text) => splitByEntry(text).map((c) => toEntry(c)).filter(Boolean),
  },
]

// ---------------------------------------------------------------- 同步

/**
 * 把能发现的外部源同步成我们的形状。
 * 返回每个源的状态（给设置页看）。
 */
export function syncExternalSources() {
  const home = dshHome()
  const out = []

  for (const a of ADAPTERS) {
    const src = a.source(home)
    if (!existsSync(src)) {
      out.push({ id: a.id, name: a.name, note: a.note, active: false })
      continue
    }
    try {
      const dir = join(home, `external-${a.id}`)
      mkdirSync(join(dir, 'digest'), { recursive: true })

      // 1) 登记（已存在就不覆盖 —— 用户可能改过 enabled）
      const sj = join(dir, 'source.json')
      if (!existsSync(sj)) {
        writeFileSync(sj, JSON.stringify({
          id: a.id,
          name: a.name,
          charter: '',
          voice: 'voice.md',
          notes: 'notes.md',
          digestDir: 'digest',
          enabled: true,
          external: true,
          from: src,
        }, null, 2), 'utf8')
      }

      // 2) 空骨料（外部源不产说话样本和结论，但文件要在，免得触发「源读不出」的降级保护）
      for (const f of ['voice.md', 'notes.md']) {
        const p = join(dir, f)
        if (!existsSync(p)) {
          writeFileSync(p, `# ${a.name} · ${f.replace('.md', '')}\n\n（这个外部源不产生这一类原料，别当它是空的。）\n`, 'utf8')
        }
      }

      // 3) 正文：切成条目，写成一行一条
      const text = readFileSync(src, 'utf8')
      const entries = a.parse(text)
      const lines = entries.map((e) => `- ${e.date || '—'} · ${e.title} · ${e.excerpt}`)
      writeFileSync(
        join(dir, 'digest', `${a.id}.md`),
        `# ${a.name} · 外部源（从 ${src} 同步，只读）\n\n${lines.join('\n')}\n`,
        'utf8',
      )

      out.push({ id: a.id, name: a.name, note: a.note, active: true, entries: entries.length, dir, from: src })
    } catch (e) {
      out.push({ id: a.id, name: a.name, note: a.note, active: false, error: String(e?.message ?? e) })
    }
  }

  return out
}

/** 只看状态、不写文件（设置页用） */
export function probeExternalSources() {
  const home = dshHome()
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    note: a.note,
    active: existsSync(a.source(home)),
    dir: join(home, `external-${a.id}`),
  }))
}
