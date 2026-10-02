/**
 * 离线自检：把宿主插件装进一个假的 Cordis ctx（真实的 node:http 服务器 + 假的凭据服务），
 * 然后逐条请求所有路由，验证：
 *   ① 每条路由都注册成功、返回 200 且是合法 JSON；
 *   ② 余额能从 DEEPSEEK_API_KEY 真实取到（或给出明确错误码）；
 *   ③ 今日已用记账 / 每轮消耗结算 / 活动状态 三件事真的在跑；
 *   ④ config PUT 能落盘，且非本机来源的写请求被 403 拒绝。
 *
 * 用法（不会碰你的 DSH profile，也不用重启 dsh web）：
 *   DSH_HOME=/tmp/naiwa-selftest node tools/selftest.mjs
 * 退出码 0 = 全部通过。
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`)
}

// —— 假 ctx：只实现插件用到的那几个 API ——
const routes = []
const listeners = new Map()
const disposers = []
const logs = []
let indexTap = null

const fakeCtx = {
  logger: {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    tapIndex(fn) {
      indexTap = fn
      return () => {
        indexTap = null
      }
    },
  },
  credentials: {
    async resolve(ref) {
      if (ref !== 'DEEPSEEK_API_KEY') return undefined
      const fromEnv = process.env.SELFTEST_FAKE_KEY
      if (fromEnv === 'none') return undefined
      if (fromEnv) return { value: fromEnv, source: 'selftest' }
      // 默认读本机真实凭据（只读，不外传）
      try {
        const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
        const m = /^DEEPSEEK_API_KEY:\s*(.+)$/m.exec(text)
        if (!m) return undefined
        return { value: m[1].trim().replace(/^['"]|['"]$/g, ''), source: 'selftest' }
      } catch (err) {
        return undefined
      }
    },
  },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
    return () => {
      const list = listeners.get(event) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
}

function emit(event, ...args) {
  for (const fn of listeners.get(event) || []) fn(...args)
}

// —— 启动 ——
const mod = await import('../lib/index.js')
mod.apply(fakeCtx)

console.log('\n[1] 路由注册')
check('注册了 7 条路由', routes.length === 7, '实际 ' + routes.length + '：' + routes.map((r) => r.path).join(', '))
check('已挂 tapIndex 注入钩子', typeof indexTap === 'function')
check('已挂 session/event 监听', (listeners.get('session/event') || []).length === 1)

// —— 起一个真实 HTTP 服务器，把请求分发给插件的 handler ——
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'))
  const route = routes.find((r) => r.kind === 'exact' && r.path === url.pathname)
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no route' }))
    return
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(err && err.message))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

async function get(pathname, init) {
  const res = await fetch(base + pathname, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (err) {
    /* 非 JSON（图片/JS） */
  }
  return { status: res.status, text, json, headers: res.headers }
}

console.log('\n[2] 静态资源')
const png = await get('/dsh-naiwa/naiwa.png')
check('GET /dsh-naiwa/naiwa.png → 200 image/png', png.status === 200 && png.headers.get('content-type') === 'image/png', `${png.text.length} bytes`)
const pngMagic = png.text.slice(1, 4) === 'PNG'
check('返回的是真 PNG（魔数校验）', pngMagic)

const js = await get('/dsh-naiwa/widget.js')
check('GET /dsh-naiwa/widget.js → 200 JS', js.status === 200 && (js.headers.get('content-type') || '').includes('javascript'), `${js.text.length} bytes`)
check('widget.js 内容完整（IIFE + 幂等守卫 + 路由常量）', js.text.includes('__dshNaiwaWidget') && js.text.includes("PREFIX = '/dsh-naiwa'") && js.text.includes('/balance.json'))

console.log('\n[3] health / config')
const health = await get('/dsh-naiwa/health.json')
check('GET health.json → ok', health.status === 200 && health.json?.ok === true, JSON.stringify(health.json))
check('health 报告资源齐全', health.json?.hasWidgetJs === true && health.json?.hasImage === true)

const cfg0 = await get('/dsh-naiwa/config.json')
check('GET config.json → 默认值', cfg0.status === 200 && typeof cfg0.json?.scale === 'number', JSON.stringify({ scale: cfg0.json?.scale, sound: cfg0.json?.sound }))

