/**
 * dsh-naiwa-widget —— 宿主侧插件（奶娃余额挂件）
 *
 * 职责：
 *   ① 把前端挂件脚本注入 DSH Web 的 index.html（tapIndex），并提供全部路由；
 *   ② 从 DSH 凭据服务读 DEEPSEEK_API_KEY，拉取 DeepSeek 余额（带缓存 / 去重 / 瞬时失败回退）；
 *   ③ 用「余额观测」推算今日已用（免令牌记账）+ 按真实 token usage 结算每轮消耗；
 *   ④ 暴露当前对话的活动状态（思考中 / 等待提问 / 等待授权 / 空闲），供奶娃做表情与提示。
 *
 * 设计要点（都是踩过坑的结论）：
 *   - 所有路由必须自己套一层「本机来源」校验：写操作（PUT）只接受回环地址。
 *   - 任何路由都必须返回 200 + JSON，绝不悬挂；前端因此可以无脑重试。
 *   - 前端 widget.js 按 mtime 热读，改了只要硬刷新页面，不用重启 dsh web。
 *   - 宿主 index.js 改动必须重启 dsh web 才生效。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const ROUTE_PREFIX = '/dsh-naiwa'

const ASSET_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'naiwa.png'),
  path.join(HERE, 'naiwa.png'),
]
const WIDGET_FILE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'naiwa-widget.js'),
  path.join(HERE, 'naiwa-widget.js'),
]
const CONFIG_FILE = path.join(DSH_HOME, '.dshnw-config.json')

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25_000
const BALANCE_TIMEOUT_MS = 8_000

// 峰谷定价（元 / 百万 token，[空闲, 高峰]），官方调价时改这里
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-pro': PRO_PRICE,
}

const DEFAULT_CONFIG = {
  scale: 1.35,
  sound: true,
  bubbleOn: true,
  snap: true,
  turnCostOn: true,
  turnCostCloseSec: 6,
  todayUsageEpoch: null,
  // 余额预警：余额低于该值时奶娃变哭脸 + 弹提醒（0 = 关闭）
  warnBelow: 5,
  // 今日预算：当日已用达到该值时奶娃气鼓鼓 + 弹提醒（0 = 关闭）
  budget: 2,
  // 预算按「余额下降差值」算：budgetBase 是起算时的余额快照
  budgetBase: null,
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// ---------------------------------------------------------------- 小工具

function bjParts(timeSec) {
  const d = new Date((timeSec + 8 * 3600) * 1000)
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    ymd: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    monthDay: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
  }
}

function isValleyToday(timeSec) {
  const p = bjParts(timeSec)
  return p.weekday === 0 || p.weekday === 6
}

function isPeakTime(timeSec) {
  if (isValleyToday(timeSec)) return false
  const p = bjParts(timeSec)
  const hm = p.hour + p.minute / 60
  return PEAK_HOURS.some(([a, b]) => hm >= a && hm < b)
}

function nextPeakChangeAt(timeSec) {
  const p = bjParts(timeSec)
  const hm = p.hour + p.minute / 60
  if (isValleyToday(timeSec)) return { at: null, to: 'peak', label: '周末全天谷价' }
  const edges = [9, 12, 14, 18]
  for (const edge of edges) {
    if (hm < edge) {
      const now = new Date(timeSec * 1000)
      const bjMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 8 * 3600 * 1000
      const target = (bjMidnightUtc + edge * 3600 * 1000) / 1000
      return { at: target, to: isPeakTime(target + 60) ? 'peak' : 'valley', label: '' }
    }
  }
  const now = new Date(timeSec * 1000)
  const bjMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 8 * 3600 * 1000
  return { at: (bjMidnightUtc + 24 * 3600 * 1000 + 9 * 3600 * 1000) / 1000, to: 'peak', label: '' }
}

function priceFor(model) {
  const id = String(model || '').toLowerCase()
  return PRICING[id] || BASE_PRICE
}

function loadJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function isLoopbackHost(hostHeader) {
  try {
    const host = new URL('http://' + String(hostHeader || ''))
    const hn = host.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hn === 'localhost' || hn.endsWith('.localhost') || hn === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hn)
    if (!m) return false
    return Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
  } catch (err) {
    return false
  }
}

// ---------------------------------------------------------------- 插件本体

export const name = 'dsh-naiwa-widget'
export const inject = ['webServer', 'credentials']

export function apply(ctx) {
  const disposers = []

  // ---------------- 配置持久化 ----------------
  let config = Object.assign({}, DEFAULT_CONFIG, loadJsonFile(CONFIG_FILE) || {})
  function saveConfig() {
    try {
      atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2))
      return true
    } catch (err) {
      ctx.logger?.warn?.('奶娃挂件：配置写入失败 %s', String((err && err.message) || err))
      return false
    }
  }

  // ---------------- 今日已用（余额观测记账，免令牌） ----------------
  const usage = {
    date: null,
    lastBalance: null,
    lastCurrency: null,
    todayUsage: 0,
    rechargePending: 0,
    startedAt: null,
    history: {},
  }

  function observeBalance(totalBalance, currency) {
    const today = bjParts(Math.floor(Date.now() / 1000)).ymd
    // 跨天：归档昨日，当日归零
    if (usage.date && usage.date !== today) {
      usage.history[usage.date] = Number(usage.todayUsage.toFixed(6))
      const days = Object.keys(usage.history).sort()
      while (days.length > 30) delete usage.history[days.shift()]
      usage.todayUsage = 0
      usage.rechargePending = 0
      usage.startedAt = null
      usage.date = today
      usage.lastBalance = totalBalance
      usage.lastCurrency = currency
      return
    }
    if (!usage.date) {
      usage.date = today
      usage.lastBalance = totalBalance
      usage.lastCurrency = currency
      usage.startedAt = Date.now()
      return
    }
    // 币种切换只重置基准（否则会把汇率跳变记成一笔消费）
    if (usage.lastCurrency && currency && usage.lastCurrency !== currency) {
      usage.lastBalance = totalBalance
      usage.lastCurrency = currency
      usage.startedAt = Date.now()
      return
    }
    const prev = usage.lastBalance
    if (typeof prev === 'number' && Number.isFinite(prev)) {
      const delta = prev - totalBalance
      if (delta > 0) usage.todayUsage = Number((usage.todayUsage + delta).toFixed(8))
      else if (delta < 0) usage.rechargePending = Number((usage.rechargePending + -delta).toFixed(8))
    }
    usage.lastBalance = totalBalance
    usage.lastCurrency = currency
  }

  // ---------------- 余额拉取 ----------------
  let balanceCache = null
  let balanceInFlight = null

  function pickBalanceInfo(infos) {
    if (!Array.isArray(infos) || infos.length === 0) return null
    const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
    return (
      infos.find((x) => x && String(x.currency).toUpperCase() === 'CNY' && num(x) > 0) ||
      infos.find((x) => num(x) > 0) ||
      infos.find((x) => x && String(x.currency).toUpperCase() === 'CNY') ||
      infos[0]
    )
  }

  async function fetchViaApiKey() {
    let cred = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
        break
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 600))
          continue
        }
        return { ok: false, code: 'NO_KEY', error: '凭据读取失败：' + String((err && err.message) || err).slice(0, 160) }
      }
    }
    if (!cred || !cred.value) return null // 交给账号态路径

    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
      try {
        res = await fetch(BALANCE_URL, {
          headers: { Authorization: 'Bearer ' + cred.value },
          signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
        })
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status)
        if (res.status < 500) break
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      let data
      try {
        data = await res.json()
      } catch (err) {
        return { ok: false, code: 'PARSE', error: '余额接口返回的不是合法 JSON' }
      }
      const info = pickBalanceInfo(data && data.balance_infos)
      if (!info || !Number.isFinite(Number(info.total_balance))) {
        return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
      }
      return {
        ok: true,
        totalBalance: Number(info.total_balance),
        currency: String(info.currency || 'CNY').toUpperCase(),
        source: 'apikey',
      }
    }
    return {
      ok: false,
      code: 'HTTP',
      transient: !(lastErr && /^HTTP 4\d\d/.test(String(lastErr.message))),
      error: '余额接口请求失败：' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
    }
  }

  // DSH 账号登录态（没有 API key 时才会走到这里）：只调 DSH 自己的服务，插件不碰账号令牌
  async function fetchViaAccount() {
    let account = null
    try {
      account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
    } catch (err) {
      account = null
    }
    if (!account || typeof account.getBalance !== 'function') return null
    let result
    try {
      result = await account.getBalance({
        version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
        locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
    } catch (err) {
      return null
    }
    if (!result || result.status !== 'ready' || !Array.isArray(result.value) || result.value.length === 0) return null
    const num = (v) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const wallets = result.value.filter((w) => w && num(w.balance) !== null)
    if (wallets.length === 0) return null
    const currency = wallets.some((w) => String(w.currency || '').toUpperCase() === 'CNY')
      ? 'CNY'
      : String((wallets[0] && wallets[0].currency) || 'CNY').toUpperCase()
    const total = wallets
      .filter((w) => String(w.currency || 'CNY').toUpperCase() === currency)
      .reduce((s, w) => s + Number(w.balance), 0)
    return { ok: true, totalBalance: Number(total.toFixed(6)), currency, source: 'account' }
  }

  async function getBalance(force) {
    const now = Date.now()
    if (!force && balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.payload
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = (async () => {
      try {
        let payload = await fetchViaApiKey()
        if (!payload) payload = await fetchViaAccount()
        if (!payload) {
          payload = {
            ok: false,
            code: 'NO_KEY',
            error: '未配置 DEEPSEEK_API_KEY，且账号余额不可用（未登录 DeepSeek 账号，或该账号没有余额钱包）',
          }
        }
        if (payload.ok) {
          observeBalance(payload.totalBalance, payload.currency)
          balanceCache = { at: Date.now(), payload }
        } else if (payload.transient && balanceCache) {
          // 瞬时网络抖动：沿用最近一次成功值，不闪错误
          return Object.assign({}, balanceCache.payload, {
            stale: true,
            staleReason: payload.error,
            updatedAt: balanceCache.payload.updatedAt,
          })
        }
        return payload
      } catch (err) {
        if (balanceCache) {
          return Object.assign({}, balanceCache.payload, {
            stale: true,
            staleReason: String((err && err.message) || err).slice(0, 200),
          })
        }
        return { ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) }
      } finally {
        balanceInFlight = null
      }
    })()
    return balanceInFlight
  }

  async function getBalancePayload(force) {
    const payload = await getBalance(force)
    const nowSec = Math.floor(Date.now() / 1000)
    const peak = isPeakTime(nowSec)
    const change = nextPeakChangeAt(nowSec)
    const today = bjParts(nowSec).ymd

    // 「还能聊多少轮」：余额 / 本机平均每轮花费
    const avg = avgTurnCost()
    const roundsLeft = payload.ok && avg > 0 ? Math.max(0, Math.floor(payload.totalBalance / avg)) : null

    // 余额预警
    const warnBelow = Number(config.warnBelow) || 0
    const warn = {
      below: warnBelow,
      enabled: warnBelow > 0,
      active: !!(warnBelow > 0 && payload.ok && payload.totalBalance < warnBelow),
    }

    // 今日预算：按「余额下降差值」算（budgetBase 是起算快照）
    const budget = Number(config.budget) || 0
    const budgetBase = Number(config.budgetBase)
    const spent = budget > 0 && Number.isFinite(budgetBase) && payload.ok
      ? Math.max(0, budgetBase - payload.totalBalance)
      : null

    return Object.assign({}, payload, {
      usage: payload.ok
        ? {
            mode: 'ledger',
            todayUsage: Number(usage.todayUsage.toFixed(6)),
            date: today,
            startedAt: usage.startedAt,
            rechargePending: Number(usage.rechargePending.toFixed(6)),
          }
        : null,
      // 近 7 天（含今天）逐日已用，给脚边迷你柱状图用；单独请求时也可通过 /usage.json 拿
      daily: dailyUsage(7),
      warn,
      budget: {
        limit: budget,
        enabled: budget > 0,
        base: Number.isFinite(budgetBase) ? budgetBase : null,
        spent: spent === null ? null : Number(spent.toFixed(6)),
        ratio: budget > 0 && spent !== null ? Math.min(1.5, spent / budget) : null,
        exceeded: !!(budget > 0 && spent !== null && spent >= budget),
      },
      // 「这些钱还能和奶娃聊多少轮」
      rounds: { avg: Number(avg.toFixed(6)), left: roundsLeft, sampled: recentTurnAmounts.length },
      peak: {
        isPeak: peak,
        label: peak ? '高峰时段' : (isValleyToday(nowSec) ? '周末谷价' : '空闲时段'),
        nextChangeAt: change.at,
        nextTo: change.to,
        note: change.label,
      },
      updatedAt: new Date().toISOString(),
    })
  }

  // ---------------- 每轮对话消耗 + 当前活动状态 ----------------
  let lastTurn = null
  let lastTurnSeq = 0
  const turnAggs = new Map()
  const activity = { state: 'idle', label: '', at: Date.now(), turn: null }
  // 最近若干轮的金额，用来估算「余额还能聊多少轮」
  const recentTurnAmounts = []

  function setActivity(state, label) {
    if (activity.state === state && activity.label === label) return
    activity.state = state
    activity.label = label
    activity.at = Date.now()
  }

  function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    if (agg && agg.cost > 0) {
      lastTurn = {
        seq: ++lastTurnSeq,
        turn: agg.turn,
        amount: Number(agg.cost.toFixed(6)),
        tokens: agg.tokens,
        model: agg.model,
        ts: Date.now(),
      }
      recentTurnAmounts.push(lastTurn.amount)
      while (recentTurnAmounts.length > 20) recentTurnAmounts.shift()
    }
    turnAggs.delete(sessionId)
  }

  // 本机平均每轮花费：优先用最近 20 轮的真实结算，退回到按今日口径估算
  function avgTurnCost() {
    if (recentTurnAmounts.length) {
      return recentTurnAmounts.reduce((a, b) => a + b, 0) / recentTurnAmounts.length
    }
    const today = bjParts(Math.floor(Date.now() / 1000)).ymd
    if (usage.date === today && usage.todayUsage > 0) return usage.todayUsage / 20
    // 没有任何样本时给一个「参考量级」：约等于一次 300k 命中缓存输入 + 4k 输出
    const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
    return (300000 / 1e6) * BASE_PRICE.hit[off] + (4000 / 1e6) * BASE_PRICE.out[off]
  }

  // 近 N 天的已用金额（含今天），用于脚边迷你柱状图
  function dailyUsage(days) {
    const nowSec = Math.floor(Date.now() / 1000)
    const today = bjParts(nowSec).ymd
    const out = []
    for (let i = days - 1; i >= 0; i--) {
      const p = bjParts(nowSec - i * 86400)
      out.push({
        date: p.ymd,
        label: String(Number(p.ymd.slice(5, 7))) + '/' + String(Number(p.ymd.slice(8, 10))),
        weekday: ['日', '一', '二', '三', '四', '五', '六'][p.weekday],
        amount: p.ymd === today ? Number(usage.todayUsage.toFixed(6)) : Number((usage.history[p.ymd] || 0).toFixed(6)),
        isToday: p.ymd === today,
      })
    }
    return out
  }

  function handleSessionEvent(session, event) {
    try {
      const type = event && event.type
      const d = event && event.data
      const sessionId = (session && session.id) || 'default'
      if (type === 'turn/start') {
        setActivity('thinking', '奶娃正在思考…')
        return
      }
      if (type === 'turn/end') {
        finalizeTurn(sessionId)
        setActivity('idle', '')
        return
      }
      if (!d || typeof d !== 'object') return

      // 等待用户交互：提问 / 授权
      if (type === 'tool/call') {
        const toolName = String(d.name || d.toolName || '')
        if (toolName === 'ask_user_question') {
          setActivity('waiting', '奶娃在等你回答…')
        }
        return
      }
      if (type === 'tool/result') {
        if (activity.state === 'waiting') setActivity('thinking', '奶娃正在思考…')
        return
      }
      if (type === 'approval/asked') {
        setActivity('waiting', '奶娃在等你授权…')
        return
      }
      if (type.indexOf && type.indexOf('approval/') === 0) {
        if (activity.state === 'waiting') setActivity('thinking', '奶娃正在思考…')
        return
      }

      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      const u = d.usage
      if (!u || typeof u !== 'object' || !Number.isFinite(turn)) return
      let agg = turnAggs.get(sessionId)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(sessionId)
        agg = { turn, cost: 0, tokens: 0, model: '' }
        turnAggs.set(sessionId, agg)
      }
      const input = Number(u.inputTokens) || 0
      const cache = Number(u.cacheReadTokens) || 0
      const output = Number(u.outputTokens) || 0 // DSH 保证 reasoningTokens ⊆ outputTokens，不重复计
      const model = (d.message && d.message.source && d.message.source.model) || ''
      const p = priceFor(model)
      const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
      agg.cost += (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
      agg.tokens += input + cache + output
      if (model) agg.model = model
    } catch (err) {
      /* 会话事件处理绝不外抛 */
    }
  }

  // ---------------- 静态资源（按 mtime 热读） ----------------
  let imageCache = null
  let widgetCache = null

  function loadAssetImage() {
    for (const p of ASSET_CANDIDATES) {
      try {
        const st = fs.statSync(p)
        if (imageCache && imageCache.mtimeMs === st.mtimeMs) return imageCache.bytes
        const bytes = fs.readFileSync(p)
        imageCache = { bytes, mtimeMs: st.mtimeMs }
        return bytes
      } catch (err) {
        /* 试下一个候选路径 */
      }
    }
    if (imageCache) return imageCache.bytes
    throw new Error('naiwa.png 未找到（插件包的 assets/ 不完整）')
  }

  function loadWidgetJs() {
    for (const p of WIDGET_FILE_CANDIDATES) {
      try {
        const st = fs.statSync(p)
        if (widgetCache && widgetCache.mtimeMs === st.mtimeMs) return widgetCache.text
        const text = fs.readFileSync(p, 'utf8')
        widgetCache = { text, mtimeMs: st.mtimeMs }
        return text
      } catch (err) {
        /* 试下一个候选路径 */
      }
    }
    return widgetCache ? widgetCache.text : ''
  }

  // ---------------- 信任栅栏 ----------------
  // 读接口允许局域网访问（和参考实现一致）；写接口只接受本机回环来源。
  function rejectIfUntrusted(req, res, write) {
    const headers = (req && req.headers) || {}
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') {
      res.writeHead(403, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'cross-site 请求被拒绝' }))
      return true
    }
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      try {
        const o = new URL(origin)
        if (o.host !== headers.host) {
          res.writeHead(403, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'Origin 与 Host 不同源' }))
          return true
        }
      } catch (err) {
        res.writeHead(403, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'Origin 非法' }))
        return true
      }
    }
    if (write && !isLoopbackHost(headers.host)) {
      res.writeHead(403, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: '写操作只能来自本机（127.0.0.1 / localhost）' }))
      return true
    }
    return false
  }

  function register(route, write) {
    return ctx.webServer.register(Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejectIfUntrusted(req, res, write)) return
        try {
          return await route.handler(req, res)
        } catch (err) {
          if (!res.headersSent) res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))
  }

  // ---------------- 路由 ----------------

  disposers.push(register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/naiwa.png`,
    handler: (req, res) => {
      const bytes = loadAssetImage()
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/widget.js`,
    handler: (req, res) => {
      const js = loadWidgetJs()
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(js)),
      })
      res.end(js)
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/balance.json`,
    handler: async (req, res) => {
      const force = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
      const payload = await getBalancePayload(force)
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/turn.json`,
    handler: (req, res) => {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, seq: lastTurnSeq, turn: lastTurn, activity: { state: activity.state, label: activity.label } }))
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/config.json`,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(Object.assign({ ok: true }, config)))
        return
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await new Promise((resolve) => {
          let raw = ''
          req.on('data', (c) => {
            raw += c
            if (raw.length > 64 * 1024) req.destroy()
          })
          req.on('end', () => resolve(raw))
        })
        let parsed = null
        try {
          parsed = JSON.parse(body || '{}')
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
          return
        }
        const next = Object.assign({}, config)
        if (typeof parsed.scale === 'number' && parsed.scale >= 0.5 && parsed.scale <= 2.6) next.scale = parsed.scale
        for (const k of ['sound', 'bubbleOn', 'snap', 'turnCostOn']) {
          if (typeof parsed[k] === 'boolean') next[k] = parsed[k]
        }
        if (typeof parsed.turnCostCloseSec === 'number' && parsed.turnCostCloseSec >= 0 && parsed.turnCostCloseSec <= 120) {
          next.turnCostCloseSec = Math.round(parsed.turnCostCloseSec)
        }
        if (parsed.todayUsageEpoch !== undefined) next.todayUsageEpoch = parsed.todayUsageEpoch
        // 余额预警阈值（0 = 关闭）。按「分」取整，不做整元取整 ——
        // 否则填 0.001 这种小额会被抹成 0（= 关闭），预算同理。
        if (typeof parsed.warnBelow === 'number' && parsed.warnBelow >= 0 && parsed.warnBelow <= 100000) {
          next.warnBelow = Math.round(parsed.warnBelow * 100) / 100
        }
        // 今日预算（0 = 关闭）。设定 / 改预算时，把当前余额快照记成起算基准。
        let budgetRebased = false
        // 基准余额：优先用记账观测值，退回最近一次成功的余额缓存
        const baseBalance = Number.isFinite(usage.lastBalance)
          ? usage.lastBalance
          : (balanceCache && balanceCache.payload && balanceCache.payload.ok ? balanceCache.payload.totalBalance : null)
        if (typeof parsed.budget === 'number' && parsed.budget >= 0 && parsed.budget <= 100000) {
          const nb = Math.round(parsed.budget * 100) / 100
          if (nb !== config.budget || parsed.rebaseBudget === true) {
            next.budget = nb
            if (nb > 0 && Number.isFinite(baseBalance)) {
              next.budgetBase = baseBalance
              budgetRebased = true
            } else if (nb === 0) {
              next.budgetBase = null
            }
          }
        }
        if (parsed.rebaseBudget === true && next.budget > 0 && Number.isFinite(baseBalance)) {
          next.budgetBase = baseBalance
          budgetRebased = true
        }
        const changedKeys = Object.keys(next).filter((k) => next[k] !== config[k])
        config = next
        const saved = saveConfig()
        // 校正记账起点（「今日已用」以本次观测为零点重新起算）
        if (parsed.resetUsage === true) {
          usage.todayUsage = 0
          usage.rechargePending = 0
          usage.startedAt = Date.now()
          if (usage.lastBalance !== null) config.todayUsageEpoch = new Date().toISOString()
          const rb = Number.isFinite(usage.lastBalance)
            ? usage.lastBalance
            : (balanceCache && balanceCache.payload && balanceCache.payload.ok ? balanceCache.payload.totalBalance : null)
          if (config.budget > 0 && Number.isFinite(rb)) config.budgetBase = rb
          saveConfig()
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(Object.assign({ ok: true, saved, changed: changedKeys, budgetRebased }, config)))
        return
      }
      res.writeHead(405, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    },
  }, true))

  disposers.push(register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/usage.json`,
    handler: (req, res) => {
      const days = Math.min(30, Math.max(2, Number(new URL(req.url || '/', 'http://localhost').searchParams.get('days')) || 7))
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        ok: true,
        days: dailyUsage(days),
        todayUsage: Number(usage.todayUsage.toFixed(6)),
        date: usage.date,
        startedAt: usage.startedAt,
        rechargePending: Number(usage.rechargePending.toFixed(6)),
        budgetBase: Number.isFinite(config.budgetBase) ? config.budgetBase : null,
      }))
    },
  }))

  disposers.push(register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/health.json`,
    handler: (req, res) => {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        ok: true,
        plugin: name,
        version: '0.1.0',
        hasWidgetJs: loadWidgetJs().length > 0,
        hasImage: (() => {
          try {
            return loadAssetImage().length > 0
          } catch (err) {
            return false
          }
        })(),
        configFile: CONFIG_FILE,
      }))
    },
  }))

  // ---------------- 注入钩子 ----------------
  // ① 会话事件（每轮消耗 / 活动状态）
  disposers.push(ctx.on('session/event', (session, event) => handleSessionEvent(session, event)))
  disposers.push(ctx.on('session/disposed', (session) => {
    if (session && session.id) turnAggs.delete(session.id)
  }))

  // ② index.html 注入（Web 形态）
  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf(`${ROUTE_PREFIX}/widget.js`) !== -1) return html
    const tag = `<script defer src="${ROUTE_PREFIX}/widget.js"></script>`
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  // ③ 桌面端（Electron）结构化注入行：内联 script，加载失败静默，绝不让宿主起不来
  disposers.push(ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script-src' && row.src === `${ROUTE_PREFIX}/widget.js`) return
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(`${ROUTE_PREFIX}/widget.js`) >= 0) return
      }
      table.push({
        kind: 'script',
        placement: 'body',
        text:
          '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
          `var s=document.createElement("script");s.src="${ROUTE_PREFIX}/widget.js";` +
          's.onerror=function(){};d.appendChild(s)}catch(e){}})()',
      })
    } catch (err) {
      /* 注入失败不影响宿主 */
    }
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d()
      } catch (err) {
        /* 忽略单个 disposer 的失败 */
      }
    }
  })
}

export default { name, inject, apply }
