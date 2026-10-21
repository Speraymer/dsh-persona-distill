/**
 * 初始化 —— 第一次启用时把骨架铺好。
 * 原则：只补缺的，不覆盖已有的（用户可能已经手动改过）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, personaHome, agentsFile } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(HERE, '..', 'prompts')

function readTemplate(name) {
  return readFileSync(join(TEMPLATE_DIR, name), 'utf8')
}

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

/** 建 persona 工作区 + 章程 + 状态 + 候选池（缺什么补什么） */
export function ensurePersonaHome() {
  const home = personaHome()
  mkdirSync(home, { recursive: true })
  mkdirSync(join(home, 'archive'), { recursive: true })

  const charter = join(home, 'distill.md')
  if (!existsSync(charter)) {
    writeFileSync(charter, fill(readTemplate('distill.md'), { DSH_HOME: dshHome() }), 'utf8')
  }

  const state = join(home, 'state.json')
  if (!existsSync(state)) {
    writeFileSync(state, JSON.stringify({
      version: 3,
      sources: {},
      lastPromote: '',
      lastRun: '',
    }, null, 2), 'utf8')
  }

  const pending = join(home, 'pending.md')
  if (!existsSync(pending)) writeFileSync(pending, '# 候选池\n\n', 'utf8')

  return home
}

/** 把演法参照铺到 persona 目录（只有「大肥鱼」模板需要） */
function ensureStyleExamples() {
  const dest = join(personaHome(), 'style-examples.md')
  if (existsSync(dest)) return dest
  try {
    const src = readTemplate('style-examples.md')
    writeFileSync(dest, src, 'utf8')
    return dest
  } catch {
    return ''
  }
}

/**
 * AGENTS.md：不存在就生成；存在但没有 AUTO 段就追加（不动人家已有内容）
 *
 * persona:
 *   'blank' —— 中性骨架（默认）。用户自己填「我是谁」。
 *   'clam'  —— 大肥鱼模板：带人设 + 演法参照（style-examples.md）。
 */
export function ensureAgents({ ownerName = '', heart = '', identity = '', persona = 'blank' } = {}) {
  const file = agentsFile()
  const hasAuto = '<!-- AUTO:BEGIN -->'
  const hasEnd = '<!-- AUTO:END -->'

  if (!existsSync(file)) {
    const tpl = persona === 'clam' ? 'persona-clam.md' : 'agents-template.md'
    const text = fill(readTemplate(tpl), {
      OWNER: ownerName || '主人',
      DSH_HOME: dshHome(),
      HEART: heart || '（这里写你最想让它记住的一句话 —— 在设置页填，或者直接改这个文件）',
      IDENTITY: identity || '（这里写它是谁。留空也没关系，它会从原料里慢慢长出「我学来的」那段。）',
    })
    writeFileSync(file, text, 'utf8')
    if (persona === 'clam') ensureStyleExamples()
    return { created: true, file, persona }
  }

  // 文件已存在：如果这次选了 clam 但演法文件还没铺，补上（不动 AGENTS.md 本身）
  if (persona === 'clam') ensureStyleExamples()

  const cur = readFileSync(file, 'utf8')
  if (cur.includes(hasAuto) && cur.includes(hasEnd)) return { created: false, file, persona }

  // 已有文件但没 AUTO 段：备份后追加
  const bak = `${file}.bak-${new Date().toISOString().slice(0, 10)}`
  try { writeFileSync(bak, cur, 'utf8') } catch { /* 备份失败不拦着 */ }
  writeFileSync(file, cur.trimEnd() + '\n\n## 我学来的\n\n<!-- AUTO:BEGIN -->\n（还没定型过。）\n<!-- AUTO:END -->\n', 'utf8')
  return { created: false, appended: true, file, backup: bak, persona }
}

/** 读现有 AGENTS.md 的手写段（给设置页回显用） */
export function readAgentsSections() {
  try {
    const t = readFileSync(agentsFile(), 'utf8')
    const hand = t.match(/<!-- HAND:BEGIN[^>]*-->([\s\S]*?)<!-- HAND:END -->/)
    const auto = t.match(/<!-- AUTO:BEGIN -->([\s\S]*?)<!-- AUTO:END -->/)
    return {
      exists: true,
      hand: hand ? hand[1].trim() : '',
      auto: auto ? auto[1].trim() : '',
      autoLines: auto ? auto[1].trim().split('\n').length : 0,
    }
  } catch {
    return { exists: false, hand: '', auto: '', autoLines: 0 }
  }
}
