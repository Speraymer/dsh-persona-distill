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
 *
 * ⚠️ 2026-10-22 修：原来只把长文截到 300 字塞进 digest，结果蒸馏只能提炼 [判]，
 *    提炼不出 [活] —— 因为「认识的修正 / 下一次如何回应」那两段被截掉了。
 *    现在**额外把这两段摘进 notes.md**，那才是「怎么活」该吃的东西。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './paths.mjs'

// ---------------------------------------------------------------- 切分工具

/** 按篇切：优先 `## ` 标题，其次 `---` 分隔线，都没有就整篇一条 */
function splitByEntry(text) {
  const parts = String(text).split(/^##\s+/m)
  if (parts.length > 1) {
    const chunks = parts.slice(1).map((s) => s.trim()).filter(Boolean)
    if (chunks.length) return chunks
  }
  const byHr = String(text).split(/^\s*---+\s*$/m).map((s) => s.trim()).filter(Boolean)
  if (byHr.length > 1) return byHr
  const whole = String(text).replace(/^#\s+.*$/m, '').trim()
  return whole ? [whole] : []
}

/** 抠一个 `**小节名**` 下面的正文，到下一个 `**小节名**` 为止 */
function extractSection(raw, name) {
  const marker = '**' + name + '**'
  const idx = raw.indexOf(marker)
  if (idx < 0) return ''
  const rest = raw.slice(idx + marker.length)
  const next = rest.search(/\n\s*\*\*[^*]+\*\*/)
  const seg = next >= 0 ? rest.slice(0, next) : rest
  return seg.replace(/\s+/g, ' ').replace(/^-+\s*/, '').trim()
}

/** 从一段里抠出：日期 / 标题 / 摘要 / 认识的修正 / 下一次如何回应 */
function toEntry(chunk, fallbackDate = '') {
  const raw = chunk.replace(/^##\s+/, '').trim()
  if (!raw) return null
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const head = lines[0] || ''
  const body = lines.slice(1).join(' ').replace(/\s+/g, ' ').trim()
  const date = (raw.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || fallbackDate
  const title = head.replace(/\d{4}-\d{2}-\d{2}/, '').replace(/^[·\-—\s]+/, '').trim() || '一篇手账'

  return {
    date,
    title,
    excerpt: body.slice(0, 300) || '（无正文摘要）',
    revision: extractSection(raw, '认识的修正').slice(0, 240),
    nextResponse: extractSection(raw, '下一次如何回应').slice(0, 240),
  }
}

// ---------------------------------------------------------------- 适配器清单

/**
 * 每个适配器：
 *   id      —— 源 id（写进 source.json，也是来源前缀）
 *   name    —— 人看的名字
 *   plugin  —— 产它的插件名（推荐列表里用）
 *   install —— 怎么装（推荐列表里显示）
 *   source  —— 去哪找它的产出（返回路径）
 *   parse   —— 把文件内容切成条目
 *   note    —— 一句话说明「这个源擅长教什么」
 */
export const ADAPTERS = [
  {
    id: 'humanism',
    name: 'B站手账',
    plugin: 'dsh-bili-humanism',
    install: 'dsh plugin --profile web add dsh-bili-humanism',
    note: '来自 dsh-bili-humanism 的 inbox.md —— 整篇反思，擅长教「怎么活」',
    source: (home) => join(home, 'bili-humanism', 'inbox.md'),
    parse: (text) => splitByEntry(text).map((c) => toEntry(c)).filter(Boolean),
  },
  {
    id: 'humanism-world',
    name: 'B站人格笔记本',
    plugin: 'dsh-bili-humanism',
    install: 'dsh plugin --profile web add dsh-bili-humanism',
    note: '来自 dsh-bili-humanism 的 human-world.md —— 它自己选出的「一句自我反思」',
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
    const base = { id: a.id, name: a.name, plugin: a.plugin, install: a.install, note: a.note }
    if (!existsSync(src)) {
      out.push({ ...base, active: false })
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

      // 2) 说话样本：【外部源不产】—— 但文件要在，免得触发「源读不出」的降级保护
      const voiceF = join(dir, 'voice.md')
      if (!existsSync(voiceF)) {
        writeFileSync(voiceF, `# ${a.name} · voice\n\n（这个外部源不产说话样本，别当它是空的。）\n`, 'utf8')
      }

      // 3) 正文：切成条目写进 digest
      const text = readFileSync(src, 'utf8')
      const entries = a.parse(text)
      const digestLines = entries.map((e) => `- ${e.date || '—'} · ${e.title} · ${e.excerpt}`)
      writeFileSync(
        join(dir, 'digest', `${a.id}.md`),
        `# ${a.name} · 外部源（从 ${src} 同步，只读）\n\n${digestLines.join('\n')}\n`,
        'utf8',
      )

      // 4) 结论：把「认识的修正 / 下一次如何回应」摘进 notes —— 这才是 [活] 的料
      const notesLines = entries
        .map((e) => {
          const bits = [e.revision, e.nextResponse].filter(Boolean)
          if (!bits.length) return null
          return `- ${e.date || '—'} · ${e.title} · ${bits.join(' ／ ')}`
        })
        .filter(Boolean)
      writeFileSync(
        join(dir, 'notes.md'),
        `# ${a.name} · notes（从手账里摘的「修正」和「下次怎么回应」）\n\n` +
          (notesLines.length
            ? notesLines.join('\n')
            : '（这份手账里没有「认识的修正」或「下一次如何回应」，暂时没有可摘的结论。）') +
          '\n',
        'utf8',
      )

      out.push({ ...base, active: true, entries: entries.length, notes: notesLines.length, dir, from: src })
    } catch (e) {
      out.push({ ...base, active: false, error: String(e?.message ?? e) })
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
    plugin: a.plugin,
    install: a.install,
    active: existsSync(a.source(home)),
    dir: join(home, `external-${a.id}`),
  }))
}