const cfgPut = await get('/dsh-naiwa/config.json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
  body: JSON.stringify({ scale: 1.8, sound: false, turnCostCloseSec: 9 }),
})
check('PUT config.json → 写盘成功', cfgPut.status === 200 && cfgPut.json?.ok === true && cfgPut.json?.saved === true && cfgPut.json?.scale === 1.8, `scale=${cfgPut.json?.scale} sound=${cfgPut.json?.sound}`)
const cfgFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.dshnw-config.json')
check('配置真的落盘了', fs.existsSync(cfgFile), cfgFile)
check('非法值被拒绝（scale 超范围不写入）', (await get('/dsh-naiwa/config.json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
  body: JSON.stringify({ scale: 99 }),
})).json?.scale === 1.8)

console.log('\n[4] 写请求来源校验（信任栅栏）')
// 注意：Node 的 fetch 会**忽略**手工设置的 Host 头（undici 不允许），
// 所以这里必须用 node:http 直连，才能真正伪造 Host。
function rawRequest({ pathname, method, host, body, headers }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: method || 'GET', headers: Object.assign({ Host: host }, headers || {}) },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const evil = await rawRequest({
  pathname: '/dsh-naiwa/config.json',
  method: 'PUT',
  host: 'evil.example.com',
  body: JSON.stringify({ scale: 2.0 }),
  headers: { 'Content-Type': 'application/json' },
})
check('伪造 Host 的 PUT → 403', evil.status === 403, 'HTTP ' + evil.status + ' ' + evil.text)

const localPut = await rawRequest({
  pathname: '/dsh-naiwa/config.json',
  method: 'PUT',
  host: `127.0.0.1:${port}`,
  body: JSON.stringify({ scale: 1.9 }),
  headers: { 'Content-Type': 'application/json' },
})
check('本机 Host 的 PUT → 200', localPut.status === 200, 'HTTP ' + localPut.status)

const crossSite = await rawRequest({
  pathname: '/dsh-naiwa/balance.json',
  host: `127.0.0.1:${port}`,
  headers: { 'Sec-Fetch-Site': 'cross-site' },
})
check('cross-site 标记 → 403', crossSite.status === 403, 'HTTP ' + crossSite.status)

const crossOrigin = await rawRequest({
  pathname: '/dsh-naiwa/config.json',
  method: 'PUT',
  host: `127.0.0.1:${port}`,
  body: '{}',
  headers: { Origin: 'http://attacker.test', 'Content-Type': 'application/json' },
})
check('Origin 与 Host 不同源 → 403', crossOrigin.status === 403, 'HTTP ' + crossOrigin.status)
// 恢复成自检用的值
await get('/dsh-naiwa/config.json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
  body: JSON.stringify({ scale: 1.8 }),
})

console.log('\n[5] 余额（真实网络请求）')
const bal = await get('/dsh-naiwa/balance.json')
if (bal.json?.ok) {
  check('GET balance.json → 拿到余额', Number.isFinite(bal.json.totalBalance), `${bal.json.currency} ${bal.json.totalBalance}（来源 ${bal.json.source}）`)
  check('附带 今日已用 / 峰谷 字段', !!bal.json.usage && !!bal.json.peak, `今日已用 ${bal.json.usage?.todayUsage} · ${bal.json.peak?.label}`)
} else {
  check('GET balance.json → 明确错误码（不是悬挂/500）', bal.status === 200 && !!bal.json?.code, `${bal.json?.code}: ${String(bal.json?.error).slice(0, 80)}`)
}
const balForce = await get('/dsh-naiwa/balance.json?refresh=1')
check('强制刷新也返回 200 JSON', balForce.status === 200 && typeof balForce.json === 'object')

console.log('\n[6] 每轮消耗 + 活动状态（模拟会话事件）')
const turn0 = await get('/dsh-naiwa/turn.json')
check('GET turn.json → 初始 seq=0', turn0.json?.seq === 0, JSON.stringify(turn0.json))

emit('session/event', { id: 'selftest-session' }, { type: 'turn/start', data: {} })
const thinking = (await get('/dsh-naiwa/turn.json')).json
check('turn/start → 活动状态变 thinking', thinking?.activity?.state === 'thinking', thinking?.activity?.label)

