/* ============================================================================
 * dsh-naiwa-widget —— 前端挂件本体（原生 JS，无依赖）
 * ----------------------------------------------------------------------------
 * 由宿主按 mtime 热读：改这里 → 硬刷新页面（Cmd/Ctrl + Shift + R）即生效，不用重启 dsh web。
 *
 * 结构：
 *   <div class="dshnw-root">           定位（left/top 像素）+ 贴左缘时整体 scaleX(-1) 镜像
 *     <div class="dshnw-body">         奶娃本体：待机浮动 / 按压 Q 弹 / 小动作
 *       <img  class="dshnw-img">       立绘（/dsh-naiwa/naiwa.png）
 *       <div  class="dshnw-face">      表情层（纯 CSS 叠加）：眼泪 / 散热气 / 腮红
 *       <div  class="dshnw-fx">        特效层：爱心 / 金币 / 感叹号粒子
 *       <div  class="dshnw-bubble">    SVG 气泡 + 动态内容
 *     <button class="dshnw-btn">       ☰ 菜单按钮
 *   </div>
 *   <div class="dshnw-menu">           主菜单
 *   <div class="dshnw-panel">          额度设置面板（余额预警 / 今日预算）
 *
 * 点击序列（核心玩法）：
 *   第 1 下 → 余额大数字
 *   第 2 下 → 随机台词（带权重，同一句不连续重复）
 *   第 3 下 → 还能聊多少轮 + 近 7 天迷你柱状图
 *   第 4 下 → 换个台词 + 一个小动作
 *   再点     → 收起，下一轮从第 1 项重新开始
 *   每次点击都会随机附带一个小动作（爱心 / 蹦跶 / 转圈 / 惊叹 / 装死 / 晕圈）。
 * ========================================================================== */
