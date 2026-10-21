/**
 * dsh-persona-distill —— host 半端
 * ============================================================================
 * 把「原料 → 候选 → 人格」这条流水线插件化。
 *
 * 设计要点（2026-10-22 审查后加固）：
 *   1. **不假设用户装了任何东西**：只扫 `<家>/*\/source.json`，有原料才干活。
 *   2. **默认全开**：B站 / 微博 / 知乎三个已知源都探测，找到就问要不要接。
 *   3. **每天定时 + 补跑**：记「今天跑过没」到配置里，DSH 启动后 6 小时内会补。
 *   4. **手写段有硬保护**：跑前快照、跑后校验 HAND 段，变了就回滚。
 *   5. **单实例**：run.lock 防两个 headless 同时重写人格。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshHome, pluginHome, personaHome, agentsFile } from './lib/paths.mjs'
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
  persona: 'blank',
  model: 'deepseek-flash',
  dshBin: '',
  lastRun: '',
  lastResult: '',
  lastFiredDay: '', // 补跑判断用：今天跑过没有（存盘，不是内存）
}

const OVERLAY_HEADER = '# persona-distill overlay v2'
const OVERLAY_BODY = `# 蒸馏会话用的最小 overlay —— 只要账号和模型，不要 MCP
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

const LOCK_STALE_MS = 90 * 60 * 1000 // 90 分钟没动静就当陈旧，可抢占
const CATCHUP_WINDOW_MS = 6 * 3600 * 1000 // 只补 6 小时内的

// ---------------------------------------------------------------- 时间

/** 本地日期 YYYY-MM-DD（**不用 toISOString**，那是 UTC，东八区凌晨会错一天） */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时间戳 YYYY-MM-DD-HHmm */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${localDate(d)}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 把用户填的时间归一化成 HH:mm（容忍 4:10 / 04：10 / 带空格 / 04:10:00） */
function normalizeRunAt(s) {
  const t = String(s || '').trim().replace(/：/g, ':')
  const m = t.match(/^(\d{1,2})\s*:\s*(\d{1,2})/)
  if (!m) return '04:10'
  const h = Math.min(23, Math.max(0, Number(m[1])))
  const mi = Math.min(59, Math.max(0, Number(m[2])))
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
}

// ---------------------------------------------------------------- 配置

const cfgFile = () => join(pluginHome(), 'config.json')

