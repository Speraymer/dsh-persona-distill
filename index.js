/**
 * dsh-persona-distill —— host 半端
 * ============================================================================
 * 它是什么：把「原料 → 候选 → 人格」这条流水线插件化。
 *
 *   1. **不假设用户装了任何东西**：只扫 `<家>/*\/source.json`，有原料就蒸馏，没有就什么都不做。
 *   2. **默认全开**：B站 / 微博 / 知乎三个已知源都会探测，找到就问用户要不要接上。
 *   3. **每天定时**跑一次 headless 会话，读章程 `persona\distill.md`。
 *   4. **设置页**（client.js）通过 `/api/persona-distill/*` 读写配置、看源状态、手动跑。
 *
 * 家目录（$DSH_HOME）：
 *   persona\        distill.md / state.json / pending.md / archive\ / headless-overlay.yml
 *   persona-distill\ config.json / run.log / last-run.txt      ← 插件自己的配置与日志
 *   AGENTS.md       人格面板（全局面板，DSH 每次会话都读）
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, pluginHome, personaHome } from './lib/paths.mjs'
import { buildHeadlessCommand } from './lib/dsh.mjs'
import { probeSources } from './lib/sources.mjs'
import { ensurePersonaHome, ensureAgents, readAgentsSections } from './lib/init.mjs'

export const name = 'persona-distill'
export const inject = ['webServer']

const DEFAULTS = {
  enabled: false,
  runAt: '04:10',
  ownerName: '',
  heart: '',
  identity: '',
  model: 'deepseek-flash',
  lastRun: '',
  lastResult: '',
}

const OVERLAY = `# 蒸馏会话用的最小 overlay —— 只要账号和模型，不要 MCP
- id: credentials
  disabled: false

- id: authorization
  disabled: false

- id: deepseek-account
  disabled: false

- id: agent-default-model
  config:
    provider: deepseek-account
    model: __MODEL__
    reasoningEffort: high
`

const cfgFile = () => join(pluginHome(), 'config.json')

function readCfg() {
  try {
    const raw = JSON.parse(readFileSync(cfgFile(), 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeCfg(patch) {
  const next = { ...readCfg(), ...patch }
  try {
    mkdirSync(pluginHome(), { recursive: true })
    writeFileSync(cfgFile(), JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 写不进去也别把插件弄崩 */ }
  return next
}

