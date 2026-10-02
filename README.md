# DSH 奶娃余额挂件（dsh-naiwa-widget）

DeepSeek Harness（DSH）Web 界面角落里的常驻小挂件：**奶娃立绘 + 代码绘制的对话气泡**，
气泡里实时显示 **DeepSeek 余额**、**今日已用** 与 **峰谷时段**；一轮对话结束还会冒泡告诉你
**这一轮花了多少钱**。奶娃可以拖到任意角落、四边吸附、贴左缘时整个人（和气泡文字）水平镜像，
按下去会 Q 弹一下并发出合成音效。

> 参考原型：[B站「Dsh大肥鱼-余额挂件」](https://www.bilibili.com/video/BV14AYy6REy6/)（[开源仓库](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)）。
> 本插件是同思路的独立实现，主角换成奶娃，第一版只做核心闭环（立绘/气泡/余额/拖拽）。

![奶娃](assets/naiwa.png)

---

## 功能（v0.1.0）

| 分类       | 能力                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| 立绘       | 奶娃 cut-out 立绘（透明底 PNG），无图片也能跑（会提示加载失败）                                                                                      |
| 气泡       | 纯 SVG + CSS 代码绘制的圆角气泡（大椭圆 + 尾巴 + 两个小气泡），任意缩放不糊                                                                              |
| **点击玩法** | 连点奶娃会**依次换内容**：① 余额大数字 → ② 随机台词 → ③ 还能聊多少轮 + 近 7 天柱状图 → ④ 再换一句台词 → ⑤ 收起，循环；**每次点击还会随机附送一个小动作**（爱心 / 蹦跶 / 转圈 / 惊叹 / 装死 / 晕圈） |
| 台词库      | 18 句普通台词 + 4 句哭脸台词 + 4 句超支台词，**带权重抽样**且同一句不连续重复                                                                             |
| 表情       | 余额低于阈值 → **流眼泪**（呼吸引擎放慢）；今日预算超额 → **冒热气 + 腮红**（气鼓鼓）。纯 CSS 叠加在立绘上，不需要多张差分图                                                   |
| 余额       | 60 秒自动刷新 + 点击奶娃手动刷新；余额变化时数字**滚动动画**；余额变多会「开心跳一下」+ 冒爱心                                                                       |
| 今日已用     | **免令牌记账**：按余额观测差值累计，跨天自动归零归档（保留 30 天）；充值时不会把消费冲掉                                                                            |
| 还能聊多少轮   | 余额 ÷ 本机最近 20 轮的**真实平均消耗**，换算成对话轮数                                                                                           |
| 近 7 天柱状图 | 脚边迷你柱状图，按金额比例出柱，今天是金色高亮                                                                                                     |
| 峰谷       | 高峰 / 空闲标识 + 下一个切换时间（周末全天谷价）                                                                                                 |
| 每轮消耗     | 监听 DSH 会话事件，按**真实 token usage**（input / cacheRead / output）与峰谷定价表结算；一轮结束弹消耗气泡 + **掉金币粒子 + 合成音效**                            |
| 余额预警     | 低于阈值弹提醒 + 奶娃变哭脸；充值回到阈值以上会自动「重新武装」                                                                                           |
| 今日预算     | 花超了弹提醒 + 奶娃气鼓鼓 + 气泡里显示进度条（超额变红）；当天只提醒一次                                                                                     |
| 待机表演     | 平时轻微上下浮动；**DSH 思考中 / 等你回答 / 等你授权** 换成不同的呼吸节奏                                                                                |
| 交互       | 左键拖拽移动、四边吸附、**贴左缘整体水平镜像**（气泡文字自动翻回可读）、按压 Q 弹、双击 / 右键唤出菜单                                                                    |
| 菜单       | 大小滑块（0.7×~2.4×）、气泡 / 音效 / 吸附开关、**额度设置**面板、刷新余额、今日归零                                                                         |
| 音效       | **WebAudio 实时合成**（按压 / 松开 / 啾 / 完成 / 金币 / 开心 / 叹气 / 生气），不需要任何音频文件                                                           |
| 安全       | 所有写接口只接受**本机回环来源**；跨站标记与不同源 Origin 一律 403；不接触你的账号令牌                                                                         |

### 怎么玩

| 操作       | 效果                                               |
| -------- | ------------------------------------------------ |
| 左键拖      | 移动奶娃；松手吸附到最近的边（四边吸附，角落可组合）                       |
| 拖到左半边    | 整体水平镜像（转身朝屏幕里），气泡文字自动翻回可读                        |
| **连点奶娃** | ①余额 → ②台词 → ③轮数+柱状图 → ④台词 → ⑤收起，循环；每次点击附送一个随机小动作 |
| 按住       | 压扁一下 + 「啵」一声（Q 弹）                                |
| 双击 / 右键  | 打开菜单（大小、开关、额度设置、刷新、归零）                           |

### 余额从哪来

1. **`DEEPSEEK_API_KEY`（优先）** —— 走 DSH 凭据服务读，然后请求 `GET https://api.deepseek.com/user/balance`。
2. **DSH 账号登录态（没配 key 时自动兜底）** —— 只调 DSH 自己的 `deepseekAccount` 服务，token 与鉴权头全由 DSH 负责，**插件不碰账号令牌**。

两条路都不会把密钥写到磁盘或日志里。

---

## 安装

```bash
# 从本地目录安装（软链：改了源码立即生效）
dsh plugin --profile web add link:/Users/hr_chen/Desktop/奶娃插件/dsh-naiwa-widget

# 或者直接用当前目录
cd /Users/hr_chen/Desktop/奶娃插件/dsh-naiwa-widget
dsh plugin --profile web add link:.
```

> ⚠️ `link:` 是软链安装：**装完之后不要把插件目录移动或改名**，否则要重新 add 一次。

### ⚠️ 一定要重启 dsh web

`dsh plugin add` 只是把插件写进 profile 的 `dsh.profile.bundles`，**正在运行的那个 server 不会热加载它**。
必须重启 `dsh web`，然后浏览器硬刷新（`Cmd/Ctrl + Shift + R`）。

- 如果你是**在这个 DSH 会话里**让我装的：请到启动 `dsh web` 的那个终端 `Ctrl+C` 再重新 `dsh web`。
  （我无法自己重启 —— 那会把当前会话一起杀掉。）
- 重启后浏览器硬刷新一次，右下角就会出现奶娃。

### 卸载

```bash
dsh plugin --profile web remove dsh-naiwa-widget
```

---

## 装完怎么验证

### 一条命令自检（推荐）

```bash
cd /Users/hr_chen/Desktop/奶娃插件/dsh-naiwa-widget
node tools/verify-live.mjs
```

它会依次检查：路由是否已注册、`index.html` 是否注入了挂件脚本、余额接口是否返回真实余额、
配置读写与信任栅栏是否正常，并给出「已生效 / 需要重启」的明确结论。

### 手动验证

```bash
# ① 已注册的路由返回 JSON（重启前会拿到 SPA 的 HTML，这是未生效的标志）
curl -s http://127.0.0.1:8080/dsh-naiwa/health.json

# ② 页面里应当出现注入的 <script>
curl -s http://127.0.0.1:8080/ | grep -o 'dsh-naiwa/widget.js'

# ③ 余额
curl -s http://127.0.0.1:8080/dsh-naiwa/balance.json
```

> 注意：`/dsh-naiwa/*` 的**写**接口（PUT）只接受回环地址；读接口在局域网里也能看。
> 用裸 `curl` 打不存在的路径时，DSH 的 SPA 兜底会返回 200 + HTML —— 所以**不能只看状态码**，
> 要看返回体是不是我们插件的 JSON。

---

## 路由清单

| 路由                        | 方法        | 说明                                                                                                             |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `/dsh-naiwa/naiwa.png`    | GET       | 奶娃立绘（按 mtime 热读，改了硬刷新即生效）                                                                                      |
| `/dsh-naiwa/widget.js`    | GET       | 前端挂件本体（按 mtime 热读）                                                                                             |
| `/dsh-naiwa/balance.json` | GET       | `{ok,totalBalance,currency,usage,daily(近7天),warn,budget,rounds,peak,updatedAt}`；`?refresh=1` 强制刷新              |
| `/dsh-naiwa/usage.json`   | GET       | 逐日已用（`?days=7`，2~30 天），供柱状图单独取数                                                                                |
| `/dsh-naiwa/turn.json`    | GET       | `{ok,seq,turn:{amount,tokens,model},activity:{state,label}}` —— 供前端轮询做消耗提示与待机表演                                |
| `/dsh-naiwa/config.json`  | GET / PUT | 外观、开关、`warnBelow`（余额预警）、`budget`（今日预算）、`rebaseBudget`、`resetUsage`（`$DSH_HOME/.dshnw-config.json`）；PUT 只接受本机来源 |
| `/dsh-naiwa/health.json`  | GET       | 自检：插件版本、资源是否齐全、配置文件路径                                                                                          |

`activity.state` 取值：`idle` / `thinking` / `waiting`（等你回答或授权）。

---

## 目录结构

```text
dsh-naiwa-widget/
├── package.json            # DSH bundle 插件元数据（dsh.bundle.patch → cordis.patch.yml）
├── cordis.patch.yml        # 挂载声明
├── lib/index.js            # 宿主本体：路由 / 余额 / 记账 / 会话事件 / 注入
├── assets/
│   ├── naiwa.png           # 奶娃立绘（透明底，839×760）
│   ├── naiwa-widget.js     # 前端挂件本体（样式内联在里面，自包含）
│   └── naiwa-widget.css    # 同一份样式的可读副本（方便改；改完请同步回 js 里的 CSS 数组）
├── tools/
│   ├── selftest.mjs        # 离线自检：49 项（路由 / 记账 / 定价 / 预警 / 预算 / 信任栅栏 / 注入）
│   ├── browser-check.mjs   # 无头 Chrome 真机自检：61 项（DOM / 点击玩法 / 气泡去重 / 表情 / 图表 / 像素）
│   ├── diag-interaction.mjs# 交互问题排查工具
│   ├── sync-css.mjs        # 把 js 里内联的 CSS 同步成可读的 .css
│   └── verify-live.mjs     # 装完之后的一键验收
└── README.md
```

运行时数据（都在 `$DSH_HOME`，默认 `~/.dsh`）：

| 文件                   | 用途                          |
| -------------------- | --------------------------- |
| `.dshnw-config.json` | 外观与开关（大小、音效、吸附、每轮消耗提示开关与秒数） |

前端把**位置**存在浏览器 `localStorage` 的 `dshnw-pos`，**已提示过的轮次序号**存在 `dshnw-last-seq`。

---

## 开发与维护

```bash
cd /Users/hr_chen/Desktop/奶娃插件/dsh-naiwa-widget

# 离线自检（不需要 dsh web，也不会碰你的 profile；只读一次本机 API key 去拉真实余额）
DSH_HOME=/tmp/naiwa-test node tools/selftest.mjs

# 无头 Chrome 真机自检（真的开一个页面加载挂件、点它、拖它、截图分析像素）
DSH_HOME=/tmp/naiwa-test node tools/browser-check.mjs --shot /tmp/naiwa-shot.png
```

**热更新规则（很重要）**：

| 你改了什么                        | 怎么生效                       |
| ---------------------------- | -------------------------- |
| `assets/naiwa-widget.js`（前端） | 浏览器**硬刷新**即可（宿主按 mtime 热读） |
| `assets/naiwa.png`（立绘）       | 浏览器硬刷新即可                   |
| `lib/index.js`（宿主）           | 必须**重启 `dsh web`**         |

### 换成你自己的奶娃图

把新的透明底 PNG 覆盖 `assets/naiwa.png` 就行（建议高度 ≥ 700px、比例接近 1:1.1）。
必须让**脚下贴住图片底边**，挂件是按底边对齐的。

素材来源：仓库初版立绘由 `奶蛙图片1.png` 自动抠图生成（从四边 flood-fill 去白底 + 羽化边缘）。

### 定价表

在 `lib/index.js` 顶部：`PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE` / `PRICING`
（单位：**元 / 百万 token**，数组为 `[空闲价, 高峰价]`）。DeepSeek 官方调价时改这里。

高峰时段 = 工作日 9:00–12:00 与 14:00–18:00（北京时间）；周末全天按谷价。

---

## 修复记录

### 余额显示两遍（2026-10-02 修）

**现象**：气泡里「奶娃的余额 / ¥xx.xx」整块出现两次。

**根因**：`renderBubble()` 会在开头 `clearBubble()`，但 `refresh()` 的收尾逻辑是**直接**调
`renderBalance()` 的（不经过 `renderBubble`）。于是链路变成：

```
点一下奶娃 → showBubbleKind('balance') → renderBubble() → clearBubble() + 画 4 行   ✅ 正常
余额刷新回来 → refresh() 收尾 → renderBalance()  ← 没有 clearBubble()，又画了 4 行  ❌ 叠加成 8 行
```

也就是说：**首屏正常，只要余额刷新一次就会翻倍**（第一次刷新不影响，因为首屏那次画的时候
气泡里还是空的 —— 所以很容易漏测）。

**修法**（两层，缺一不可）：

1. **谁画内容谁负责清**：`renderBalance()` 自己开头 `clearBubble()`；`renderBubble()` 的每个分支
   也各自清一次（而不是在函数开头清一次然后指望所有分支都走它）。
2. **结构自愈兜底**：`addLine()` 在写入 `label / amount / hint / quip` 前，若发现气泡里已经有同类
   元素就先清空 —— 以后谁再忘了清，也不会显示两遍。

**回归测试**：`tools/browser-check.mjs` 的 `[7b]` 小节专门压这条路径 —— 连打 4 次余额重绘、
2 次真实网络刷新、轮换 8 种气泡类型、连点 20 下，每一步都断言
「`label / amount / hint / quip / prog` 各自 ≤ 1 个，总行数 ≤ 5」。这个 bug 若复发会立刻红灯。

## 已知限制（第一版有意留白）

- 没有**自定义泡泡编辑器**（参考插件那套模块化排版很重，第一版不做）。
- 没有**多厂商余额**（只支持 DeepSeek 内置），没有 Codex 本地会话统计。
- 表情是**单张立绘 + CSS 叠加**（眼泪 / 热气 / 腮红 / 粒子）。要真正的多套差分表情，得再提供奶娃的不同姿势图。
- 音效是 WebAudio 合成的电子音，**不能导入自己的音频文件**（要导入的话告诉我，加一条路由就能接）。
- 没有 Codex 本地会话统计。
- 「今日已用」是**余额观测口径**：统计从本次观测开始，起点之前的消费不计入；充值不会冲掉已有消费，
  但充值前后的数字需要靠「今日归零」重新对齐（菜单里的按钮）。
- 音效是 WebAudio 合成的，没有内置音频文件、也不能导入自己的音频。
- 官方**桌面端（Electron）**：插件会推一条结构化注入行（内联 script），但没有实机验证过。

---

## 许可

MIT。