function readCfg() {
  try {
    const raw = JSON.parse(readFileSync(cfgFile(), 'utf8'))
    return { ...DEFAULTS, ...raw, runAt: normalizeRunAt(raw.runAt) }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 写配置；失败时**不要**假装成功 */
function writeCfg(patch) {
  const next = { ...readCfg(), ...patch }
  next.runAt = normalizeRunAt(next.runAt)
  try {
    mkdirSync(pluginHome(), { recursive: true })
    writeFileSync(cfgFile(), JSON.stringify(next, null, 2), 'utf8')
    return { ok: true, config: next }
  } catch (e) {
    return { ok: false, config: next, error: `配置写不进去：${e?.message ?? e}` }
  }
}

// ---------------------------------------------------------------- 日志

function log(msg) {
  try {
    mkdirSync(pluginHome(), { recursive: true })
    const f = join(pluginHome(), 'run.log')
    try {
      if (existsSync(f) && statSync(f).size > 2 * 1024 * 1024) {
        rmSync(f + '.1', { force: true })
        copyFileSync(f, f + '.1')
        rmSync(f)
      }
    } catch { /* 轮转失败不拦着 */ }
    appendFileSync(f, `[${localStamp()}] ${msg}\n`, 'utf8')
  } catch { /* 日志写不了就算了 */ }
}

// ---------------------------------------------------------------- overlay

/** 每次都对一遍版本和模型 —— 改设置能生效，模板升级也能到老用户 */
function ensureOverlay(model) {
  const home = personaHome()
  mkdirSync(home, { recursive: true })
  const f = join(home, 'headless-overlay.yml')
  const want = OVERLAY_HEADER + '\n' + OVERLAY_BODY.replace('__MODEL__', model || 'deepseek-flash')
  try {
    if (existsSync(f)) {
      const cur = readFileSync(f, 'utf8')
      if (cur.trim() === want.trim()) return f
      const line = `    model: ${model || 'deepseek-flash'}`
      const next = cur.includes('# persona-distill overlay')
        ? cur.replace(/^(\s*model:\s*).*$/m, line)
        : want
      writeFileSync(f, next, 'utf8')
      return f
    }
    writeFileSync(f, want, 'utf8')
  } catch (e) {
    log(`overlay 写不进去：${e?.message ?? e}`)
  }
  return f
}

// ---------------------------------------------------------------- 手写段保护

function handSection(text) {
  const m = String(text).match(/<!-- HAND:BEGIN[^>]*-->([\s\S]*?)<!-- HAND:END -->/)
  return m ? m[1] : null
}

/** 跑之前快照 AGENTS.md */
function snapshotAgents() {
  const file = agentsFile()
  if (!existsSync(file)) return ''
  try {
    const dir = join(personaHome(), 'archive')
    mkdirSync(dir, { recursive: true })
    const dst = join(dir, `pre-${localStamp()}.md`)
    copyFileSync(file, dst)
    return dst
  } catch (e) {
    log(`快照失败：${e?.message ?? e}`)
    return ''
  }
}

/** 比对：HAND 段有没有被动手脚 */
export function verifyHand(before, after) {
  const b = handSection(before)
  const a = handSection(after)
  if (b === null) return { ok: true } // 本来就没有手写段，没什么可丢的
  if (a === null) return { ok: false, why: 'HAND 段整个不见了' }
  if (b.trim() !== a.trim()) return { ok: false, why: 'HAND 段内容被改了' }
  return { ok: true }
}

function restoreFrom(path) {
  try {
    if (path && existsSync(path)) {
      copyFileSync(path, agentsFile())
      return true
    }
  } catch (e) {
    log(`回滚失败：${e?.message ?? e}`)
  }
  return false
}

// ---------------------------------------------------------------- 单实例锁

const lockFile = () => join(pluginHome(), 'run.lock')

function acquireLock() {
  try {
    mkdirSync(pluginHome(), { recursive: true })
    const f = lockFile()
    if (existsSync(f)) {
      const started = Number(readFileSync(f, 'utf8')) || 0
      if (Date.now() - started < LOCK_STALE_MS) return false
      log('发现陈旧锁（超过 90 分钟），抢占')
    }
    writeFileSync(f, String(Date.now()), 'utf8')
    return true
  } catch {
    return false
  }
}

function releaseLock() {
  try { rmSync(lockFile(), { force: true }) } catch { /* 忽略 */ }
}

function isRunning() {
  try {
    if (!existsSync(lockFile())) return false
    const started = Number(readFileSync(lockFile(), 'utf8')) || 0
    return Date.now() - started < LOCK_STALE_MS
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 跑一次

function countPendingLines() {
  try {
    return readFileSync(join(personaHome(), 'pending.md'), 'utf8').split('\n').length
  } catch {
    return 0
  }
}

function runOnce(cfg, { manual = false } = {}) {
  if (!acquireLock()) {
    return { ok: false, error: '上一轮还在跑（或锁没释放），这次先跳过' }
  }

  try {
    ensurePersonaHome()
    ensureAgents({ ownerName: cfg.ownerName, heart: cfg.heart, identity: cfg.identity, persona: cfg.persona })

    const charter = join(personaHome(), 'distill.md')
    const overlay = ensureOverlay(cfg.model)
    const today = localDate()

    // 跑之前的基线（用来判断「到底有没有产出」）
    const agentsBefore = existsSync(agentsFile()) ? readFileSync(agentsFile(), 'utf8') : ''
    const snap = snapshotAgents()
    const pendingBefore = countPendingLines()
    const stateFile = join(personaHome(), 'state.json')
    const stateMtimeBefore = existsSync(stateFile) ? statSync(stateFile).mtimeMs : 0

    const prompt = `读 ${charter}，按它做今天的蒸馏。今天是 ${today}。做完在 ${join(personaHome(), 'run.log')} 追加一行。`
    const cmd = buildHeadlessCommand({ overlay, prompt })
    if (cmd.missing) {
      releaseLock()
      writeCfg({ lastRun: localStamp(), lastResult: '找不到 dsh CLI（可设置 DSH_BIN 环境变量）' })
      log('找不到 dsh CLI，蒸馏没跑起来')
      return { ok: false, error: '找不到 dsh CLI：请设置 DSH_BIN 环境变量后重启' }
    }

    log(`开始蒸馏${manual ? '（手动）' : ''}：${today}`)
    const child = spawn(cmd.command, cmd.args, {
      cwd: dshHome(),
      env: { ...process.env, ...cmd.env, DSH_HOME: dshHome() },
      windowsHide: true,
    })

    let out = ''
    let settled = false
    let spawnErr = ''

    const finish = (code) => {
      if (settled) return
      settled = true
      releaseLock()

      // 1) 手写段校验（最重要）
      let result = ''
      try {
        const after = existsSync(agentsFile()) ? readFileSync(agentsFile(), 'utf8') : ''
        const v = verifyHand(agentsBefore, after)
        if (!v.ok) {
          const ok = restoreFrom(snap)
          result = `⚠️ ${v.why}，${ok ? '已回滚到跑之前' : '回滚失败（快照在 archive）'}`
          log(`手写段异常：${v.why}；回滚=${ok}`)
        }
      } catch (e) {
        log(`校验手写段时出错：${e?.message ?? e}`)
      }

      // 2) 到底有没有产出
      if (!result) {
        const pendingAfter = countPendingLines()
        const stateMtimeAfter = existsSync(stateFile) ? statSync(stateFile).mtimeMs : 0
        const changed = pendingAfter !== pendingBefore || stateMtimeAfter !== stateMtimeBefore
        if (spawnErr) result = spawnErr
        else if (code === null) result = '进程异常结束（没有退出码）'
        else if (code !== 0) result = `exit=${code}`
        else if (!changed) result = '完成，但没有任何产出（看日志）'
        else result = '完成'
      }

      writeCfg({ lastRun: localStamp(), lastResult: result, lastFiredDay: localDate() })
      log(`执行完毕 exit=${code} · ${result}`)
    }

    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { out += d.toString() })
    child.on('error', (e) => {
      spawnErr = `启动失败：${e?.message ?? e}`
      log(spawnErr)
      finish(null)
    })
    child.on('close', (code) => {
      try { writeFileSync(join(pluginHome(), 'last-run.txt'), out, 'utf8') } catch { /* 忽略 */ }
      finish(code)
    })

    if (!child.pid) {
      finish(null)
      return { ok: false, error: '子进程没起来，看 run.log' }
    }
    return { ok: true, pid: child.pid }
  } catch (e) {
    releaseLock()
    const msg = `启动异常：${e?.message ?? e}`
    log(msg)
    writeCfg({ lastRun: localStamp(), lastResult: msg })
    return { ok: false, error: msg }
  }
}

// ---------------------------------------------------------------- 到点判断（含补跑）

function dueNow(cfg, now = new Date()) {
  if (!cfg.enabled) return false
  if (cfg.lastFiredDay === localDate(now)) return false
  const [h, m] = normalizeRunAt(cfg.runAt).split(':').map(Number)
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  if (now < target) return false
  if (now - target > CATCHUP_WINDOW_MS) return false // 太久了就不补，免得开机连跑一周
  return true
}

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res, code, obj) {
  if (res.headersSent || res.writableEnded) return
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = ''
    let size = 0
    let done = false
    const finish = (v) => { if (done) return; done = true; resolve(v) }
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); finish({}); return }
      data += c
    })
    req.on('end', () => {
      try { finish(data ? JSON.parse(data) : {}) } catch { finish({}) }
    })
    req.on('error', () => finish({}))
    req.on('aborted', () => finish({}))
  })
}