emit('session/event', { id: 'selftest-session' }, {
  type: 'assistant/message',
  data: {
    turn: 7,
    usage: { inputTokens: 12000, cacheReadTokens: 300000, outputTokens: 4500, reasoningTokens: 2000 },
    message: { source: { model: 'deepseek-flash' } },
  },
})
emit('session/event', { id: 'selftest-session' }, { type: 'turn/end', data: { turn: 7 } })
const turn1 = (await get('/dsh-naiwa/turn.json')).json
// 按北京时间自己算一遍峰谷，看看插件结算的金额对不对
function bj(timeSec) {
  const d = new Date((timeSec + 8 * 3600) * 1000)
  return { h: d.getUTCHours() + d.getUTCMinutes() / 60, wd: d.getUTCDay() }
}
const nowSec = Math.floor(Date.now() / 1000)
const { h, wd } = bj(nowSec)
const weekend = wd === 0 || wd === 6
const peak = !weekend && ((h >= 9 && h < 12) || (h >= 14 && h < 18))
const off = peak ? 1 : 0
const hitP = [0.02, 0.04][off]
const missP = [1, 2][off]
const outP = [4, 8][off]
const expected = (300000 / 1e6) * hitP + (12000 / 1e6) * missP + (4500 / 1e6) * outP
check('turn/end → seq 递增且结算出金额', turn1?.seq === 1 && turn1?.turn?.amount > 0, `seq=${turn1?.seq} amount=¥${turn1?.turn?.amount} tokens=${turn1?.turn?.tokens} model=${turn1?.turn?.model}`)
check(
  `金额与定价表一致（当前${peak ? '高峰' : '空闲'}价，±2%）`,
  turn1?.turn?.amount > 0 && Math.abs(turn1.turn.amount - expected) / expected < 0.02,
  `期望 ≈¥${expected.toFixed(4)}，实际 ¥${turn1?.turn?.amount}`,
)
check('turn/end → 活动状态回到 idle', turn1?.activity?.state === 'idle')
check('reasoningTokens 未被重复计费（tokens=3 项之和）', turn1?.turn?.tokens === 12000 + 300000 + 4500, 'tokens=' + turn1?.turn?.tokens)

emit('session/event', { id: 'selftest-session' }, { type: 'tool/call', data: { name: 'ask_user_question' } })
check('ask_user_question → waiting（奶娃等回答）', (await get('/dsh-naiwa/turn.json')).json?.activity?.state === 'waiting')
emit('session/event', { id: 'selftest-session' }, { type: 'tool/result', data: { callId: 'x' } })
check('tool/result → 回到 thinking', (await get('/dsh-naiwa/turn.json')).json?.activity?.state === 'thinking')

console.log('\n[7] 今日已用记账')
const afterObserve = (await get('/dsh-naiwa/balance.json')).json
check('余额观测后 usage 有统计起点', !!afterObserve?.usage && (afterObserve.usage.todayUsage >= 0), `todayUsage=${afterObserve?.usage?.todayUsage}`)

console.log('\n[7b] 新功能字段：还能聊多少轮 / 余额预警 / 今日预算 / 近 7 天')
const rich = (await get('/dsh-naiwa/balance.json')).json
check('返回「还能聊多少轮」', !!rich?.rounds && Number.isFinite(rich.rounds.avg) && rich.rounds.avg > 0, `avg=¥${rich?.rounds?.avg} left=${rich?.rounds?.left} 样本=${rich?.rounds?.sampled}`)
check('轮到数 = 余额 / 均价（±1 轮）', rich?.rounds?.left !== null && Math.abs(rich.rounds.left - Math.floor(rich.totalBalance / rich.rounds.avg)) <= 1, `${rich?.totalBalance} / ${rich?.rounds?.avg} → ${rich?.rounds?.left}`)
check('返回余额预警状态', !!rich?.warn && rich.warn.below === 5 && rich.warn.enabled === true, `阈值 ¥${rich?.warn?.below} active=${rich?.warn?.active}`)
check('返回今日预算状态', !!rich?.budget && rich.budget.limit === 2 && rich.budget.enabled === true, `预算 ¥${rich?.budget?.limit} 已花 ${rich?.budget?.spent} 比例 ${rich?.budget?.ratio}`)
check('返回近 7 天逐日已用', Array.isArray(rich?.daily) && rich.daily.length === 7 && rich.daily[6].isToday === true, (rich?.daily || []).map((d) => d.label + ':' + d.amount).join(' '))

const usageApi = await get('/dsh-naiwa/usage.json')
check('GET /dsh-naiwa/usage.json → 逐日数据', usageApi.status === 200 && usageApi.json?.ok && usageApi.json.days.length === 7, `${usageApi.json?.days?.length} 天`)
const usage30 = await get('/dsh-naiwa/usage.json?days=30')
check('usage.json 支持 days 参数', usage30.json?.days?.length === 30, usage30.json?.days?.length + ' 天')

