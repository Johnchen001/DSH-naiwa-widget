/**
 * 浏览器端真机自检：用无头 Chrome（CDP）真的打开一个页面、加载挂件脚本，
 * 然后验证：
 *   ① 挂件真的挂上了（DOM 结构 / 尺寸 / z-index）；
 *   ② 气泡里真的显示出了余额数字（不是「…」、不是错误）；
 *   ③ 拖拽会把奶娃移动到左边并触发镜像（dshnw-left）；
 *   ④ 贴边吸附把奶娃贴到左边缘；
 *   ⑤ 菜单能打开，改大小滑块后立绘真的变大；
 *   ⑥ 截图里真的画出了奶娃（对像素做统计分析，而不只是「没报错」）。
 *
 * 用法：
 *   DSH_HOME=/tmp/naiwa-selftest node tools/browser-check.mjs [--keep] [--shot out.png]
 * 退出码 0 = 全部通过。
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const KEEP = process.argv.includes('--keep')
const SHOT = (() => {
  const i = process.argv.indexOf('--shot')
  return i >= 0 ? process.argv[i + 1] : '/tmp/naiwa-shot.png'
})()

// 每次都从干净的配置/位置开始，否则上一次留下的 scale 会让断言失真
const STORE = process.env.DSH_HOME || path.join(os.tmpdir(), 'naiwa-browser-check')
try {
  fs.rmSync(path.join(STORE, '.dshnw-config.json'), { force: true })
} catch (err) {}
process.env.DSH_HOME = STORE

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  — ' + detail : ''}`)
}

// ---------------------------------------------------------------- 假 ctx + 真实路由分发（与 selftest 同构）
const routes = []
const listeners = new Map()
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex() {
      return () => {}
    },
  },
  credentials: {
    async resolve(ref) {
      if (ref !== 'DEEPSEEK_API_KEY') return undefined
      try {
        const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
        const m = /^DEEPSEEK_API_KEY:\s*(.+)$/m.exec(text)
        return m ? { value: m[1].trim().replace(/^['"]|['"]$/g, '') } : undefined
      } catch (err) {
        return undefined
      }
    },
  },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
    return () => {}
  },
  effect() {
    return () => {}
  },
}

const mod = await import('../lib/index.js')
mod.apply(fakeCtx)

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>奶娃挂件自检页</title>
<style>html,body{margin:0;height:100%;background:#f6f7fb;font-family:-apple-system,"PingFang SC",sans-serif}
.ghost{position:fixed;right:24px;bottom:18px;width:200px;height:200px;background:#e9edf7;border-radius:12px}</style>
</head><body>
<div class="ghost"></div>
<script defer src="/dsh-naiwa/widget.js"></script>
</body></html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'))
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  const route = routes.find((r) => r.kind === 'exact' && r.path === url.pathname)
  if (!route) {
    res.writeHead(404)
    res.end('nf')
    return
  }
  try {
    await route.handler(req, res)
  } catch (err) {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(err && err.message))
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const pageUrl = `http://127.0.0.1:${port}/`

// ---------------------------------------------------------------- 启动无头 Chrome + CDP
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naiwa-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--disable-extensions',
  '--disable-crashpad',
  '--disable-dev-shm-usage',
  // 在沙箱里跑 Chrome 必须再关掉它自己的沙箱，否则 "sandbox initialization failed"
  '--no-sandbox',
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=0',
  '--window-size=1280,800',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error('等待 Chrome DevTools 端口超时')), 25000)
  chrome.stderr.on('data', (c) => {
    buf += String(c)
    const m = /ws:\/\/[^\s]+/.exec(buf)
    if (m) {
      clearTimeout(timer)
      resolve(m[0])
    }
  })
  chrome.on('exit', (code) => {
    clearTimeout(timer)
    reject(new Error('Chrome 提前退出，code=' + code + '\n' + buf.slice(-500)))
  })
})

// 先连浏览器端点，只为拿到页面 target 的调试 WebSocket 地址
const browserWs = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  browserWs.addEventListener('open', res, { once: true })
  browserWs.addEventListener('error', rej, { once: true })
})

let msgId = 0
const pending = new Map()
const pageErrors = []
const cdpVerbose = process.argv.includes('--verbose')

// 每个连接一套 pending 表（浏览器端点与页面端点分开）
const browserPending = new Map()
let browserMsgId = 0
browserWs.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id !== undefined && browserPending.has(msg.id)) {
    const { resolve, reject } = browserPending.get(msg.id)
    browserPending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})

function browserSend(method, params) {
  const id = ++browserMsgId
  return new Promise((resolve, reject) => {
    browserPending.set(id, { resolve, reject })
    browserWs.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (browserPending.has(id)) {
        browserPending.delete(id)
        reject(new Error('CDP(浏览器端点) 超时: ' + method))
      }
    }, 20000)
  })
}

const { targetId } = await browserSend('Target.createTarget', { url: 'about:blank' })
// /json/list 是唯一会给出页面 target 的 webSocketDebuggerUrl 的地方
const httpBase = wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '')
const listRes = await fetch(`${httpBase}/json/list`)
const list = await listRes.json()
const pageTarget = list.find((t) => t.id === targetId) || list.find((t) => t.type === 'page')
if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
  throw new Error('拿不到页面 target 的调试 WebSocket：' + JSON.stringify(list.map((t) => [t.type, t.id])))
}
browserWs.close()

// 直连页面 target：不用 sessionId 转发，最稳
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (cdpVerbose && msg.id === undefined) console.log('  [CDP event]', msg.method)
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '))
  }
})

function send(method, params) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('CDP 超时: ' + method))
      }
    }, 30000)
  })
}

await send('Page.enable')
await send('Runtime.enable')

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

console.log('\n[0] 打开页面并等待挂件初始化')
await send('Page.navigate', { url: pageUrl })
await new Promise((r) => setTimeout(r, 2500))

console.log('\n[1] DOM 结构')
const dom = await evalJs(`(() => {
  const q = (s) => document.querySelector(s)
  const root = q('.dshnw-root')
  if (!root) return { missing: true, bodyKeys: Object.keys(document.body).length }
  const img = q('.dshnw-img'), bub = q('.dshnw-bubble'), btn = q('.dshnw-btn'), menu = q('.dshnw-menu')
  const cs = getComputedStyle(root)
  const rs = root.getBoundingClientRect()
  return {
    missing: false,
    hasImg: !!img, hasBubble: !!bub, hasBtn: !!btn, hasMenu: !!menu,
    imgNatural: img ? [img.naturalWidth, img.naturalHeight] : null,
    imgRect: img ? [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)] : null,
    imgComplete: img ? img.complete : null,
    position: cs.position, zIndex: cs.zIndex,
    rootRect: [Math.round(rs.left), Math.round(rs.top), Math.round(rs.width), Math.round(rs.height)],
    viewport: [innerWidth, innerHeight],
    bubbleHidden: bub ? !bub.classList.contains('dshnw-open') : null,
    closeToBottomRight: rs.right > innerWidth - 80 && rs.bottom > innerHeight - 80,
    styleInjected: !!document.getElementById('dshnw-style'),
    menuRows: menu ? menu.querySelectorAll('.dshnw-mrow').length : 0,
    menuChecks: menu ? menu.querySelectorAll('input[type=checkbox]').length : 0,
    menuButtons: menu ? menu.querySelectorAll('button[data-act]').length : 0,
  }
})()`)

check('挂件根节点已插入', !dom.missing)
check('立绘 <img> 已插入且图片真的加载成功', dom.hasImg && dom.imgComplete === true && dom.imgNatural?.[0] > 0, `natural=${dom.imgNatural} rendered=${dom.imgRect}`)
check('气泡 / 菜单按钮 / 菜单面板都在', dom.hasBubble && dom.hasBtn && dom.hasMenu)
check('样式已注入（#dshnw-style）', dom.styleInjected)
check('定位为 fixed + 高 z-index（浮在页面之上）', dom.position === 'fixed' && Number(dom.zIndex) >= 999999, `${dom.position} z=${dom.zIndex}`)
check('默认出现在右下角', dom.closeToBottomRight, `rect=${dom.rootRect} viewport=${dom.viewport}`)
check('立绘渲染尺寸合理（>120px 高）', (dom.imgRect?.[1] || 0) > 120, '高 ' + dom.imgRect?.[1] + 'px')
check('菜单控件齐全（大小滑块 + 3 开关 + 3 按钮）', !!dom.menuRows && dom.menuChecks === 3 && dom.menuButtons === 3, `${dom.menuRows} 行控件 / ${dom.menuChecks} 个开关 / ${dom.menuButtons} 个按钮`)

console.log('\n[2] 余额数据链路（页面 → 路由 → DeepSeek）')
await evalJs('window.__dshNaiwaWidget && null')
// 点一下奶娃：既触发刷新也弹气泡
const imgCenter = await evalJs(`(() => {
  const r = document.querySelector('.dshnw-img').getBoundingClientRect()
  return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)]
})()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: imgCenter[0], y: imgCenter[1], button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: imgCenter[0], y: imgCenter[1], button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 1800))

const bubble = await evalJs(`(() => {
  const b = document.querySelector('.dshnw-bubble')
  const t = (s) => (document.querySelector(s) || {}).textContent || ''
  const br = b.getBoundingClientRect()
  return {
    open: b.classList.contains('dshnw-open'),
    label: t('.dshnw-label'), amount: t('.dshnw-amount'), hint: t('.dshnw-hint'),
    opacity: getComputedStyle(b).opacity,
    size: [Math.round(br.width), Math.round(br.height)],
    textSize: (() => { const a = document.querySelector('.dshnw-amount'); return a ? getComputedStyle(a).fontSize : null })(),
  }
})()`)
check('点击奶娃后气泡打开', bubble.open, `opacity=${bubble.opacity} size=${bubble.size}`)
check('气泡里显示出了余额金额', /^[¥$]\d/.test(bubble.amount), `${bubble.label} | ${bubble.amount} | ${bubble.hint}`)
check('气泡有今日已用 / 峰谷提示行', bubble.hint.length > 0, bubble.hint)
check('气泡内字号随缩放生效（>16px）', parseFloat(bubble.textSize || '0') > 16, 'amount font-size=' + bubble.textSize)

console.log('\n[3] 拖拽到左半边 → 镜像 + 左吸附')
const before = await evalJs(`(() => { const r=document.querySelector('.dshnw-root').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)] })()`)
// 按住拖到左侧
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: imgCenter[0], y: imgCenter[1], button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 60))
for (const x of [900, 600, 300, 90]) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 300, button: 'left', buttons: 1 })
  await new Promise((r) => setTimeout(r, 70))
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 90, y: 300, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 800))
const after = await evalJs(`(() => {
  const root = document.querySelector('.dshnw-root')
  const r = root.getBoundingClientRect()
  return {
    left: Math.round(r.left), top: Math.round(r.top),
    mirrored: root.classList.contains('dshnw-left'),
    transform: getComputedStyle(root).transform,
    textTransform: getComputedStyle(document.querySelector('.dshnw-text')).transform,
    persisted: (() => { try { return localStorage.getItem('dshnw-pos') } catch(e) { return null } })(),
  }
})()`)
check('拖拽真的移动了奶娃', Math.abs(after.left - before[0]) > 100, `${before[0]} → ${after.left}`)
check('拖到左半边触发整体镜像', after.mirrored && /matrix\(-1/.test(after.transform), after.transform)
check('镜像时气泡文字反向翻回（可读）', /matrix\(-1/.test(after.textTransform), after.textTransform)
check('松手后贴左边缘（吸附生效）', after.left <= 24, 'left=' + after.left)
check('位置已持久化到 localStorage', !!after.persisted, String(after.persisted).slice(0, 70))

console.log('\n[4] 菜单交互')
await evalJs(`document.querySelector('.dshnw-btn').click()`)
await new Promise((r) => setTimeout(r, 400))
const menuOpen = await evalJs(`(() => {
  const m = document.querySelector('.dshnw-menu')
  const r = m.getBoundingClientRect()
  return { open: m.classList.contains('dshnw-open'), display: getComputedStyle(m).display, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width)], inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
})()`)
check('点击 ☰ 打开菜单', menuOpen.open && menuOpen.display === 'flex', `rect=${menuOpen.rect}`)
check('菜单完整显示在视口内（不会被裁掉）', menuOpen.inViewport, JSON.stringify(menuOpen.rect))

const sizeChange = await evalJs(`(async () => {
  const before = document.querySelector('.dshnw-img').getBoundingClientRect().height
  const r = document.querySelector('.dshnw-range')
  r.value = '2.2'
  r.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((res) => setTimeout(res, 300))
  const img = document.querySelector('.dshnw-img')
  const text = document.querySelector('.dshnw-amount')
  return { before: Math.round(before), after: Math.round(img.getBoundingClientRect().height), fontSize: getComputedStyle(text).fontSize, val: document.querySelector('.dshnw-mval').textContent }
})()`)
check('拖动大小滑块 → 立绘真的变大', sizeChange.after > sizeChange.before + 40, `${sizeChange.before}px → ${sizeChange.after}px`)
check('菜单显示当前倍率', /2\.2/.test(sizeChange.val), sizeChange.val)
check('气泡字号跟着缩放一起变', parseFloat(sizeChange.fontSize) > 20, 'font-size=' + sizeChange.fontSize)

// 关掉菜单
await evalJs(`document.querySelector('.dshnw-btn').click()`)
await new Promise((r) => setTimeout(r, 300))
check('再点 ☰ 关闭菜单', !(await evalJs(`document.querySelector('.dshnw-menu').classList.contains('dshnw-open')`)))

console.log('\n[5] 每轮消耗提示（模拟 DSH 一轮结束）')
for (const fn of listeners.get('session/event') || []) {
  fn({ id: 'browser-check' }, { type: 'turn/start', data: {} })
  fn({ id: 'browser-check' }, {
    type: 'assistant/message',
    data: { turn: 3, usage: { inputTokens: 5000, cacheReadTokens: 90000, outputTokens: 2000 }, message: { source: { model: 'deepseek-flash' } } },
  })
  fn({ id: 'browser-check' }, { type: 'turn/end', data: { turn: 3 } })
}
await new Promise((r) => setTimeout(r, 1800))
const costBubble = await evalJs(`(() => {
  const b = document.querySelector('.dshnw-bubble')
  const t = (s) => (document.querySelector(s) || {}).textContent || ''
  return { open: b.classList.contains('dshnw-open'), label: t('.dshnw-label'), amount: t('.dshnw-amount'), hint: t('.dshnw-hint') }
})()`)
check('一轮结束后弹出消耗气泡', costBubble.open && /上一轮/.test(costBubble.label), `${costBubble.label} ${costBubble.amount} · ${costBubble.hint}`)
check('消耗金额是 ¥ 数字', /^[¥$]\d/.test(costBubble.amount), costBubble.amount)

console.log('\n[6] 截图与像素校验')
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
const stat = await evalJs(`(async () => {
  // 把立绘自身画到 canvas 上，统计像素：确认真的是一张有内容的图（不是空白/透明）
  const img = document.querySelector('.dshnw-img')
  const c = document.createElement('canvas')
  c.width = img.naturalWidth; c.height = img.naturalHeight
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height).data
  let opaque = 0, transparent = 0, golden = 0, dark = 0, rSum = 0, gSum = 0, bSum = 0, n = 0
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    if (a > 200) { opaque++; rSum += d[i]; gSum += d[i+1]; bSum += d[i+2]; n++
      if (d[i] > 190 && d[i+1] > 140 && d[i+2] < 150) golden++
      if (d[i] < 110 && d[i+1] < 110 && d[i+2] < 110) dark++
    } else if (a < 40) transparent++
  }
  return { w: c.width, h: c.height, opaquePct: Math.round(100*opaque/(c.width*c.height)), transparentPct: Math.round(100*transparent/(c.width*c.height)), goldenPct: Math.round(100*golden/Math.max(1,n)), darkPct: Math.round(100*dark/Math.max(1,n)), avg: [Math.round(rSum/Math.max(1,n)), Math.round(gSum/Math.max(1,n)), Math.round(bSum/Math.max(1,n))] }
})()`)
check('立绘有真实像素内容（不透明占比 40%~95%）', stat.opaquePct > 40 && stat.opaquePct < 95, JSON.stringify(stat))
check('立绘有透明背景（抠图成功，透明占比 >5%）', stat.transparentPct > 5, '透明 ' + stat.transparentPct + '%')
check('主体是金黄/橙色系（与上传素材一致）', stat.goldenPct > 30, '金黄像素占不透明区 ' + stat.goldenPct + '%，均色 rgb(' + stat.avg.join(',') + ')')
check('有深色细节（眼睛/描边，占比 0.5%~25%）', stat.darkPct > 0.5 && stat.darkPct < 25, '深色 ' + stat.darkPct + '%')

// ---------------------------------------------------------------- 新增：点击序列 / 小动作 / 表情 / 图表 / 额度面板
async function clickPet() {
  const pt = await evalJs(`(() => { const r = document.querySelector('.dshnw-img').getBoundingClientRect(); return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)] })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt[0], y: pt[1], button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt[0], y: pt[1], button: 'left', buttons: 0, clickCount: 1 })
  await new Promise((r) => setTimeout(r, 420))
}
const bubbleNow = () => evalJs(`(() => {
  const b = document.querySelector('.dshnw-bubble')
  const t = (s) => (document.querySelector(s) || {}).textContent || ''
  return {
    open: b.classList.contains('dshnw-open'),
    label: t('.dshnw-label'), amount: t('.dshnw-amount'), hint: t('.dshnw-hint'), quip: t('.dshnw-quip'),
    quipCls: (document.querySelector('.dshnw-quip') || {}).className || '',
    bars: document.querySelectorAll('.dshnw-bar').length,
    barsToday: document.querySelectorAll('.dshnw-bar.dshnw-today').length,
    barHeights: Array.from(document.querySelectorAll('.dshnw-bar i')).map((n) => Math.round(parseFloat(n.style.height) || 0)),
    prog: document.querySelectorAll('.dshnw-prog').length,
    mood: document.querySelector('.dshnw-root').getAttribute('data-mood'),
  }
})()`)

console.log('\n[7] 点击序列（第 1/2/3/4 下各换一种内容）')
// 点击序列由测试钩子驱动，保证每一「下」都可预期
const clickResults = await evalJs(`(async () => {
  const H = window.__dshNaiwaTestHooks
  const snap = () => {
    const t = (s) => (document.querySelector(s) || {}).textContent || ''
    return {
      open: document.querySelector('.dshnw-bubble').classList.contains('dshnw-open'),
      label: t('.dshnw-label'), amount: t('.dshnw-amount'), hint: t('.dshnw-hint'), quip: t('.dshnw-quip'),
      bars: document.querySelectorAll('.dshnw-bar').length,
      barsToday: document.querySelectorAll('.dshnw-bar.dshnw-today').length,
      barHeights: Array.from(document.querySelectorAll('.dshnw-bar i')).map((n) => Math.round(parseFloat(n.style.height) || 0)),
      step: H.snapshot().clickStep,
    }
  }
  H.closeBubble()
  const out = []
  for (let i = 0; i < 4; i++) {
    H.petClick()
    await new Promise((r) => setTimeout(r, 130))
    out.push(snap())
  }
  return out
})()`)

const [c1, c2, c3, c4] = clickResults
check('第 1 下 → 余额大数字', c1.open && c1.label.includes('余额') && /^[¥$]\d/.test(c1.amount), `${c1.label} | ${c1.amount} | ${c1.hint}`)
check('第 2 下 → 随机台词（不再是余额）', c2.open && c2.quip.length >= 3, `台词：「${c2.quip}」`)
check('第 3 下 → 还能聊多少轮', c3.open && /轮/.test(c3.amount) && c3.label.includes('还能'), `${c3.label} | ${c3.amount} | ${c3.hint}`)
check('第 3 下带近 7 天迷你柱状图', c3.bars === 7 && c3.barsToday === 1, `${c3.bars} 根柱子，今天高亮 ${c3.barsToday} 根`)
check('柱子高度都 > 0（图形真的画出来了）', c3.barHeights.length === 7 && c3.barHeights.every((h) => h > 0), '高度=' + c3.barHeights.join(','))

// 柱状图必须**按金额比例**画，而不是都画成同一个高度。
// 真实环境今天刚起算、没有历史，所以注入一份受控的 7 天数据来验证比例。
const chartProp = await evalJs(`(async () => {
  const H = window.__dshNaiwaTestHooks
  const amounts = [0.5, 1, 2, 0, 8, 4, 6]
  H.overrideBalance({
    daily: amounts.map((a, i) => ({ date: '2026-10-0' + (i + 1), label: (i + 1) + '/1', weekday: '一', amount: a, isToday: i === 6 })),
  })
  H.renderKind('rounds') // 直接渲染，避免触发的网络刷新覆盖注入的数据
  await new Promise((r) => setTimeout(r, 250))
  const chart = document.querySelector('.dshnw-chart')
  const bars = Array.from(document.querySelectorAll('.dshnw-bar i')).map((n) => ({
    style: parseFloat(n.style.height) || 0,
    px: Math.round(n.getBoundingClientRect().height),
  }))
  return { chartH: Math.round(chart.getBoundingClientRect().height), bars }
})()`)
const pct = chartProp.bars.map((b) => b.style)
check('最大的那天是满高 100%', pct[4] === 100, '百分比=' + pct.join(','))
// 百分比取整成整数，所以按「像素高度比例」验收（这才是用户真正看到的）
const expectedAmounts = [0.5, 1, 2, 0, 8, 4, 6]
const maxPx = chartProp.bars[4].px
const ratioOk = chartProp.bars.every((b, i) => {
  if (expectedAmounts[i] === 0) return true
  const want = (expectedAmounts[i] / 8) * maxPx
  return Math.abs(b.px - want) <= Math.max(3, want * 0.08)
})
check('柱高与金额成正比（像素比例 ±8%）', ratioOk, chartProp.bars.map((b, i) => b.px + 'px(vs ' + Math.round((expectedAmounts[i] / 8) * maxPx) + ')').join(' '))
check('金额为 0 的那天只剩最小高度', pct[3] <= 4, '0 元那天=' + pct[3] + '%')
check('柱子在像素上真的有高矮差', Math.max(...chartProp.bars.map((b) => b.px)) - Math.min(...chartProp.bars.map((b) => b.px)) > 20, 'px=' + chartProp.bars.map((b) => b.px).join(','))
check('第 4 下 → 再换一句台词 + 一个小动作', c4.open && c4.quip.length >= 3, `台词：「${c4.quip}」`)

// 台词「不连续重复」：必须只看**这一下真的渲染出来的**气泡。
// ⚠️ 不能在 step 回到 0 时读 DOM —— 那一下是「收起气泡」，旧台词节点仍在，
// 读出来会把上一句误当成新渲染的一句（这条假阳性我踩过）。
const quipSeq = await evalJs(`(async () => {
  const H = window.__dshNaiwaTestHooks
  H.closeBubble()
  const seen = []
  for (let i = 0; i < 24; i++) {
    H.petClick()
    const s = H.snapshot()
    if (s.clickStep === 2 || s.clickStep === 4) {
      const q = document.querySelector('.dshnw-quip')
      seen.push({ step: s.clickStep, quip: q ? q.textContent : null })
    }
  }
  return seen
})()`)
const renderedQuips = quipSeq.map((x) => x.quip).filter(Boolean)
const repeatAdjacent = renderedQuips.some((q, i) => i > 0 && q === renderedQuips[i - 1])
check('台词会换（抽样里至少出现 3 种）', new Set(renderedQuips).size >= 3, [...new Set(renderedQuips)].slice(0, 6).join(' / '))
check('同一句台词从不连续重复出现', !repeatAdjacent, repeatAdjacent ? '出现了连续重复：' + JSON.stringify(renderedQuips) : `${renderedQuips.length} 次台词渲染，无连续重复`)
check('第 2 下与第 4 下都会出台词', quipSeq.filter((x) => x.step === 2).length > 0 && quipSeq.filter((x) => x.step === 4).length > 0, `step2 ${quipSeq.filter((x) => x.step === 2).length} 次 / step4 ${quipSeq.filter((x) => x.step === 4).length} 次`)

const afterSeq = await evalJs(`window.__dshNaiwaTestHooks.snapshot()`)
check('点击序列会循环回第 1 项（不会越界卡死）', afterSeq.clickStep >= 0 && afterSeq.clickStep <= 4, 'clickStep=' + afterSeq.clickStep)

console.log('\n[7b] 气泡内容绝不重复（用户报的「余额显示两遍」回归测试）')
// 触发路径：点开余额气泡后 refresh() 回来，会**直接**调 renderBalance() 重画。
// 如果重画前没清空气泡，内容就会叠加 —— 这是真实发生过的 bug。
const dupCheck = await evalJs(`(async () => {
  const H = window.__dshNaiwaTestHooks
  const host = document.querySelector('.dshnw-text')
  const counts = () => ({
    label: host.querySelectorAll('.dshnw-label').length,
    amount: host.querySelectorAll('.dshnw-amount').length,
    hint: host.querySelectorAll('.dshnw-hint').length,
    quip: host.querySelectorAll('.dshnw-quip').length,
    prog: host.querySelectorAll('.dshnw-prog').length,
    total: host.children.length,
  })
  const steps = []

  // ① 打开余额气泡，然后连打 4 次刷新（模拟 60 秒轮询 / 手动刷新 / 点击刷新）
  H.closeBubble(); H.resetClicks()
  H.petClick()
  await new Promise((r) => setTimeout(r, 300))
  steps.push({ at: '首次渲染', ...counts() })
  for (let i = 0; i < 4; i++) {
    H.renderKind('balance')
    await new Promise((r) => setTimeout(r, 60))
  }
  steps.push({ at: '连打 4 次余额重绘', ...counts() })

  // ② 走一遍真实的网络刷新（这条路径才会调用 refresh 里的直接重绘）
  await H.refreshNow(false)
  await H.refreshNow(false)
  await new Promise((r) => setTimeout(r, 400))
  steps.push({ at: '两次真实刷新后', ...counts() })

  // ③ 各种气泡轮换两轮，看有没有跨类型残留
  for (const k of ['quip', 'warn', 'budget', 'rounds', 'cost', 'balance', 'quip', 'balance']) {
    H.renderKind(k)
    await new Promise((r) => setTimeout(r, 40))
  }
  steps.push({ at: '轮换 8 次类型后', ...counts() })

  // ④ 点击序列连点 20 下
  H.closeBubble()
  for (let i = 0; i < 20; i++) { H.petClick(); await new Promise((r) => setTimeout(r, 40)) }
  steps.push({ at: '连点 20 下后', ...counts() })
  return steps
})()`)

let dupOk = true
for (const st of dupCheck) {
  const single = st.label <= 1 && st.amount <= 1 && st.hint <= 1 && st.quip <= 1 && st.prog <= 1
  if (!single) dupOk = false
  console.log(`     ${single ? '✓' : '✗'} ${st.at}：label=${st.label} amount=${st.amount} hint=${st.hint} quip=${st.quip} prog=${st.prog} 共 ${st.total} 行`)
}
check('任何重绘路径都不会让气泡内容重复', dupOk, dupOk ? '每类内容始终 ≤ 1 个' : '出现了重复内容，见上方明细')
const maxLines = Math.max(...dupCheck.map((s) => s.total))
check('气泡行数不会随重绘次数增长（上限 5 行）', maxLines <= 5, '最多 ' + maxLines + ' 行')

console.log('\n[8] 小动作覆盖（6 种动作都能跑，不报错）')
// 6 个动作分两类：hop/spin/dead/dizzy 做「身体形变」，love/exclaim 只出粒子不形变
const actionResult = await evalJs(`(async () => {
  const H = window.__dshNaiwaTestHooks
  const body = document.querySelector('.dshnw-body')
  const out = []
  for (const k of ['hop','spin','dead','dizzy']) {
    H.action(k)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const cs = getComputedStyle(body)
    out.push({ k, name: cs.animationName, dur: cs.animationDuration, cls: document.querySelector('.dshnw-root').className })
    await new Promise((r) => setTimeout(r, 1100))
  }
  return out
})()`)
const animOk = actionResult.every((a) => a.name === 'dshnw-' + a.k)
check('4 个形变动作各自播对应动画（不互相串台）', animOk, actionResult.map((a) => a.k + '→' + a.name).join(' '))
check('动作类不会堆积（同一时刻只挂一个）', actionResult.every((a) => (a.cls.match(/dshnw-act-/g) || []).length === 1), actionResult.map((a) => (a.cls.match(/dshnw-act-[a-z]+/g) || []).join('+')).join(' | '))

const particleActions = await evalJs(`(async () => {
  const H = window.__dshNaiwaTestHooks
  const out = {}
  for (const [k, sel] of [['love','.dshnw-heart'],['exclaim','.dshnw-excl'],['dizzy','.dshnw-p'],['dead','.dshnw-p']]) {
    H.action(k)
    await new Promise((r) => setTimeout(r, 250))
    out[k] = document.querySelectorAll('.dshnw-fx ' + sel).length
    await new Promise((r) => setTimeout(r, 1300))
  }
  return out
})()`)
check('爱心 / 感叹号 / 晕圈 / 睡觉粒子都会真的生成', particleActions.love >= 1 && particleActions.exclaim >= 1 && particleActions.dizzy >= 1 && particleActions.dead >= 1, JSON.stringify(particleActions))

console.log('\n[9] 表情：余额预警 → 哭脸；预算超额 → 气鼓鼓')
// 预警阈值设成比余额高 → 立刻进入 sad
await evalJs(`window.__dshNaiwaTestHooks.closeBubble()`)
await evalJs(`fetch('/dsh-naiwa/config.json', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ warnBelow: 99999 }) }).then(r=>r.json())`)
const sadHook = await evalJs(`window.__dshNaiwaTestHooks.overrideBalance({ warn: { below: 99999, enabled: true, active: true } })`)
await new Promise((r) => setTimeout(r, 400))
const sad = await evalJs(`(() => {
  const root = document.querySelector('.dshnw-root')
  const tear = document.querySelector('.dshnw-tear')
  const cs = getComputedStyle(tear)
  return { mood: root.getAttribute('data-mood'), tearAnim: cs.animationName, tearDur: cs.animationDuration, sadClass: root.classList.contains('dshnw-mood-sad') }
})()`)
check('余额低于阈值 → data-mood=sad（奶娃哭）', sad.mood === 'sad', `mood=${sad.mood} ${sad.sadClass ? '(慢呼吸已启用)' : ''}`)
check('眼泪动画真的在跑', sad.tearAnim === 'dshnw-tear', `${sad.tearAnim} ${sad.tearDur}`)

const sadBubble = await bubbleNow()
check('哭脸时弹出余额预警气泡', sadBubble.label.includes('哭了') || sadBubble.label.includes('余额不足'), sadBubble.label + ' | ' + sadBubble.hint)

// 预算：基准设成当前余额，然后把阈值压到极小 → 立刻超额
// 预算超额：余额不会在测试里真的下降，所以用受控入口把 spent 推过 limit
// —— 走的是真实的 applyMood / checkAlerts 计算路径，只是数字换了。
const angryHook = await evalJs(`window.__dshNaiwaTestHooks.overrideBalance({
  warn: { below: 0, enabled: false, active: false },
  budget: { limit: 2, enabled: true, base: 27, spent: 2.5, ratio: 1.25, exceeded: true },
})`)
await new Promise((r) => setTimeout(r, 500))
const angry = await evalJs(`(() => {
  const root = document.querySelector('.dshnw-root')
  const steam = document.querySelector('.dshnw-steam')
  const cheek = document.querySelector('.dshnw-cheek')
  return {
    mood: root.getAttribute('data-mood'),
    steam: getComputedStyle(steam).animationName,
    cheek: getComputedStyle(cheek).animationName,
    bubbleText: (document.querySelector('.dshnw-label') || {}).textContent || '',
    prog: document.querySelectorAll('.dshnw-prog').length,
    progOver: document.querySelectorAll('.dshnw-prog.dshnw-over').length,
  }
})()`)
check('预算超额 → data-mood=angry（气鼓鼓）', angry.mood === 'angry', 'mood=' + angry.mood)
check('冒热气 / 腮红动画在跑', angry.steam === 'dshnw-steam' && angry.cheek === 'dshnw-cheek', `steam=${angry.steam} cheek=${angry.cheek}`)
check('超额时弹出预算气泡', angry.bubbleText.includes('预算'), angry.bubbleText)
check('超额时进度条变红（dshnw-over）', angry.progOver >= 1, `进度条 ${angry.prog} 条，红色 ${angry.progOver} 条`)

console.log('\n[10] 额度设置面板')
await evalJs(`document.querySelector('.dshnw-menu').classList.remove('dshnw-open')`)
await evalJs(`document.querySelector('.dshnw-btn').click()`)
await new Promise((r) => setTimeout(r, 250))
await evalJs(`document.querySelector('.dshnw-menu [data-act=panel]').click()`)
await new Promise((r) => setTimeout(r, 350))
const panel = await evalJs(`(() => {
  const p = document.querySelector('.dshnw-panel')
  const r = p.getBoundingClientRect()
  return {
    open: p.classList.contains('dshnw-open'),
    display: getComputedStyle(p).display,
    warn: (p.querySelector('[data-n=warnBelow]') || {}).value,
    budget: (p.querySelector('[data-n=budget]') || {}).value,
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
  }
})()`)
check('额度设置面板能打开', panel.open && panel.display === 'flex', `rect=${panel.rect}`)
check('面板完整显示在视口内', panel.inView, JSON.stringify(panel.rect))
check('面板回填了当前阈值/预算', panel.warn !== undefined && panel.budget !== undefined, `预警=${panel.warn} 预算=${panel.budget}`)

const applied = await evalJs(`(async () => {
  const inp = document.querySelector('.dshnw-panel [data-n=warnBelow]')
  inp.value = '3.5'
  inp.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 900))
  const cfg = await (await fetch('/dsh-naiwa/config.json')).json()
  return { warnBelow: cfg.warnBelow, budget: cfg.budget, mood: document.querySelector('.dshnw-root').getAttribute('data-mood') }
})()`)
check('面板改阈值 → 真的写进配置', applied.warnBelow === 3.5, `warnBelow=${applied.warnBelow} budget=${applied.budget}`)
check('阈值调低后奶娃不再哭（情绪会恢复）', applied.mood !== 'sad', 'mood=' + applied.mood)

// 收尾：把提醒都关掉，别留副作用
await evalJs(`fetch('/dsh-naiwa/config.json', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ warnBelow: 0, budget: 0 }) }).then(r=>r.json())`)
await evalJs(`document.querySelector('.dshnw-panel [data-act=close]').click()`)
await evalJs(`document.querySelector('.dshnw-btn').click()`)

console.log('\n[11] 页面无报错')
const realErrors = pageErrors.filter((e) => e && !/favicon/i.test(e))
check('页面控制台无 JS 异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || '无')

console.log(`\n截图：${SHOT}`)

// ---------------------------------------------------------------- 收尾
if (!KEEP) {
  try {
    await send('Target.closeTarget', { targetId })
  } catch (err) {}
  ws.close()
  chrome.kill('SIGKILL')
  server.close()
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch (err) {}
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 浏览器自检：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' — ' + f.detail : ''))
  process.exit(1)
}
console.log('全部通过 ✅')
process.exit(0)