// ---------------------------------------------------------------- 插件入口

let cliCache = { v: null, at: 0 }

export function apply(ctx, config) {
  // 只在「用户已经开过」或「已经有面板」时补骨架 —— 不替用户凭空造人格
  try {
    const cfg = readCfg()
    if (cfg.enabled || existsSync(agentsFile())) {
      ensurePersonaHome()
      ensureAgents({ ownerName: cfg.ownerName, heart: cfg.heart, identity: cfg.identity, persona: cfg.persona })
    }
  } catch (e) {
    log(`初始化失败：${e?.message ?? e}`)
  }

  const handle = async (req, res, url) => {
    const path = url.pathname

    if (req.method === 'GET' && path === '/api/persona-distill/status') {
      const cfg = readCfg()
      if (Date.now() - cliCache.at > 5 * 60 * 1000) {
        cliCache = { v: !buildHeadlessCommand({ prompt: 'x' }).missing, at: Date.now() }
      }
      return sendJson(res, 200, {
        ok: true,
        config: cfg,
        sources: probeSources(),
        agents: readAgentsSections(),
        home: dshHome(),
        hasDsh: cliCache.v,
        running: isRunning(),
        dueNow: dueNow(cfg),
      })
    }

    if (req.method === 'GET' && path === '/api/persona-distill/probe') {
      return sendJson(res, 200, { ok: true, sources: probeSources() })
    }

    if (req.method === 'GET' && path === '/api/persona-distill/log') {
      const lines = Math.min(200, Math.max(10, Number(url.searchParams.get('lines')) || 60))
      try {
        const all = readFileSync(join(pluginHome(), 'run.log'), 'utf8').split('\n')
        return sendJson(res, 200, { ok: true, lines: all.slice(-lines) })
      } catch {
        return sendJson(res, 200, { ok: true, lines: [] })
      }
    }

    if (req.method === 'POST' && path === '/api/persona-distill/config') {
      const body = await readBody(req)
      const clean = {}
      if ('enabled' in body) clean.enabled = body.enabled === true || body.enabled === 'true'
      if ('runAt' in body) {
        const v = normalizeRunAt(body.runAt)
        if (!/^\d{2}:\d{2}$/.test(v)) return sendJson(res, 400, { ok: false, error: '时间格式要 HH:mm' })
        clean.runAt = v
      }
      if ('persona' in body) clean.persona = body.persona === 'clam' ? 'clam' : 'blank'
      for (const k of ['ownerName', 'heart', 'identity']) {
        if (k in body) clean[k] = String(body[k] ?? '').slice(0, 2000)
      }
      const r = writeCfg(clean)
      if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
      // 开了开关就补骨架（用户点了保存 = 同意生成）
      if (r.config.enabled) {
        try {
          ensurePersonaHome()
          ensureAgents({
            ownerName: r.config.ownerName, heart: r.config.heart,
            identity: r.config.identity, persona: r.config.persona,
          })
        } catch (e) { log(`保存后补骨架失败：${e?.message ?? e}`) }
      }
      return sendJson(res, 200, { ok: true, config: r.config })
    }

    if (req.method === 'POST' && path === '/api/persona-distill/run') {
      if (isRunning()) return sendJson(res, 200, { ok: false, error: '上一轮还在跑' })
      const r = runOnce(readCfg(), { manual: true })
      return sendJson(res, 200, r.ok ? r : { ok: false, error: r.error })
    }

    if (req.method === 'POST' && path === '/api/persona-distill/connect') {
      const body = await readBody(req)
      const id = String(body.id || '').trim()
      const rawDir = String(body.dir || `${id}-duty`).trim()
      // ⚠️ 只收单段目录名，挡住 ../ 和绝对路径
      if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(id)) return sendJson(res, 400, { ok: false, error: 'id 只能用字母数字和 -' })
      if (!/^[A-Za-z0-9._-]+$/.test(rawDir) || rawDir === '.' || rawDir === '..') {
        return sendJson(res, 400, { ok: false, error: '目录名不合法' })
      }
      const dir = join(dshHome(), rawDir)
      if (!resolve(dir).startsWith(resolve(dshHome()))) {
        return sendJson(res, 400, { ok: false, error: '目录必须在家目录里面' })
      }
      try {
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'source.json')
        if (!existsSync(file)) {
          writeFileSync(file, JSON.stringify({
            id, name: String(body.name || id), charter: 'duty.md',
            voice: 'voice.md', notes: 'notes.md', digestDir: 'digest',
            enabled: true, added: localDate(),
          }, null, 2), 'utf8')
        }
        const made = [file]
        const voiceF = join(dir, 'voice.md')
        if (!existsSync(voiceF)) {
          writeFileSync(voiceF, [
            `# 说话样本 · ${String(body.name || id)}`, '',
            '> 每轮往这里记：**原句 + 一句为什么好**。只学说法，不抄去发。',
            '> 格式：`- 「原句」—— 为什么好`', '',
            '（还没样本。装好对应的抓取工具后，它会自己往里写。）', '',
          ].join('\n'), 'utf8')
          made.push(voiceF)
        }
        const notesF = join(dir, 'notes.md')
        if (!existsSync(notesF)) {
          writeFileSync(notesF, [
            `# 想明白的事 · ${String(body.name || id)}`, '',
            '> 每轮最多 3 条。**写条件，别写口号**。',
            '> 格式：`- <日期> · 结论`', '',
            '（还没结论。）', '',
          ].join('\n'), 'utf8')
          made.push(notesF)
        }
        const digestDir = join(dir, 'digest')
        if (!existsSync(digestDir)) { mkdirSync(digestDir, { recursive: true }); made.push(digestDir) }
        return sendJson(res, 200, { ok: true, file, created: made })
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

  // ---- 每天定时 + 补跑（每分钟看一眼，整段包住，抛异常不会把 host 弄倒）----
  const timer = setInterval(() => {
    try {
      const cfg = readCfg()
      if (!dueNow(cfg)) return
      if (isRunning()) return
      log(`到点触发（${cfg.runAt}${cfg.lastFiredDay ? '，上次 ' + cfg.lastFiredDay : '，首次'}）`)
      runOnce(cfg)
    } catch (e) {
      log(`定时任务异常：${e?.message ?? e}`)
      try { writeCfg({ lastResult: `定时任务异常：${e?.message ?? e}` }) } catch { /* 忽略 */ }
    }
  }, 60_000)
  if (timer.unref) timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'persona-distill: 每日定时器')

  log(`已挂载（家=${dshHome()}，定时=${readCfg().runAt}）`)
}
