/**
 * 装完之后的一键验收：检查「正在运行的 dsh web」里奶娃挂件是否真的生效了。
 *
 * 用法：
 *   node tools/verify-live.mjs                 # 默认 http://127.0.0.1:8080
 *   node tools/verify-live.mjs 127.0.0.1:3080  # 换端口
 *
 * 退出码 0 = 已生效；1 = 还没生效（多半是没重启 dsh web）。
 */

const arg = process.argv[2] || process.env.DSH_WEB_URL || '127.0.0.1:8080'
const base = arg.startsWith('http') ? arg.replace(/\/$/, '') : `http://${arg}`

let pass = 0
let fail = 0
const notes = []

function ok(name, detail) {
  pass++
  console.log(`  ✅ ${name}${detail ? '  — ' + detail : ''}`)
}
function bad(name, detail, hint) {
  fail++
  console.log(`  ❌ ${name}${detail ? '  — ' + detail : ''}`)
  if (hint) notes.push(hint)
}

async function fetchText(url, init) {
  try {
    const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(8000) }, init))
    const text = await res.text()
    return { status: res.status, text, headers: res.headers }
  } catch (err) {
    return { status: 0, text: '', error: String((err && err.message) || err) }
  }
}

console.log(`\n验收目标：${base}\n`)

console.log('[1] 宿主端口是否活着')
const home = await fetchText(`${base}/`)
if (home.status === 200 && home.text.includes('<html')) ok('dsh web 正在运行', `HTTP ${home.status}`)
else bad('dsh web 没在跑', home.error || `HTTP ${home.status}`, `先启动 dsh web 再跑这个脚本`)

console.log('\n[2] 挂件路由是否已注册')
const health = await fetchText(`${base}/dsh-naiwa/health.json`)
let healthJson = null
try {
  healthJson = JSON.parse(health.text)
} catch (err) {}

if (healthJson && healthJson.plugin === 'dsh-naiwa-widget') {
  ok('GET /dsh-naiwa/health.json → 插件的 JSON', `v${healthJson.version}`)
  if (healthJson.hasWidgetJs) ok('前端脚本在插件包里', 'widget.js 可读')
  else bad('前端脚本缺失', 'assets/naiwa-widget.js 读不到', '插件包不完整：assets/ 里应该有 naiwa-widget.js')
  if (healthJson.hasImage) ok('立绘在插件包里', 'naiwa.png 可读')
  else bad('立绘缺失', 'assets/naiwa.png 读不到', '插件包不完整：assets/ 里应该有 naiwa.png')
  console.log(`     （配置文件位置：${healthJson.configFile}）`)
} else {
  bad(
    '路由还没注册',
    health.status === 200 && health.text.includes('<!doctype')
      ? '返回的是 SPA 的 index.html（说明这个路径被前端兜底接走了，插件没加载）'
      : `HTTP ${health.status}`,
    '👉 这就是「装了但没生效」：dsh plugin add 不会热加载，必须重启 dsh web',
  )
}

console.log('\n[3] index.html 是否注入了挂件脚本')
const injected = home.text.includes('dsh-naiwa/widget.js')
if (injected) ok('index.html 里有 <script src="/dsh-naiwa/widget.js">')
else
  bad(
    'index.html 里没有注入脚本',
    '注入没发生（或页面是客户端渲染的壳）',
    '👉 重启 dsh web 后浏览器再硬刷新（Cmd/Ctrl + Shift + R）',
  )

console.log('\n[4] 静态资源能否取到')
const js = await fetchText(`${base}/dsh-naiwa/widget.js`)
if (js.status === 200 && js.text.includes('__dshNaiwaWidget')) ok('GET /dsh-naiwa/widget.js → 挂件脚本', `${js.text.length} 字节`)
else
  bad(
    '取不到挂件脚本',
    js.text.includes('<!doctype') ? '返回的是 index.html（被 SPA 兜底接走，插件没加载）' : `HTTP ${js.status}`,
    '重启 dsh web',
  )

const pngRes = await fetch(`${base}/dsh-naiwa/naiwa.png`, { signal: AbortSignal.timeout(8000) })
const pngCt = pngRes.headers.get('content-type') || ''
const pngBuf = Buffer.from(await pngRes.arrayBuffer())
const isPng = pngBuf.slice(1, 4).toString('latin1') === 'PNG'
if (pngRes.status === 200 && pngCt.includes('image/png') && isPng) ok('GET /dsh-naiwa/naiwa.png → 立绘', `${Math.round(pngBuf.length / 1024)} KB`)
else
  bad(
    '取不到立绘',
    pngCt.includes('text/html') ? '返回的是 index.html（插件没加载）' : `HTTP ${pngRes.status} content-type=${pngCt}`,
    '检查 assets/naiwa.png 是否存在，并重启 dsh web',
  )

console.log('\n[5] 余额接口')
const bal = await fetchText(`${base}/dsh-naiwa/balance.json`)
let balJson = null
try {
  balJson = JSON.parse(bal.text)
} catch (err) {}
if (balJson && balJson.ok) {
  ok('拿到余额', `${balJson.currency} ${balJson.totalBalance}（来源 ${balJson.source}）`)
  if (balJson.usage) ok('附带今日已用', `¥${balJson.usage.todayUsage}`)
  if (balJson.peak) ok('附带峰谷信息', balJson.peak.label)
} else if (balJson) {
  bad('余额接口返回了错误', `${balJson.code}: ${String(balJson.error).slice(0, 90)}`, '按提示配置 DEEPSEEK_API_KEY，或在 DSH 里登录 DeepSeek 账号')
} else {
  bad('余额接口没有返回 JSON', `HTTP ${bal.status}`, '重启 dsh web')
}

console.log('\n[6] 配置读写 + 信任栅栏')
const cfg = await fetchText(`${base}/dsh-naiwa/config.json`)
if (cfg.status === 200 && cfg.text.includes('"scale"')) ok('GET config.json 正常', cfg.text.slice(0, 80))
else bad('读配置失败', `HTTP ${cfg.status}`, '重启 dsh web')

const evil = await fetch(`${base}/dsh-naiwa/config.json`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Origin: 'http://attacker.test' },
  body: '{}',
}).catch(() => null)
if (evil && evil.status === 403) ok('不同源写请求被 403 拒绝', '信任栅栏生效')
else if (evil && evil.status === 405) bad('写请求打到了别的地方', 'HTTP 405（插件没加载，请求被 SPA 兜底处理了）', '重启 dsh web')
else if (evil) bad('写请求没被拦', `HTTP ${evil.status}`, '安全栅栏异常，请反馈')
else bad('写请求测试失败', '网络错误', '')

console.log(`\n=== 验收结果：${pass} 通过 / ${fail} 未通过 ===`)
if (fail) {
  console.log('\n要做的：')
  for (const n of notes) console.log('  ' + n)
  console.log('\n  重启 dsh web 的做法：到启动它的终端按 Ctrl+C，再执行 dsh web，然后浏览器硬刷新。')
  process.exit(1)
}
console.log('挂件已生效 ✅ 打开浏览器硬刷新（Cmd/Ctrl + Shift + R）就能在角落看到奶娃了。')