console.log('\n[7c] 预警 / 预算阈值可配置')
const cfgWarn = await get('/dsh-naiwa/config.json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
  body: JSON.stringify({ warnBelow: 99999 }),
})
check('PUT warnBelow → 落盘', cfgWarn.json?.warnBelow === 99999, 'warnBelow=' + cfgWarn.json?.warnBelow)
const warned = (await get('/dsh-naiwa/balance.json')).json
check('余额低于阈值 → warn.active=true（奶娃变哭脸）', warned?.warn?.active === true, `余额 ${warned?.totalBalance} < 阈值 ${warned?.warn?.below}`)

// 预算基准取自「记账观测值」，所以要确保至少成功观测过一次余额
// （前面几次读的都是 25 秒 TTL 内的缓存，不会触发 observeBalance）
await get('/dsh-naiwa/balance.json?refresh=1')
await new Promise((r) => setTimeout(r, 300))

const cfgBudget = await get('/dsh-naiwa/config.json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
  body: JSON.stringify({ budget: 0.05, rebaseBudget: true }),
})
check('PUT budget + rebaseBudget → 记录基准余额', cfgBudget.json?.budgetBase === warned?.totalBalance && cfgBudget.json?.budgetRebased === true, `base=${cfgBudget.json?.budgetBase}（当前余额 ${warned?.totalBalance}）`)
const zeroed = (await get('/dsh-naiwa/balance.json')).json
check('刚重算基准时已花=0（不会误报超支）', zeroed?.budget?.spent === 0 && zeroed?.budget?.exceeded === false, `spent=${zeroed?.budget?.spent} exceeded=${zeroed?.budget?.exceeded}`)

await get('/dsh-naiwa/config.json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
  body: JSON.stringify({ warnBelow: 0, budget: 0 }),
})
const alertsOff = (await get('/dsh-naiwa/balance.json')).json
check('阈值设 0 → 两个提醒都关闭', alertsOff?.warn?.enabled === false && alertsOff?.budget?.enabled === false, `warn.enabled=${alertsOff?.warn?.enabled} budget.enabled=${alertsOff?.budget?.enabled}`)
const neg = await get('/dsh-naiwa/config.json', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
  body: JSON.stringify({ warnBelow: -5 }),
})
check('非法阈值被拒绝（负数不写入）', neg.json?.warnBelow === 0, 'warnBelow=' + neg.json?.warnBelow)

console.log('\n[8] index.html 注入')
const tap = indexTap
const html = tap('<!doctype html><html><body><div id="root"></div></body></html>')
check('tapIndex 注入了 widget.js script', html.includes('/dsh-naiwa/widget.js'), html.slice(-90))
check('tapIndex 幂等（第二次不再重复注入）', tap(html) === html)
check('tapIndex 兼容没有 </body> 的 html', tap('<html><div></div></html>').includes('/dsh-naiwa/widget.js'))

console.log('\n[9] 桌面端注入行')
const table = []
emit('webserver/index-inject', table)
check('推送了 script 行（且是内联 script，不是 script-src）', table.length === 1 && table[0].kind === 'script' && table[0].text.includes('/dsh-naiwa/widget.js'), JSON.stringify(table[0]?.kind))
check('注入行注册在 session/listener 之前的同一 apply 内（不会被延迟）', (listeners.get('webserver/index-inject') || []).length === 1, (listeners.get('webserver/index-inject') || []).length + ' 个监听')
const table2 = []
emit('webserver/index-inject', table2)
// DSH 每次收集会给一个新表；插进去的那一行由它自己交给页面侧应用，所以新表里应当有且仅有一行。
check('新表里插入且只插入一行', table2.length === 1, '行数=' + table2.length)
// 真正的去重语义是「同一张表里不插第二遍」—— 启动期 + 热重载可能对同一张表收集两次。
const tableSame = []
emit('webserver/index-inject', tableSame)
emit('webserver/index-inject', tableSame)
check('同一张表被收集两次也只插一行', tableSame.length === 1, '行数=' + tableSame.length)

server.close()
for (const d of disposers) d()

// —— 汇总 ——
const failed = results.filter((r) => !r.ok)
console.log(`\n=== 自检结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' — ' + f.detail : ''))
  process.exit(1)
}
console.log('全部通过 ✅')