function log(msg) {
  try {
    mkdirSync(pluginHome(), { recursive: true })
    appendFileSync(join(pluginHome(), 'run.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch { /* 日志写不了就算了 */ }
}

/** 生成（或复用）headless overlay */
function ensureOverlay(model) {
  const home = personaHome()
  mkdirSync(home, { recursive: true })
  const f = join(home, 'headless-overlay.yml')
  if (!existsSync(f)) {
    writeFileSync(f, OVERLAY.replace('__MODEL__', model || 'deepseek-flash'), 'utf8')
  }
  return f
}

/** 跑一次蒸馏（异步，不阻塞） */
function runOnce(cfg, { manual = false } = {}) {
  const home = personaHome()
  const charter = join(home, 'distill.md')
  if (!existsSync(charter)) {
    ensurePersonaHome()
  }
  ensureAgents({ ownerName: cfg.ownerName, heart: cfg.heart, identity: cfg.identity })

  const overlay = ensureOverlay(cfg.model)
  const today = new Date().toISOString().slice(0, 10)
  const prompt = `读 ${charter}，按它做今天的蒸馏。今天是 ${today}。做完在 ${join(home, 'run.log')} 追加一行。`

  const cmd = buildHeadlessCommand({ overlay, prompt })
  if (cmd.missing) {
    log('找不到 dsh CLI，蒸馏没跑起来')
    writeCfg({ lastRun: new Date().toISOString(), lastResult: '找不到 dsh CLI' })
    return { ok: false, error: '找不到 dsh CLI：请设置 DSH_BIN 环境变量，或在设置页填写 dsh 路径' }
  }

  const outFile = join(pluginHome(), 'last-run.txt')
  let out = ''
  log(`开始蒸馏${manual ? '（手动）' : ''}：${today}`)

  const child = spawn(cmd.command, cmd.args, {
    cwd: dshHome(),
    env: { ...process.env, ...cmd.env, DSH_HOME: dshHome() },
    windowsHide: true,
  })

  child.stdout?.on('data', (d) => { out += d.toString() })
  child.stderr?.on('data', (d) => { out += d.toString() })

  child.on('error', (e) => {
    log(`spawn 失败：${e?.message ?? e}`)
    writeCfg({ lastRun: new Date().toISOString(), lastResult: `spawn 失败：${e?.message ?? e}` })
  })

  child.on('close', (code) => {
    try { writeFileSync(outFile, out, 'utf8') } catch { /* 忽略 */ }
    log(`执行完毕 exit=${code}`)
    writeCfg({
      lastRun: new Date().toISOString(),
      lastResult: code === 0 ? '成功' : `exit=${code}`,
    })
  })

  return { ok: true, pid: child.pid }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
  })
}

export function apply(ctx, config) {
  // 首次启用时把骨架铺好（只补缺的）
  try {
    ensurePersonaHome()
    const cfg = readCfg()
    ensureAgents({ ownerName: cfg.ownerName, heart: cfg.heart, identity: cfg.identity })
  } catch (e) {
    log(`初始化失败：${e?.message ?? e}`)
  }

  // ---- HTTP API ----
  const handle = async (req, res, url) => {
    const path = url.pathname

    if (req.method === 'GET' && path === '/api/persona-distill/status') {
      const cfg = readCfg()
      return sendJson(res, 200, {
        ok: true,
        config: cfg,
        sources: probeSources(),
        agents: readAgentsSections(),
        home: dshHome(),
        hasDsh: !buildHeadlessCommand({ prompt: 'x' }).missing,
      })
    }

    if (req.method === 'GET' && path === '/api/persona-distill/probe') {
      return sendJson(res, 200, { ok: true, sources: probeSources() })
    }

    if (req.method === 'POST' && path === '/api/persona-distill/config') {
      const body = await readBody(req)
      const allowed = {}
      for (const k of ['enabled', 'runAt', 'ownerName', 'heart', 'identity', 'model']) {
        if (k in body) allowed[k] = body[k]
      }
      userCfg = writeCfg(allowed)
      return sendJson(res, 200, { ok: true, config: userCfg })
    }

    if (req.method === 'POST' && path === '/api/persona-distill/run') {
      const r = runOnce(readCfg(), { manual: true })
      return sendJson(res, 200, r)
    }

    if (req.method === 'POST' && path === '/api/persona-distill/connect') {
      // 把某个「已探测到但没接上」的源写上 source.json
      const body = await readBody(req)
      const id = String(body.id || '').trim()
      if (!id) return sendJson(res, 400, { ok: false, error: '缺 id' })
      const dir = join(dshHome(), String(body.dir || `${id}-duty`))
      try {
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'source.json')
        if (!existsSync(file)) {
          writeFileSync(file, JSON.stringify({
            id,
            name: String(body.name || id),
            charter: 'duty.md',
            voice: 'voice.md',
            notes: 'notes.md',
            digestDir: 'digest',
            enabled: true,
            added: new Date().toISOString().slice(0, 10),
          }, null, 2), 'utf8')
        }
        return sendJson(res, 200, { ok: true, file })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/persona-distill',
      handler: async (req, res) => {
        try {
          await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'persona-distill: /api/persona-distill 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  // ---- 每天定时器（每分钟看一眼，到点就跑）----
  let lastFiredDay = ''
  const timer = setInterval(() => {
    const cfg = readCfg()
    if (!cfg.enabled) return
    const now = new Date()
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
    const day = now.toISOString().slice(0, 10)
    if (hhmm === String(cfg.runAt || '04:10') && lastFiredDay !== day) {
      lastFiredDay = day
      runOnce(cfg)
    }
  }, 60_000)
  if (timer.unref) timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'persona-distill: 每日定时器')

  log(`已挂载（家=${dshHome()}）`)
}

let userCfg = DEFAULTS
