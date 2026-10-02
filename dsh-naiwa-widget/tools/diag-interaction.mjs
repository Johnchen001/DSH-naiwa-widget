/**
 * 交互诊断：单独排查「点击 / 拖拽 / 菜单」为什么不生效。
 * 用法：DSH_HOME=/tmp/naiwa-selftest node tools/diag-interaction.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const routes = []
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: { register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } },
  credentials: {
    async resolve(ref) {
      if (ref !== 'DEEPSEEK_API_KEY') return undefined
      try {
        const t = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
        const m = /^DEEPSEEK_API_KEY:\s*(.+)$/m.exec(t)
        return m ? { value: m[1].trim() } : undefined
      } catch (e) { return undefined }
    },
  },
  on() { return () => {} },
  effect() { return () => {} },
}
;(await import('../lib/index.js')).apply(fakeCtx)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>diag</title>
<style>html,body{margin:0;height:100%;background:#eef1f8}div#pad{position:fixed;inset:0}</style></head>
<body><div id="pad"></div><script defer src="/dsh-naiwa/widget.js"></script></body></html>`

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host)
  if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return }
  const r = routes.find((x) => x.path === u.pathname)
  if (!r) { res.writeHead(404); res.end('nf'); return }
  await r.handler(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-chrome-'))
const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', '--disable-crashpad',
  '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,800', 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  ch.stderr.on('data', (c) => { buf += String(c); const m = /ws:\/\/[^\s]+/.exec(buf); if (m) resolve(m[0]) })
  setTimeout(() => reject(new Error('chrome timeout')), 25000)
})
const base = wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '')
const list = await (await fetch(base + '/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
})
const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
await new Promise((r) => setTimeout(r, 2500))

console.log('--- 1. 元素与命中测试（elementFromPoint）')
console.log(await ev(`(() => {
  const root = document.querySelector('.dshnw-root')
  const img = document.querySelector('.dshnw-img')
  const r = img.getBoundingClientRect()
  const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2)
  const hit = document.elementFromPoint(cx, cy)
  return {
    imgRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    point: [cx, cy],
    hitTag: hit && hit.tagName, hitClass: hit && hit.className,
    rootIsHit: !!(hit && root.contains(hit)),
    rootPointerEvents: getComputedStyle(root).pointerEvents,
    imgPointerEvents: getComputedStyle(img).pointerEvents,
    rootZ: getComputedStyle(root).zIndex,
  }
})()`))

console.log('\n--- 2. 直接调用内部函数（绕过鼠标事件）')
console.log(await ev(`(() => {
  const root = document.querySelector('.dshnw-root')
  const btn = document.querySelector('.dshnw-btn')
  btn.click()
  const m = document.querySelector('.dshnw-menu')
  return { afterBtnClick: m.className, display: getComputedStyle(m).display, rect: (()=>{const r=m.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})() }
})()`))

console.log('\n--- 3. 手动派发 pointerdown/up（模拟一次点击奶娃）')
console.log(await ev(`(() => {
  const img = document.querySelector('.dshnw-img')
  const b = document.querySelector('.dshnw-bubble')
  const r = img.getBoundingClientRect()
  const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2)
  const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1 }
  const root = document.querySelector('.dshnw-root')
  root.dispatchEvent(new PointerEvent('pointerdown', opts))
  root.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0 })))
  return { bubbleClass: b.className, label: document.querySelector('.dshnw-label').textContent, amount: document.querySelector('.dshnw-amount').textContent }
})()`))
await new Promise((r) => setTimeout(r, 1200))
console.log('  1.2s 后：', await ev(`(() => { const b=document.querySelector('.dshnw-bubble'); return { cls: b.className, label: document.querySelector('.dshnw-label').textContent, amount: document.querySelector('.dshnw-amount').textContent, hint: document.querySelector('.dshnw-hint').textContent } })()`))

console.log('\n--- 4. CDP 真实鼠标点击')
await ev(`document.querySelector('.dshnw-bubble').classList.remove('dshnw-open')`)
const pt = await ev(`(() => { const r=document.querySelector('.dshnw-img').getBoundingClientRect(); return [Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)] })()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt[0], y: pt[1], button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt[0], y: pt[1], button: 'left', buttons: 0, clickCount: 1 })
await new Promise((r) => setTimeout(r, 1200))
console.log('  点击后：', await ev(`(() => { const b=document.querySelector('.dshnw-bubble'); return { cls: b.className, label: document.querySelector('.dshnw-label').textContent, amount: document.querySelector('.dshnw-amount').textContent } })()`))

console.log('\n--- 5. 监听器是否真的挂上（node 侧计数）')
console.log('  页面里 dshnw-root 的 pointerdown 监听器无法直接枚举，改为看是否触发了 drag 状态：')
console.log(await ev(`(() => {
  const root = document.querySelector('.dshnw-root')
  const img = document.querySelector('.dshnw-img')
  const r = img.getBoundingClientRect()
  const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2)
  const ev1 = new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId: 7, pointerType:'mouse', isPrimary:true, clientX:x, clientY:y, button:0, buttons:1 })
  const dispatched = root.dispatchEvent(ev1)
  const after = root.className
  return { dispatchReturned: dispatched, rootClassAfterDown: after, pressedClassPresent: after.includes('dshnw-press') }
})()`))

console.log('\n--- 6. localStorage / 位置')
console.log(await ev(`({ ls: (()=>{try{return localStorage.getItem('dshnw-pos')}catch(e){return 'ERR'}})(), left: document.querySelector('.dshnw-root').style.left, top: document.querySelector('.dshnw-root').style.top })`))

console.log('\n--- 7. 把 widget.js 的源码抓回来，在页面里逐字复习一遍（找 bug）')
const src = await (await fetch(`http://127.0.0.1:${port}/dsh-naiwa/widget.js`)).text()
const interesting = ['function bind()', 'function onPointerDown', 'bind2()', 'function boot()', 'root.addEventListener']
for (const key of interesting) {
  const i = src.indexOf(key)
  console.log(`  · ${key} @ ${i}`)
}
console.log('  · 文件尾部 300 字符：\n' + src.slice(-300).split('\n').map((l) => '      ' + l).join('\n'))

console.log('\n--- 8. 在页面里重新加载一份带 try/catch 的 widget（看 IIFE 里是否抛异常）')
await ev(`(() => { window.__err = null; window.addEventListener('error', (e) => { window.__err = String(e.message) + ' @' + e.lineno + ':' + e.colno }) })()`)
// 用 fetch + eval 在页面里重跑一遍（带错误捕获），暴露真实异常
const rerun = await ev(`(async () => {
  try {
    const text = await (await fetch('/dsh-naiwa/widget.js')).text()
    // 去掉幂等守卫，强制重跑
    const patched = text.replace('if (window.__dshNaiwaWidget) return', 'if (false) return')
    document.querySelectorAll('.dshnw-root, .dshnw-menu, #dshnw-style').forEach((n) => n.remove())
    ;(0, eval)(patched)
    return { ok: true, roots: document.querySelectorAll('.dshnw-root').length, err: window.__err }
  } catch (e) {
    return { ok: false, error: String(e && (e.stack || e.message)), err: window.__err }
  }
})()`)
console.log('  重跑结果：', JSON.stringify(rerun, null, 2).slice(0, 1200))

console.log('\n--- 9. 重跑后立即测一次点击（看新实例是否可交互）')
await new Promise((r) => setTimeout(r, 2500))
const clickTest = await ev(`(() => {
  const root = document.querySelector('.dshnw-root')
  const btn = document.querySelector('.dshnw-btn')
  if (!root) return { noRoot: true }
  btn.click()
  const m = document.querySelector('.dshnw-menu')
  return { menuClass: m.className, display: getComputedStyle(m).display, rootClass: root.className }
})()`)
console.log('  点击 ☰ 后：', JSON.stringify(clickTest))
console.log('  页面 error：', await ev('window.__err'))

ws.close(); ch.kill('SIGKILL'); server.close()
try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
process.exit(0)