(function () {
  'use strict'
  if (window.__dshNaiwaWidget) return
  window.__dshNaiwaWidget = true

  var PREFIX = '/dsh-naiwa'
  var BASE_H = 170 // scale=1 时立绘高度（px）
  var BUBBLE_ASPECT = 1026 / 700
  var BALANCE_REFRESH_MS = 60000
  var STATUS_POLL_MS = 1000
  var POS_KEY = 'dshnw-pos'
  var TURN_SEQ_KEY = 'dshnw-last-seq'
  var BUDGET_DAY_KEY = 'dshnw-budget-day'
  var BUBBLE_CLOSE_SEC = 5

  // ---------------------------------------------------------------- 状态
  var state = {
    scale: 1.35,
    sound: true,
    bubbleOn: true,
    snap: true,
    turnCostOn: true,
    turnCostCloseSec: 6,
    warnBelow: 5,
    budget: 2,
    left: null,
    top: null,
    snapH: null, // 'left' | 'right' | null
    snapV: null, // 'top' | 'bottom' | null
    ready: false,
  }
  var balance = null // 最近一次成功的余额 {totalBalance, currency}
  var data = null // 最近一次 balance.json 全量
  var loadError = ''
  var mood = 'normal' // normal | sad | angry
  var warnFired = false
  var budgetFiredDay = null
  var lastTurnSeq = null
  var menuOpen = false
  var panelOpen = false
  var bubbleTimer = null
  var bubbleKind = 'normal'
  var costActive = false
  var clickStep = 0
  var lastQuipText = null
  var rollRaf = null

  // ---------------------------------------------------------------- 台词库
  // w = 权重，越大越容易抽到；同一个池子里不连续重复同一句
  var QUIPS = [
    { t: '别充钱了，我够花了', w: 6 },
    { t: '我困了…你继续', w: 6 },
    { t: '你又来啦', w: 8 },
    { t: '我还在这儿呢', w: 8 },
    { t: '今天也很努力嘛', w: 6 },
    { t: '这个月账单我看了', w: 5 },
    { t: '别熬夜，我也要睡了', w: 4 },
    { t: '好模型…好女孩…↓', w: 3 },
    { t: '我在替你数钱', w: 5 },
    { t: '你话真多，我喜欢', w: 4 },
    { t: '余额嘛，够用就行', w: 5 },
    { t: '诶，摸哪儿呢', w: 4 },
    { t: '我要吃饭啦', w: 4 },
    { t: '压力一只黄色奶蛙', w: 3 },
    { t: '再聊下去要收费了哦', w: 4 },
    { t: '我是一只很贵的蛙', w: 3 },
    { t: '哦蛙蛙…', w: 2 },
    { t: '这个「凶」是什么意思呀', w: 2 },
  ]
  var QUIPS_SAD = [
    { t: '余额不多了…省着点', w: 8 },
    { t: '我要饿死了', w: 6 },
    { t: '钱包在哭', w: 5 },
    { t: '能不能给我留一点', w: 5 },
  ]
  var QUIPS_ANGRY = [
    { t: '超支了！你清醒一点', w: 8 },
    { t: '今天的钱花完了', w: 6 },
    { t: '再花我就没了', w: 5 },
    { t: '记账呢，别装了', w: 4 },
  ]

  var ACTIONS = ['love', 'hop', 'spin', 'exclaim', 'dead', 'dizzy']
  var ACTION_CLASSES = ACTIONS.map(function (k) { return 'dshnw-act-' + k })

  // ---------------------------------------------------------------- DOM
  var root, body, img, faceEl, fxEl, bubbleWrap, bubbleHost, btn, menuEl, panelEl
  var imgW = 0, imgH = 0, bubbleW = 0, bubbleH = 0
  var naturalW = 0, naturalH = 0

  // 样式内联注入（幂等）：不额外占一条路由，插件自包含。
  // assets/naiwa-widget.css 里是可读的同一份样式，方便改。
  var CSS = [
    '.dshnw-root{position:fixed;left:0;top:0;z-index:2147482000;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;transform-origin:50% 100%;will-change:transform,left,top}',
    '.dshnw-root.dshnw-anim{transition:left .3s cubic-bezier(.22,1,.36,1),top .3s cubic-bezier(.22,1,.36,1)}',
    '.dshnw-root.dshnw-left{transform:scaleX(-1)}',
    '.dshnw-body{position:absolute;inset:0;transform-origin:50% 100%;animation:dshnw-idle 3.6s ease-in-out infinite}',
    '.dshnw-img{position:absolute;right:0;bottom:0;width:auto;max-width:none;pointer-events:none;-webkit-user-drag:none;filter:drop-shadow(0 6px 10px rgba(20,30,70,.18))}',
    /* —— 表情层（叠在立绘上，纯 CSS 绘制）—— */
    '.dshnw-face{position:absolute;inset:0;pointer-events:none;z-index:1}',
    '.dshnw-tear{position:absolute;width:calc(var(--nh,170px) * .055);height:calc(var(--nh,170px) * .08);background:linear-gradient(180deg,#9fd4ff,#4aa3f0);border-radius:50% 50% 50% 50%/60% 60% 40% 40%;opacity:0;box-shadow:inset 0 -2px 3px rgba(255,255,255,.7)}',
    '.dshnw-tear.dshnw-tl{left:6%;top:30%}.dshnw-tear.dshnw-tr{right:8%;top:26%}',
    '.dshnw-root[data-mood="sad"] .dshnw-tear{animation:dshnw-tear 2.1s ease-in infinite}',
    '.dshnw-root[data-mood="sad"] .dshnw-tear.dshnw-tr{animation-delay:.9s}',
    '@keyframes dshnw-tear{0%{opacity:0;transform:translateY(0) scale(.6)}25%{opacity:1;transform:translateY(8%) scale(1)}100%{opacity:0;transform:translateY(70%) scale(.85)}}',
    '.dshnw-steam{position:absolute;width:calc(var(--nh,170px) * .07);height:calc(var(--nh,170px) * .07);border-radius:50%;background:radial-gradient(circle,rgba(255,140,120,.75),rgba(255,140,120,0) 70%);opacity:0}',
    '.dshnw-steam.dshnw-s1{left:14%;top:6%}.dshnw-steam.dshnw-s2{right:16%;top:10%}.dshnw-steam.dshnw-s3{left:44%;top:2%}',
    '.dshnw-root[data-mood="angry"] .dshnw-steam{animation:dshnw-steam 1.6s ease-out infinite}',
    '.dshnw-root[data-mood="angry"] .dshnw-steam.dshnw-s2{animation-delay:.5s}',
    '.dshnw-root[data-mood="angry"] .dshnw-steam.dshnw-s3{animation-delay:1s}',
    '@keyframes dshnw-steam{0%{opacity:0;transform:translateY(0) scale(.5)}30%{opacity:.9}100%{opacity:0;transform:translateY(-60%) scale(1.3)}}',
    '.dshnw-cheek{position:absolute;width:calc(var(--nh,170px) * .1);height:calc(var(--nh,170px) * .055);border-radius:50%;background:radial-gradient(circle,rgba(255,110,110,.75),rgba(255,110,110,0) 72%);opacity:0}',
    '.dshnw-cheek.dshnw-c1{left:8%;top:42%}.dshnw-cheek.dshnw-c2{right:10%;top:38%}',
    '.dshnw-root[data-mood="angry"] .dshnw-cheek{animation:dshnw-cheek 1.2s ease-in-out infinite}',
    '@keyframes dshnw-cheek{0%,100%{opacity:.35}50%{opacity:.9}}',
    /* —— 特效粒子层 —— */
    '.dshnw-fx{position:absolute;inset:0;pointer-events:none;z-index:4;overflow:visible}',
    '.dshnw-p{position:absolute;font-size:calc(var(--nh,170px) * .17);line-height:1;will-change:transform,opacity}',
    '.dshnw-heart{position:absolute;color:#ff5f86;font-size:calc(var(--nh,170px) * .16);line-height:1;animation:dshnw-float-up 1.4s ease-out forwards}',
    '.dshnw-coin{position:absolute;width:calc(var(--nh,170px) * .09);height:calc(var(--nh,170px) * .09);border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffe89a,#e8a92b 70%);border:1px solid #b8820f;animation:dshnw-coin-fall 1.5s cubic-bezier(.3,.9,.6,1) forwards}',
    '.dshnw-excl{position:absolute;font-weight:900;color:#e8433f;text-shadow:0 2px 0 #fff;font-size:calc(var(--nh,170px) * .2);animation:dshnw-pop 1s ease-out forwards}',
    '@keyframes dshnw-float-up{0%{opacity:0;transform:translateY(10%) scale(.5)}20%{opacity:1}100%{opacity:0;transform:translateY(-150%) scale(1.15)}}',
    '@keyframes dshnw-coin-fall{0%{opacity:0;transform:translateY(-30%) rotate(0)}15%{opacity:1}100%{opacity:0;transform:translateY(220%) rotate(320deg)}}',
    '@keyframes dshnw-pop{0%{opacity:0;transform:scale(.4)}30%{opacity:1;transform:scale(1.15)}70%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1) translateY(-20%)}}',
    /* —— 气泡 —— */
    '.dshnw-bubble{position:absolute;z-index:2;pointer-events:none;opacity:0;transform:scale(.62) translate(14px,18px);transform-origin:88% 96%;transition:opacity .18s ease,transform .26s cubic-bezier(.34,1.4,.5,1)}',
    '.dshnw-bubble.dshnw-open{opacity:1;transform:scale(1) translate(0,0)}',
    '.dshnw-bubble.dshnw-below{transform-origin:50% 100%;transform:scaleY(-1) scale(.62) translate(14px,18px)}',
    '.dshnw-bubble.dshnw-below.dshnw-open{transform:scaleY(-1) scale(1) translate(0,0)}',
    '.dshnw-bsvg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}',
    '.dshnw-bshape,.dshnw-btail,.dshnw-bpuff{fill:#fffdf8;stroke:#1d2f63;stroke-width:15;stroke-linejoin:round;paint-order:stroke fill;filter:drop-shadow(0 4px 8px rgba(20,30,70,.2))}',
    '.dshnw-text{position:absolute;left:7%;top:6%;width:72%;height:74%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1.5%}',
    '.dshnw-root.dshnw-left .dshnw-text{transform:scaleX(-1)}',
    '.dshnw-bubble.dshnw-below .dshnw-bsvg,.dshnw-bubble.dshnw-below .dshnw-text{transform:scaleY(-1)}',
    '.dshnw-root.dshnw-left .dshnw-bubble.dshnw-below .dshnw-text{transform:scale(-1,-1)}',
    '.dshnw-label{font:600 calc(var(--nh,170px) * .082)/1.25 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#6478a8;white-space:nowrap}',
    '.dshnw-amount{font:800 calc(var(--nh,170px) * .175)/1.1 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#16264f;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.dshnw-hint{font:500 calc(var(--nh,170px) * .076)/1.32 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#8c9cc4;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshnw-quip{font:800 calc(var(--nh,170px) * .135)/1.3 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#16264f;max-width:100%;word-break:break-word}',
    '.dshnw-quip.dshnw-sad{color:#3f6fb5}.dshnw-quip.dshnw-angry{color:#c93b38}',
    '.dshnw-chartwrap{display:flex;flex-direction:column;width:100%;height:calc(var(--nh,170px) * .34);gap:2px}',
    '.dshnw-chart{display:flex;align-items:flex-end;justify-content:center;gap:calc(var(--nh,170px) * .016);flex:1 1 auto;min-height:0;width:100%;padding:0 2%;box-sizing:border-box}',
    '.dshnw-chartlabels{display:flex;justify-content:center;gap:calc(var(--nh,170px) * .016);flex:0 0 auto;width:100%;padding:0 2%;box-sizing:border-box}',
    '.dshnw-bar-label{flex:1 1 0;min-width:0;text-align:center;font:600 calc(var(--nh,170px) * .05)/1 -apple-system,"PingFang SC",sans-serif;color:#93a1c2;white-space:nowrap;overflow:hidden}',
    '.dshnw-bar-label.dshnw-today{color:#c98a12}',
    '.dshnw-bar{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%}',
    '.dshnw-bar i{display:block;width:100%;border-radius:3px 3px 1px 1px;background:linear-gradient(180deg,#7ea2f2,#4d6fd6);min-height:2px}',
    '.dshnw-bar.dshnw-today i{background:linear-gradient(180deg,#ffcf5c,#f0a01e)}',
    '.dshnw-prog{width:86%;height:calc(var(--nh,170px) * .05);border-radius:999px;background:#e4e9f4;overflow:hidden}',
    '.dshnw-prog i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#6fd08c,#39b35f);transition:width .4s ease}',
    '.dshnw-prog.dshnw-over i{background:linear-gradient(90deg,#ff9d6b,#e8484a)}',
    /* —— 动作动画 —— */
    '@keyframes dshnw-idle{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
    '@keyframes dshnw-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}',
    '@keyframes dshnw-sigh{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(2px) rotate(-2deg)}60%{transform:translateY(1px) rotate(1.5deg)}}',
    '@keyframes dshnw-happy{0%,100%{transform:translateY(0)}25%{transform:translateY(-9px)}50%{transform:translateY(0)}75%{transform:translateY(-5px)}}',
    '@keyframes dshnw-hop{0%,100%{transform:translateY(0) scaleY(1)}15%{transform:translateY(0) scaleY(.86) scaleX(1.1)}45%{transform:translateY(-22%) scaleY(1.06) scaleX(.96)}70%{transform:translateY(0) scaleY(.92) scaleX(1.06)}}',
    '@keyframes dshnw-spin{0%{transform:rotate(0) scale(1)}50%{transform:rotate(180deg) scale(.82)}100%{transform:rotate(360deg) scale(1)}}',
    '@keyframes dshnw-dead{0%{transform:rotate(0)}100%{transform:rotate(84deg) translateY(6%)}}',
    '@keyframes dshnw-dizzy{0%,100%{transform:rotate(0)}20%{transform:rotate(-7deg)}40%{transform:rotate(6deg)}60%{transform:rotate(-4deg)}80%{transform:rotate(3deg)}}',
    '.dshnw-root[data-activity="thinking"] .dshnw-body{animation:dshnw-idle 1.5s ease-in-out infinite,dshnw-pulse 1.1s ease-in-out infinite}',
    '.dshnw-root[data-activity="waiting"] .dshnw-body{animation:dshnw-pulse .9s ease-in-out infinite}',
    '.dshnw-root.dshnw-sigh .dshnw-body{animation:dshnw-sigh .6s ease-in-out}',
    '.dshnw-root.dshnw-happy .dshnw-body{animation:dshnw-happy .9s ease-out}',
    '.dshnw-root.dshnw-act-hop .dshnw-body{animation:dshnw-hop .72s cubic-bezier(.3,1.4,.5,1)}',
    '.dshnw-root.dshnw-act-spin .dshnw-body{animation:dshnw-spin .85s cubic-bezier(.4,1.2,.5,1)}',
    '.dshnw-root.dshnw-act-dead .dshnw-body{animation:dshnw-dead .5s ease-in forwards;transform-origin:20% 90%}',
    '.dshnw-root.dshnw-act-dizzy .dshnw-body{animation:dshnw-dizzy .9s ease-in-out}',
    '.dshnw-root.dshnw-mood-sad .dshnw-body{animation:dshnw-idle 4.6s ease-in-out infinite}',
    '.dshnw-root.dshnw-press .dshnw-body{animation:none;transform:scaleY(.88) scaleX(1.05);transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
    /* —— 菜单按钮 / 菜单 / 面板 —— */
    '.dshnw-btn{position:absolute;right:-4px;top:-6px;z-index:5;width:24px;height:24px;padding:0;border:1px solid #1d2f63;border-radius:50%;background:#fffdf8;color:#1d2f63;font-size:12px;line-height:1;cursor:pointer;opacity:0;transition:opacity .18s ease,transform .18s ease;box-shadow:0 2px 6px rgba(20,30,70,.22);-webkit-user-drag:none}',
    '.dshnw-root:hover .dshnw-btn,.dshnw-root.dshnw-menu-open .dshnw-btn{opacity:1}',
    '.dshnw-btn:hover{transform:scale(1.12)}',
    '.dshnw-menu,.dshnw-panel{position:fixed;z-index:2147482001;display:none;flex-direction:column;gap:9px;min-width:214px;padding:12px 13px;border:1px solid rgba(29,47,99,.22);border-radius:14px;background:#fffdf8;box-shadow:0 12px 32px rgba(20,30,70,.24);color:#16264f;font:500 13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color-scheme:light}',
    '.dshnw-menu.dshnw-open,.dshnw-panel.dshnw-open{display:flex}',
    '.dshnw-mrow{display:flex;align-items:center;gap:9px}',
    '.dshnw-mlabel{flex:0 0 auto;min-width:62px;color:#4a5b85}',
    '.dshnw-mval{flex:0 0 auto;min-width:44px;text-align:right;color:#6478a8;font-variant-numeric:tabular-nums}',
    '.dshnw-range{flex:1 1 auto;min-width:92px;accent-color:#4d6fd6}',
    '.dshnw-msep{height:1px;background:rgba(29,47,99,.13);margin:1px 0}',
    '.dshnw-mrow-btns{gap:8px}',
    '.dshnw-mrow-btns button{flex:1 1 0;padding:6px 8px;border:1px solid rgba(29,47,99,.24);border-radius:9px;background:#f3f6ff;color:#23386e;font:inherit;cursor:pointer}',
    '.dshnw-mrow-btns button:hover{background:#e4ebff}',
    '.dshnw-num{flex:1 1 auto;min-width:0;width:100%;padding:5px 7px;border:1px solid rgba(29,47,99,.24);border-radius:8px;background:#fff;color:#16264f;font:inherit;box-sizing:border-box}',
    '.dshnw-mnote{color:#93a1c2;font-size:11px;line-height:1.35}',
    '.dshnw-switch{position:relative;display:inline-block;width:36px;height:20px;flex:0 0 auto}',
    '.dshnw-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}',
    '.dshnw-switch span{position:absolute;inset:0;border-radius:999px;background:#cdd6ea;transition:background .18s ease;pointer-events:none}',
    '.dshnw-switch span::after{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(20,30,70,.3);transition:transform .18s cubic-bezier(.34,1.4,.5,1)}',
    '.dshnw-switch input:checked+span{background:#5b7ce0}',
    '.dshnw-switch input:checked+span::after{transform:translateX(16px)}',
    '@media (hover:none){.dshnw-btn{opacity:.92}.dshnw-menu,.dshnw-panel{min-width:196px}}',
    '@media (prefers-reduced-motion:reduce){.dshnw-body{animation:none!important}.dshnw-tear,.dshnw-steam,.dshnw-cheek,.dshnw-heart,.dshnw-coin,.dshnw-excl{animation:none!important;opacity:0!important}}',
  ].join('')

  function injectStyle() {
    if (document.getElementById('dshnw-style')) return
    var s = document.createElement('style')
    s.id = 'dshnw-style'
    s.textContent = CSS
    ;(document.head || document.documentElement).appendChild(s)
  }

  function el(tag, cls, parent) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (parent) parent.appendChild(n)
    return n
  }

  function buildDom() {
    root = el('div', 'dshnw-root')
    root.setAttribute('data-mood', 'normal')
    root.setAttribute('data-activity', 'idle')
    body = el('div', 'dshnw-body', root)

    img = el('img', 'dshnw-img', body)
    img.src = PREFIX + '/naiwa.png'
    img.alt = '奶娃'
    img.draggable = false

    // 表情层（纯 CSS 叠加在立绘上）
    faceEl = el('div', 'dshnw-face', body)
    faceEl.innerHTML =
      '<div class="dshnw-tear dshnw-tl"></div><div class="dshnw-tear dshnw-tr"></div>' +
      '<div class="dshnw-steam dshnw-s1"></div><div class="dshnw-steam dshnw-s2"></div><div class="dshnw-steam dshnw-s3"></div>' +
      '<div class="dshnw-cheek dshnw-c1"></div><div class="dshnw-cheek dshnw-c2"></div>'

    // 粒子层
    fxEl = el('div', 'dshnw-fx', body)

    // 气泡（SVG 形状 + 动态内容宿主）
    bubbleWrap = el('div', 'dshnw-bubble', body)
    bubbleWrap.innerHTML =
      '<svg class="dshnw-bsvg" viewBox="0 0 1026 700" preserveAspectRatio="none">' +
      '<ellipse class="dshnw-bshape" cx="440" cy="250" rx="386" ry="238" />' +
      '<ellipse class="dshnw-btail" cx="846" cy="452" rx="104" ry="74" transform="rotate(-18 846 452)" />' +
      '<circle class="dshnw-bpuff" cx="900" cy="556" r="40" />' +
      '<circle class="dshnw-bpuff" cx="944" cy="640" r="26" />' +
      '</svg>'
    bubbleHost = el('div', 'dshnw-text', bubbleWrap)

    btn = el('button', 'dshnw-btn', root)
    btn.type = 'button'
    btn.title = '奶娃菜单'
    btn.textContent = '☰'

    document.body.appendChild(root)
    buildMenu()
    buildPanel()
  }

  function buildMenu() {
    menuEl = el('div', 'dshnw-menu')
    menuEl.innerHTML =
      '<div class="dshnw-mrow"><span class="dshnw-mlabel">大小</span>' +
      '<input class="dshnw-range" type="range" min="0.7" max="2.4" step="0.05">' +
      '<span class="dshnw-mval"></span></div>' +
      '<div class="dshnw-mrow"><span class="dshnw-mlabel">气泡</span>' +
      '<label class="dshnw-switch"><input type="checkbox" data-k="bubbleOn"><span></span></label></div>' +
      '<div class="dshnw-mrow"><span class="dshnw-mlabel">音效</span>' +
      '<label class="dshnw-switch"><input type="checkbox" data-k="sound"><span></span></label></div>' +
      '<div class="dshnw-mrow"><span class="dshnw-mlabel">贴边吸附</span>' +
      '<label class="dshnw-switch"><input type="checkbox" data-k="snap"><span></span></label></div>' +
      '<div class="dshnw-msep"></div>' +
      '<div class="dshnw-mrow dshnw-mrow-btns">' +
      '<button type="button" data-act="panel">额度设置</button>' +
      '<button type="button" data-act="refresh">刷新余额</button>' +
      '</div>' +
      '<div class="dshnw-mrow dshnw-mrow-btns"><button type="button" data-act="reset-usage">今日归零</button></div>' +
      '<div class="dshnw-mnote">拖动奶娃移动 · 双击唤出菜单 · 连点它会有反应</div>'
    document.body.appendChild(menuEl)

    var range = menuEl.querySelector('.dshnw-range')
    var mval = menuEl.querySelector('.dshnw-mval')
    range.addEventListener('input', function () {
      state.scale = Number(range.value)
      mval.textContent = state.scale.toFixed(2) + '×'
      applyScale(true)
      scheduleSave()
    })
    menuEl.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        state[cb.getAttribute('data-k')] = cb.checked
        if (cb.getAttribute('data-k') === 'bubbleOn' && !cb.checked) hideBubble()
        scheduleSave()
      })
    })
    menuEl.querySelector('[data-act=panel]').addEventListener('click', togglePanel)
    menuEl.querySelector('[data-act=refresh]').addEventListener('click', function () {
      refresh(true)
      showBubbleKind('balance', BUBBLE_CLOSE_SEC)
      warmupAudio()
    })
    menuEl.querySelector('[data-act=reset-usage]').addEventListener('click', function () {
      api(PREFIX + '/config.json', 'PUT', { resetUsage: true }).then(function () {
        return refresh(true)
      }).then(function () {
        showBubbleKind('custom', 4, { label: '今日已用', amount: '¥0.00', hint: '已重新起算 · 预算重新对齐' })
      })
    })
    menuEl.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    menuEl.addEventListener('click', function (e) { e.stopPropagation() })
  }

  function buildPanel() {
    panelEl = el('div', 'dshnw-panel')
    panelEl.innerHTML =
      '<div class="dshnw-mrow"><span class="dshnw-mlabel">余额预警</span>' +
      '<input class="dshnw-num" type="number" min="0" step="0.5" data-n="warnBelow"><span class="dshnw-mnote">元</span></div>' +
      '<div class="dshnw-mnote">余额低于这个数，奶娃会哭给你看（0 = 关闭）</div>' +
      '<div class="dshnw-msep"></div>' +
      '<div class="dshnw-mrow"><span class="dshnw-mlabel">今日预算</span>' +
      '<input class="dshnw-num" type="number" min="0" step="0.5" data-n="budget"><span class="dshnw-mnote">元</span></div>' +
      '<div class="dshnw-mnote">花超了奶娃会气鼓鼓（0 = 关闭）。改预算会以当前余额为起点重算。</div>' +
      '<div class="dshnw-mrow dshnw-mrow-btns">' +
      '<button type="button" data-act="rebase">按当前余额重算</button>' +
      '<button type="button" data-act="close">关闭</button></div>'
    document.body.appendChild(panelEl)

    panelEl.querySelectorAll('input[data-n]').forEach(function (inp) {
      inp.addEventListener('click', function (e) { e.stopPropagation() })
      inp.addEventListener('change', function () {
        var key = inp.getAttribute('data-n')
        var v = Number(inp.value)
        if (!isFinite(v) || v < 0) v = 0
        state[key] = v
        var payload = {}
        payload[key] = v
        if (key === 'budget') { payload.rebaseBudget = true; budgetFiredDay = null }
        if (key === 'warnBelow') warnFired = false
        api(PREFIX + '/config.json', 'PUT', payload).then(function () { refresh(true) })
      })
    })
    panelEl.querySelector('[data-act=rebase]').addEventListener('click', function () {
      budgetFiredDay = null
      api(PREFIX + '/config.json', 'PUT', { rebaseBudget: true }).then(function () { refresh(true) })
    })
    panelEl.querySelector('[data-act=close]').addEventListener('click', closePanel)
    panelEl.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    panelEl.addEventListener('click', function (e) { e.stopPropagation() })
  }

  // ---------------------------------------------------------------- 尺寸 / 布局
  function applyScale(keepAnchor) {
    var prevW = imgW
    imgH = Math.round(BASE_H * state.scale)
    imgW = Math.round(imgH * (naturalW && naturalH ? naturalW / naturalH : 1.1))
    img.style.height = imgH + 'px'
    img.style.width = 'auto'
    // 气泡字号 / 表情 / 粒子尺寸都以 --nh 为基准
    root.style.setProperty('--nh', imgH + 'px')
    bubbleH = Math.round(imgH * 1.06)
    bubbleW = Math.round(bubbleH * BUBBLE_ASPECT)
    bubbleWrap.style.height = bubbleH + 'px'
    bubbleWrap.style.width = bubbleW + 'px'
    bubbleWrap.style.left = (-Math.round(imgW * 0.52)) + 'px'
    bubbleWrap.style.bottom = Math.round(imgH * 0.74) + 'px'
    root.style.width = imgW + 'px'
    root.style.height = imgH + 'px'
    if (keepAnchor && prevW && state.left !== null) {
      // 以右下角为锚点缩放，奶娃不「乱跑」
      state.left += prevW - imgW
      clampPosition()
      place()
    }
  }

  function viewport() {
    return { w: window.innerWidth, h: window.innerHeight }
  }

  function clampPosition() {
    var v = viewport()
    var pad = 8
    if (state.left === null) state.left = v.w - imgW - 24
    if (state.top === null) state.top = v.h - imgH - 18
    state.left = Math.max(pad, Math.min(v.w - imgW - pad, state.left))
    state.top = Math.max(pad, Math.min(v.h - imgH - pad, state.top))
  }

  function place() {
    root.style.left = Math.round(state.left) + 'px'
    root.style.top = Math.round(state.top) + 'px'
    root.classList.toggle('dshnw-left', state.snapH === 'left')
    updateBubbleSide()
    placeMenu()
    placePanel()
  }

  // 顶部空间不够时气泡翻到奶娃下方（几何与 CSS 保持一致）
  function updateBubbleSide() {
    var v = viewport()
    var bubbleTopAbs = state.top + imgH * 1.48 - bubbleH
    var below = bubbleTopAbs < 6 && state.top + imgH * 1.5 + bubbleH < v.h
    bubbleWrap.classList.toggle('dshnw-below', below)
  }

  function settle() {
    if (!state.snap) {
      clampPosition()
      place()
      savePos()
      return
    }
    var v = viewport()
    var cx = state.left + imgW / 2
    var cy = state.top + imgH / 2
    state.snapH = cx < v.w / 4 ? 'left' : (cx > (v.w * 3) / 4 ? 'right' : null)
    state.snapV = cy < v.h / 4 ? 'top' : (cy > (v.h * 3) / 4 ? 'bottom' : null)
    var pad = 16
    if (state.snapH === 'left') state.left = pad
    else if (state.snapH === 'right') state.left = v.w - imgW - pad
    if (state.snapV === 'top') state.top = pad
    else if (state.snapV === 'bottom') state.top = v.h - imgH - pad
    clampPosition()
    root.classList.add('dshnw-anim')
    place()
    setTimeout(function () { root.classList.remove('dshnw-anim') }, 340)
    savePos()
  }

  // ---------------------------------------------------------------- 拖拽 / 按压
  var drag = null

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return
    if (e.target === btn) return
    closeMenu()
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, left0: state.left, top0: state.top, moved: false, t0: Date.now() }
    try { root.setPointerCapture && root.setPointerCapture(e.pointerId) } catch (err) {}
    root.classList.add('dshnw-press', 'dshnw-nodrag')
    warmupAudio()
    sfx('press')
    e.preventDefault()
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return
    var dx = e.clientX - drag.x0
    var dy = e.clientY - drag.y0
    if (!drag.moved && dx * dx + dy * dy >= 9) {
      drag.moved = true
      root.classList.remove('dshnw-press')
    }
    if (!drag.moved) return
    var v = viewport()
    state.left = Math.max(-imgW * 0.3, Math.min(v.w - imgW * 0.7, drag.left0 + dx))
    state.top = Math.max(-imgH * 0.2, Math.min(v.h - imgH * 0.6, drag.top0 + dy))
    // 拖动中实时判定是否镜像，跟手更自然
    var cx = state.left + imgW / 2
    var mirror = cx < v.w / 2
    if (mirror !== (state.snapH === 'left')) {
      root.classList.toggle('dshnw-left', mirror)
      placeMenu()
      placePanel()
    }
    root.style.left = Math.round(state.left) + 'px'
    root.style.top = Math.round(state.top) + 'px'
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return
    var wasMoved = drag.moved
    drag = null
    root.classList.remove('dshnw-press', 'dshnw-nodrag')
    sfx('release')
    if (!wasMoved) onPetClick()
    else settle()
  }

  function onDblClick(e) {
    e.preventDefault()
    toggleMenu()
  }

  function onContextMenu(e) {
    e.preventDefault()
    toggleMenu()
  }

  // 点 / 摸一下奶娃：推进点击序列，并随机附送一个小动作
  function onPetClick() {
    if (!state.bubbleOn) return
    flashAction(pickRandom(ACTIONS))
    advanceClicks()
    refresh(false)
  }

  function advanceClicks() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (clickStep >= 4) {
      hideBubble()
      clickStep = 0
      return
    }
    clickStep += 1
    if (clickStep === 1) showBubbleKind('balance', BUBBLE_CLOSE_SEC)
    else if (clickStep === 2) {
      showBubbleKind('quip', BUBBLE_CLOSE_SEC)
      sfx(mood === 'normal' ? 'chirp' : mood)
    } else if (clickStep === 3) showBubbleKind('rounds', BUBBLE_CLOSE_SEC)
    else {
      showBubbleKind('quip', BUBBLE_CLOSE_SEC)
      flashAction(pickRandom(ACTIONS))
    }
  }

  // ---------------------------------------------------------------- 小动作 / 粒子
  // 同一时刻只允许挂一个动作类：否则「上一个小动作的类还没摘掉、新的又加上」，
  // 多个 .dshnw-root.dshnw-act-* 规则会按样式表顺序打架（后出现的赢），
  // 于是新动作会播成上一个动作的动画（实测过：连点后 hop 一直赢）。
  function clearActionClasses() {
    for (var i = 0; i < ACTION_CLASSES.length; i++) root.classList.remove(ACTION_CLASSES[i])
  }

  function flashAction(kind) {
    if (!root || !kind) return
    clearActionClasses()
    var cls = 'dshnw-act-' + kind
    void root.offsetWidth
    root.classList.add(cls)
    if (kind === 'love') spawnHearts(3)
    else if (kind === 'exclaim') spawnExcl()
    else if (kind === 'dizzy') spawnParticles('💫', 3)
    else if (kind === 'dead') spawnParticles('💤', 2)
    setTimeout(function () {
      if (root.classList.contains(cls)) root.classList.remove(cls)
    }, kind === 'dead' ? 900 : 1100)
  }

  function spawnHearts(n) {
    for (var i = 0; i < n; i++) {
      ;(function (i) {
        setTimeout(function () {
          if (!fxEl) return
          var h = document.createElement('div')
          h.className = 'dshnw-heart'
          h.textContent = '❤'
          h.style.left = (18 + i * 24) + '%'
          h.style.bottom = '52%'
          fxEl.appendChild(h)
          setTimeout(function () { h.remove() }, 1500)
        }, i * 120)
      })(i)
    }
  }

  function spawnExcl() {
    if (!fxEl) return
    var n = document.createElement('div')
    n.className = 'dshnw-excl'
    n.textContent = '!'
    n.style.left = '58%'
    n.style.top = '2%'
    fxEl.appendChild(n)
    setTimeout(function () { n.remove() }, 1100)
  }

  function spawnParticles(ch, n) {
    for (var i = 0; i < n; i++) {
      ;(function (i) {
        if (!fxEl) return
        var p = document.createElement('div')
        p.className = 'dshnw-p'
        p.textContent = ch
        p.style.left = (20 + i * 20 + Math.random() * 10) + '%'
        p.style.top = (10 + Math.random() * 34) + '%'
        p.style.animation = 'dshnw-float-up 1.3s ease-out forwards'
        fxEl.appendChild(p)
        setTimeout(function () { p.remove() }, 1400)
      })(i)
    }
  }

  function spawnCoins() {
    for (var i = 0; i < 4; i++) {
      ;(function (i) {
        setTimeout(function () {
          if (!fxEl) return
          var c = document.createElement('div')
          c.className = 'dshnw-coin'
          c.style.left = (28 + i * 13 + Math.random() * 8) + '%'
          c.style.top = '-6%'
          fxEl.appendChild(c)
          setTimeout(function () { c.remove() }, 1600)
        }, i * 110)
      })(i)
    }
  }

  // ---------------------------------------------------------------- 气泡内容
  // ⚠️ 铁律：**任何**负责画内容的函数都必须自己先清空气泡，不能指望调用方清。
  // 踩过的坑：renderBalance 曾经只在 renderBubble 里被 clearBubble 保护，
  // 但 refresh() 的后处理是**直接**调 renderBalance() 的 ——
  // 于是「打开气泡 → 余额刷新回来」就变成清空失败、内容叠加，
  // 余额行显示两遍（用户报的 bug）。现在每个入口自己负责清干净。
  function clearBubble() {
    if (bubbleHost) bubbleHost.innerHTML = ''
  }

  function addLine(cls, text) {
    if (!bubbleHost) return null
    // 结构自愈：一个气泡最多只有一个 label / amount / hint / quip。
    // 万一将来又有人忘记先 clearBubble，这里会兜住，绝不会再出现「余额显示两遍」。
    var key = String(cls).split(' ')[0]
    if (key === 'dshnw-label' || key === 'dshnw-amount' || key === 'dshnw-hint' || key === 'dshnw-quip') {
      if (bubbleHost.querySelector('.' + key)) clearBubble()
    }
    var n = el('div', cls, bubbleHost)
    n.textContent = text
    return n
  }

  function showBubbleKind(kind, seconds, custom) {
    if (!state.bubbleOn) return
    if (costActive && kind !== 'cost') return // 消耗泡泡显示期间不抢层
    bubbleKind = kind
    costActive = kind === 'cost'
    renderBubble(kind, custom)
    bubbleWrap.classList.add('dshnw-open')
    if (bubbleTimer) clearTimeout(bubbleTimer)
    if (seconds > 0) bubbleTimer = setTimeout(hideBubble, seconds * 1000)
  }

  function hideBubble() {
    bubbleWrap.classList.remove('dshnw-open')
    bubbleKind = 'normal'
    costActive = false
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
  }

  function fmtMoney(v, cur) {
    var sym = cur === 'USD' ? '$' : '¥'
    return sym + Number(v || 0).toFixed(2)
  }

  function currency() {
    return (balance && balance.currency) || (data && data.currency) || 'CNY'
  }

  // 每个分支自己 clearBubble()：这样 renderBalance 既能被这里调用、也能被 refresh 直接调用，
  // 两条路径都不会重复叠内容，也不会清两遍。
  function renderBubble(kind, custom) {
    if (kind === 'custom' || kind === 'cost') {
      clearBubble()
      var c = custom || {}
      addLine('dshnw-label', c.label || '')
      addLine('dshnw-amount', c.amount || '')
      addLine('dshnw-hint', c.hint || '')
      return
    }
    if (kind === 'quip') {
      clearBubble()
      var pool = mood === 'sad' ? QUIPS_SAD : (mood === 'angry' ? QUIPS_ANGRY : QUIPS)
      addLine('dshnw-quip' + (mood === 'normal' ? '' : ' dshnw-' + mood), pickQuip(pool))
      addLine('dshnw-hint', mood === 'normal' ? '再点一下看看别的' : (mood === 'sad' ? '余额不多了…' : '超支了！'))
      return
    }
    if (kind === 'rounds') {
      clearBubble()
      var r = data && data.rounds
      addLine('dshnw-label', '这些钱还能和奶娃聊')
      addLine('dshnw-amount', r && r.left !== null && r.left !== undefined ? r.left + ' 轮' : '—')
      addLine('dshnw-hint', '最近平均 ' + fmtMoney(r ? r.avg : 0, currency()) + ' / 轮')
      renderChart()
      return
    }
    if (kind === 'warn') {
      clearBubble()
      addLine('dshnw-label', (custom && custom.label) || '余额不足预警')
      addLine('dshnw-amount', fmtMoney(balance ? balance.totalBalance : 0, currency()))
      addLine('dshnw-hint', (custom && custom.hint) || '奶娃哭了…')
      return
    }
    if (kind === 'budget') {
      clearBubble()
      var b = (data && data.budget) || {}
      addLine('dshnw-label', (custom && custom.label) || '今日预算')
      addLine('dshnw-amount', fmtMoney(b.spent || 0, currency()) + ' / ' + fmtMoney(b.limit || 0, currency()))
      addLine('dshnw-hint', (custom && custom.hint) || '已经超额啦')
      renderProgress(b.ratio || 1)
      return
    }
    renderBalance() // 自己会 clearBubble()
  }

  function pickQuip(pool) {
    // 「不连续重复」按**台词文本**判断，不按下标 ——
    // 上下文不同会换池子（普通 / 哭脸 / 气鼓鼓），同一个下标在池子里是不同句子，
    // 按下标记就会漏掉「换池后仍显示同一句」的情况。
    var total = 0
    var i
    for (i = 0; i < pool.length; i++) total += pool[i].w
    for (var guard = 0; guard < 10; guard++) {
      var r = Math.random() * total
      for (i = 0; i < pool.length; i++) {
        r -= pool[i].w
        if (r <= 0) {
          if (pool[i].t === lastQuipText && pool.length > 1) break // 换一句重抽
          lastQuipText = pool[i].t
          return pool[i].t
        }
      }
    }
    // 极端情况（池子里只有一句）也要给个结果
    var fallback = pool.find(function (q) { return q.t !== lastQuipText }) || pool[0]
    lastQuipText = fallback.t
    return fallback.t
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
  }

  function renderBalance(animFrom) {
    // 必须自己清空：本函数会被 refresh() 的收尾逻辑直接调用（不经过 renderBubble）
    clearBubble()
    if (costActive) return
    if (!data && !balance) {
      addLine('dshnw-label', '奶娃在算账…')
      addLine('dshnw-amount', '…')
      addLine('dshnw-hint', loadError || '正在读取余额')
      return
    }
    if (data && data.ok === false && !balance) {
      addLine('dshnw-label', '余额读取失败')
      addLine('dshnw-amount', '—')
      addLine('dshnw-hint', String(data.error || '').slice(0, 40))
      return
    }
    addLine('dshnw-label', mood === 'sad' ? '奶娃的余额（好少）' : '奶娃的余额')
    var amountNode = addLine('dshnw-amount', fmtMoney(balance ? balance.totalBalance : 0, currency()))
    var bits = []
    if (data && data.peak) bits.push((data.peak.isPeak ? '🔥 ' : '🍃 ') + data.peak.label)
    var u = data && data.usage
    bits.push(u && u.todayUsage > 0 ? '今日已用 ' + fmtMoney(u.todayUsage, currency()) : '今日还没花钱')
    addLine('dshnw-hint', bits.join(' · '))
    if (animFrom !== undefined && animFrom !== null && balance) {
      rollNumber(amountNode, animFrom, balance.totalBalance, currency())
    }
    var b = data && data.budget
    if (b && b.enabled && b.ratio !== null) renderProgress(b.ratio)
  }

  function renderProgress(ratio) {
    var wrap = el('div', 'dshnw-prog' + (ratio >= 1 ? ' dshnw-over' : ''), bubbleHost)
    var fill = el('i', '', wrap)
    fill.style.width = Math.max(2, Math.min(100, ratio * 100)) + '%'
  }

  function renderChart() {
    var days = (data && data.daily) || []
    if (!days.length) return
    var max = 0
    for (var i = 0; i < days.length; i++) max = Math.max(max, days[i].amount)
    var wrap = el('div', 'dshnw-chartwrap', bubbleHost)
    var chart = el('div', 'dshnw-chart', wrap)
    var labels = el('div', 'dshnw-chartlabels', wrap)
    for (var j = 0; j < days.length; j++) {
      var d = days[j]
      var col = el('div', 'dshnw-bar' + (d.isToday ? ' dshnw-today' : ''), chart)
      var bar = el('i', '', col)
      var pct = max > 0 ? Math.max(2, (d.amount / max) * 100) : 2
      bar.style.height = pct + '%'
      bar.title = d.date + ' ¥' + Number(d.amount).toFixed(4)
      // 日期标签放在图表区域内、柱子下方，避免它挤占柱子的高度
      labels.appendChild(el('span', 'dshnw-bar-label' + (d.isToday ? ' dshnw-today' : ''), null)).textContent = d.label
    }
  }

  function rollNumber(node, from, to, cur) {
    if (rollRaf) cancelAnimationFrame(rollRaf)
    var start = performance.now()
    var dur = 720
    function step(now) {
      var t = Math.min(1, (now - start) / dur)
      var e = 1 - Math.pow(1 - t, 3)
      node.textContent = fmtMoney(from + (to - from) * e, cur)
      if (t < 1) rollRaf = requestAnimationFrame(step)
      else rollRaf = null
    }
    rollRaf = requestAnimationFrame(step)
  }

  // ---------------------------------------------------------------- 情绪 / 提醒
  function applyMood() {
    var next = 'normal'
    if (data && data.budget && data.budget.exceeded) next = 'angry'
    else if (data && data.warn && data.warn.active) next = 'sad'
    if (next === mood) return
    mood = next
    root.setAttribute('data-mood', mood)
    root.classList.toggle('dshnw-mood-sad', mood === 'sad')
  }

  function checkAlerts() {
    if (!data || !data.ok) return
    // 余额预警：进入低位提示一次；充值回高位后重新武装
    if (data.warn && data.warn.enabled) {
      if (data.warn.active && !warnFired) {
        warnFired = true
        showBubbleKind('warn', 8, {
          label: '奶娃哭了：余额不足',
          hint: '低于 ' + fmtMoney(data.warn.below, currency()) + ' 了',
        })
        sfx('sad')
        spawnParticles('💧', 3)
      } else if (!data.warn.active) {
        warnFired = false
      }
    }
    // 今日预算：当天第一次超额提示一次
    if (data.budget && data.budget.enabled && data.budget.exceeded) {
      var today = (data.usage && data.usage.date) || ''
      var remembered = store.get(BUDGET_DAY_KEY)
      if (budgetFiredDay === null && remembered) budgetFiredDay = remembered
      if (budgetFiredDay !== today) {
        budgetFiredDay = today
        store.set(BUDGET_DAY_KEY, today)
        showBubbleKind('budget', 8, { label: '今日预算超了', hint: '奶娃气鼓鼓' })
        sfx('angry')
        root.classList.add('dshnw-happy')
        setTimeout(function () { root.classList.remove('dshnw-happy') }, 900)
      }
    }
  }

  // ---------------------------------------------------------------- 余额刷新
  var refreshing = false

  function refresh(force) {
    if (refreshing) return Promise.resolve()
    refreshing = true
    var prev = balance ? balance.totalBalance : null
    var prevCur = balance ? balance.currency : null
    return api(PREFIX + '/balance.json' + (force ? '?refresh=1' : ''))
      .then(function (payload) {
        refreshing = false
        if (!payload || typeof payload !== 'object') return
        data = payload
        if (payload.ok) {
          var changed = prev !== null && Math.abs(payload.totalBalance - prev) > 1e-9
          balance = { totalBalance: payload.totalBalance, currency: payload.currency }
          loadError = ''
          applyMood()
          if (bubbleWrap.classList.contains('dshnw-open')) {
            if (bubbleKind === 'balance') renderBalance(changed && prevCur === payload.currency ? prev : null)
            else if (bubbleKind === 'rounds') renderBubble('rounds')
          }
          if (changed && prevCur === payload.currency) playBalanceChange(prev, payload.totalBalance)
          checkAlerts()
        } else {
          loadError = String(payload.error || '未知错误')
        }
      })
      .catch(function (err) {
        refreshing = false
        loadError = String((err && err.message) || err)
      })
  }

  function playBalanceChange(prev, next) {
    if (next < prev) {
      root.classList.add('dshnw-sigh')
      setTimeout(function () { root.classList.remove('dshnw-sigh') }, 620)
    } else if (next > prev) {
      root.classList.add('dshnw-happy')
      setTimeout(function () { root.classList.remove('dshnw-happy') }, 900)
      sfx('happy')
      spawnHearts(2)
    }
  }

  // ---------------------------------------------------------------- 状态轮询（每轮消耗 / 活动态）
  function pollStatus() {
    api(PREFIX + '/turn.json').then(function (res) {
      if (!res || !res.ok) return
      var act = res.activity || {}
      var nextState = act.state || 'idle'
      if (root.getAttribute('data-activity') !== nextState) root.setAttribute('data-activity', nextState)
      var seq = Number(res.seq) || 0
      var stored = Number(store.get(TURN_SEQ_KEY) || 0)
      if (lastTurnSeq === null) {
        lastTurnSeq = Math.max(seq, stored)
        store.set(TURN_SEQ_KEY, String(lastTurnSeq))
      } else if (seq > lastTurnSeq) {
        lastTurnSeq = seq
        store.set(TURN_SEQ_KEY, String(seq))
        var turn = res.turn
        if (turn && state.turnCostOn) {
          showBubbleKind('cost', state.turnCostCloseSec, {
            label: '上一轮奶娃花了',
            amount: fmtMoney(turn.amount, currency()),
            hint: Math.round(turn.tokens / 1000) + 'k tokens' + (turn.model ? ' · ' + turn.model : ''),
          })
          sfx('turn')
          spawnCoins()
        }
        refresh(false)
      }
    }).catch(function () { /* 轮询失败静默 */ })
  }

  // ---------------------------------------------------------------- 菜单 / 面板定位
  function placeAbove(elm, r) {
    elm.style.visibility = 'hidden'
    var mw = elm.offsetWidth
    var mh = elm.offsetHeight
    var left = state.snapH === 'left' ? r.left : r.right - mw
    left = Math.max(8, Math.min(window.innerWidth - mw - 8, left))
    var top = r.top - mh - 8
    if (top < 8) top = Math.min(window.innerHeight - mh - 8, r.bottom + 8)
    elm.style.left = Math.round(left) + 'px'
    elm.style.top = Math.round(top) + 'px'
    elm.style.visibility = ''
  }

  function placeMenu() {
    if (!menuOpen || !btn) return
    placeAbove(menuEl, btn.getBoundingClientRect())
  }

  function placePanel() {
    if (!panelOpen || !btn) return
    placeAbove(panelEl, btn.getBoundingClientRect())
  }

  function toggleMenu() { menuOpen ? closeMenu() : openMenu() }

  function openMenu() {
    closePanel()
    menuOpen = true
    menuEl.classList.add('dshnw-open')
    root.classList.add('dshnw-menu-open')
    var range = menuEl.querySelector('.dshnw-range')
    range.value = String(state.scale)
    menuEl.querySelector('.dshnw-mval').textContent = state.scale.toFixed(2) + '×'
    menuEl.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.checked = !!state[cb.getAttribute('data-k')]
    })
    placeMenu()
  }

  function closeMenu() {
    if (!menuOpen) {
      closePanel()
      return
    }
    menuOpen = false
    menuEl.classList.remove('dshnw-open')
    root.classList.remove('dshnw-menu-open')
    closePanel()
  }

  function togglePanel() { panelOpen ? closePanel() : openPanel() }

  function openPanel() {
    panelOpen = true
    panelEl.querySelector('[data-n=warnBelow]').value = String(state.warnBelow)
    panelEl.querySelector('[data-n=budget]').value = String(state.budget)
    panelEl.classList.add('dshnw-open')
    placePanel()
  }

  function closePanel() {
    if (!panelOpen) return
    panelOpen = false
    panelEl.classList.remove('dshnw-open')
  }

  // ---------------------------------------------------------------- 音效（WebAudio 合成，无音频文件）
  var actx = null

  function audio() {
    if (!actx) {
      var C = window.AudioContext || window.webkitAudioContext
      if (!C) return null
      actx = new C()
    }
    if (actx.state === 'suspended') actx.resume().catch(function () {})
    return actx
  }

  // 必须在用户手势里创建/恢复 AudioContext，否则首次点击常常没声音
  function warmupAudio() {
    try { audio() } catch (err) {}
  }

  function tone(freq, dur, type, gain, delay, slideTo) {
    var a = audio()
    if (!a) return
    var t0 = a.currentTime + (delay || 0)
    var osc = a.createOscillator()
    var g = a.createGain()
    osc.type = type || 'sine'
    osc.frequency.setValueAtTime(freq, t0)
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g)
    g.connect(a.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.03)
  }

  // 音符：[频率, 延迟, 时长, 波形, 音量]
  function melody(notes) {
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i]
      tone(n[0], n[2] || 0.14, n[3] || 'sine', n[4] || 0.09, n[1] || 0)
    }
  }

  // 按压音随机三选一，点起来不会腻
  var PRESS_VARIANTS = [
    [[520, 0, 0.09, 'sine', 0.10]],
    [[430, 0, 0.10, 'triangle', 0.10]],
    [[300, 0, 0.08, 'sine', 0.09]],
  ]

  function sfx(kind) {
    if (!state.sound) return
    try {
      if (kind === 'press') {
        melody(PRESS_VARIANTS[Math.floor(Math.random() * PRESS_VARIANTS.length)])
      } else if (kind === 'release') {
        melody([[380, 0, 0.12, 'sine', 0.085], [640, 0.05, 0.1, 'sine', 0.05]])
      } else if (kind === 'chirp') {
        tone(760, 0.09, 'triangle', 0.075, 0)
        tone(1180, 0.09, 'triangle', 0.05, 0.07)
      } else if (kind === 'turn') {
        melody([[660, 0, 0.12], [990, 0.10, 0.16], [1320, 0.20, 0.18, 'sine', 0.055]])
      } else if (kind === 'coin') {
        melody([[988, 0, 0.09, 'triangle', 0.09], [1319, 0.06, 0.14, 'triangle', 0.07]])
      } else if (kind === 'happy') {
        melody([[784, 0, 0.1], [1047, 0.08, 0.1], [1319, 0.16, 0.16]])
      } else if (kind === 'sad') {
        tone(660, 0.22, 'sine', 0.085, 0, 330)
        tone(494, 0.2, 'sine', 0.06, 0.18, 262)
      } else if (kind === 'angry') {
        melody([[196, 0, 0.16, 'square', 0.05], [165, 0.16, 0.22, 'square', 0.05]])
      }
    } catch (err) {
      /* 没声音不影响功能 */
    }
  }

  // ---------------------------------------------------------------- 持久化
  var store = {
    get: function (k) {
      try { return window.localStorage.getItem(k) } catch (e) { return null }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, v) } catch (e) {}
    },
  }

  var saveTimer = null

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      api(PREFIX + '/config.json', 'PUT', {
        scale: state.scale,
        sound: state.sound,
        bubbleOn: state.bubbleOn,
        snap: state.snap,
        turnCostOn: state.turnCostOn,
        turnCostCloseSec: state.turnCostCloseSec,
      }).catch(function () {})
    }, 350)
  }

  function savePos() {
    store.set(POS_KEY, JSON.stringify({
      left: Math.round(state.left),
      top: Math.round(state.top),
      snapH: state.snapH,
      snapV: state.snapV,
      w: window.innerWidth,
      h: window.innerHeight,
    }))
  }

  function restorePos() {
    var raw = store.get(POS_KEY)
    if (!raw) return false
    try {
      var p = JSON.parse(raw)
      if (!p || typeof p.left !== 'number') return false
      state.left = p.left
      state.top = p.top
      state.snapH = p.snapH || null
      state.snapV = p.snapV || null
      var v = viewport()
      if (p.w && p.h && (Math.abs(p.w - v.w) > 4 || Math.abs(p.h - v.h) > 4)) {
        if (state.snapH === 'right') state.left = v.w - imgW - 16
        if (state.snapV === 'bottom') state.top = v.h - imgH - 16
      }
      return true
    } catch (err) {
      return false
    }
  }

  function api(url, method, payload) {
    return fetch(url, {
      method: method || 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return null })
    })
  }

  // ---------------------------------------------------------------- 监听
  function bind() {
    root.addEventListener('pointerdown', onPointerDown)
    root.addEventListener('pointermove', onPointerMove)
    root.addEventListener('pointerup', onPointerUp)
    root.addEventListener('pointercancel', onPointerUp)
    root.addEventListener('dblclick', onDblClick)
    root.addEventListener('contextmenu', onContextMenu)
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleMenu()
    })
    document.addEventListener('pointerdown', function (e) {
      if (!menuOpen && !panelOpen) return
      if (menuEl.contains(e.target) || panelEl.contains(e.target) || root.contains(e.target)) return
      closeMenu()
    }, true)
    window.addEventListener('resize', function () {
      clampPosition()
      if (state.snap) settle()
      else place()
      placeMenu()
      placePanel()
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu()
    })
    // 切回本页时补一次刷新（后台 tab 的定时器会被浏览器节流）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh(false)
    })
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    if (!document.body) return
    if (state.ready) return // 幂等：只启动一次
    injectStyle()
    buildDom()
    bind() // ← 必须在这里：DOM 建好之后才存在 root / btn / menuEl
    img.addEventListener('load', function () {
      naturalW = img.naturalWidth || 0
      naturalH = img.naturalHeight || 0
      applyScale(false)
      api(PREFIX + '/config.json').then(function (cfg) {
        if (cfg && cfg.ok) {
          if (typeof cfg.scale === 'number') state.scale = cfg.scale
          var boolKeys = ['sound', 'bubbleOn', 'snap', 'turnCostOn']
          for (var i = 0; i < boolKeys.length; i++) {
            if (typeof cfg[boolKeys[i]] === 'boolean') state[boolKeys[i]] = cfg[boolKeys[i]]
          }
          if (typeof cfg.turnCostCloseSec === 'number') state.turnCostCloseSec = cfg.turnCostCloseSec
          if (typeof cfg.warnBelow === 'number') state.warnBelow = cfg.warnBelow
          if (typeof cfg.budget === 'number') state.budget = cfg.budget
        }
      }).catch(function () {}).then(function () {
        applyScale(false)
        if (!restorePos()) {
          var v = viewport()
          state.left = v.w - imgW - 24
          state.top = v.h - imgH - 18
        }
        clampPosition()
        place()
        state.ready = true
        refresh(false)
        pollStatus()
        setInterval(function () { refresh(false) }, BALANCE_REFRESH_MS)
        setInterval(pollStatus, STATUS_POLL_MS)
      })
    })
    img.addEventListener('error', function () {
      loadError = '奶娃立绘加载失败（assets/naiwa.png 缺失？）'
    })
    if (img.complete && img.naturalWidth) img.dispatchEvent(new Event('load'))
  }

  // 注意：bind() 必须在 buildDom() 之后（在 boot() 里）调用 —— 此刻 root/btn/menuEl 都还不存在，
  // 提前调用会立刻抛 TypeError 并让整个 IIFE 挂掉（挂件完全不出现）。
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  // ---------------------------------------------------------------- 自检钩子
  // 固定名字，供 tools/browser-check.mjs 在无头浏览器里驱动挂件做真机测试。
  // 只读/受控操作，不改变正常行为；要关掉它把这一行删掉即可。
  window.__dshNaiwaTestHooks = {
    snapshot: function () {
      return {
        bubbleOpen: !!(bubbleWrap && bubbleWrap.classList.contains('dshnw-open')),
        bubbleKind: bubbleKind,
        clickStep: clickStep,
        mood: mood,
        costActive: costActive,
        scale: state.scale,
        warnBelow: state.warnBelow,
        budget: state.budget,
        balance: balance,
        data: data,
        fxCount: fxEl ? fxEl.children.length : 0,
      }
    },
    // 测试用：把气泡连同「消耗泡泡占用」状态一起收干净，否则下一次点击不会换内容
    closeBubble: function () { hideBubble(); clickStep = 0 },
    // 测试用：只重置点击序列，不清气泡
    resetClicks: function () { clickStep = 0 },
    // 测试用：直接渲染某一种气泡（不走网络刷新，方便配合 overrideBalance 做受控断言）
    renderKind: function (kind) { showBubbleKind(kind, 0) },
    // 测试用：立刻拉一次余额（并重算情绪 / 提醒）
    refreshNow: function (force) { return refresh(force !== false) },
    // 测试用：直接推进点击序列（等价于点一下奶娃）
    petClick: function () { onPetClick() },
    action: function (kind) { flashAction(kind) },
    // 测试用：伪造一份余额响应（走的是真实的情绪 / 提醒计算路径，只是换了数字）。
    // 真实环境里余额不会按测试需要变动，所以这里给一个受控入口。
    overrideBalance: function (patch) {
      data = Object.assign({}, data || { ok: true, currency: 'CNY' }, patch)
      if (data.ok) {
        balance = { totalBalance: Number(data.totalBalance), currency: data.currency || 'CNY' }
      }
      applyMood()
      checkAlerts()
      return { mood: mood, warnActive: !!(data.warn && data.warn.active), budgetExceeded: !!(data.budget && data.budget.exceeded) }
    },
  }
})()
