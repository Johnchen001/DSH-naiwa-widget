/**
 * 把 assets/naiwa-widget.js 里内联注入的 CSS 数组同步成可读的 assets/naiwa-widget.css。
 * 真正生效的是 js 里那份（插件自包含，不额外占路由）；这个文件只用来看和改。
 *
 * 用法：node tools/sync-css.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const JS_FILE = path.join(HERE, '..', 'assets', 'naiwa-widget.js')
const CSS_FILE = path.join(HERE, '..', 'assets', 'naiwa-widget.css')

const src = fs.readFileSync(JS_FILE, 'utf8')
const block = /var CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(src)
if (!block) {
  console.error('❌ 在 naiwa-widget.js 里找不到 `var CSS = [...]` 数组')
  process.exit(1)
}

const rules = [...block[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
if (!rules.length) {
  console.error('❌ CSS 数组里没解析出任何规则')
  process.exit(1)
}

const header = `/* 由 tools/sync-css.mjs 从 assets/naiwa-widget.js 的 CSS 数组自动生成，仅供阅读。
 * 真正生效的是 naiwa-widget.js 里内联注入的那份 —— 改样式请改 js，然后重跑：
 *   node tools/sync-css.mjs
 */\n\n`

const body = rules.map((rule) => rule.replace(/\}/g, '}\n').trim()).join('\n')
fs.writeFileSync(CSS_FILE, header + body + '\n', 'utf8')

// 反过来校验：css 里的规则条数应当与数组一致
const written = fs.readFileSync(CSS_FILE, 'utf8')
const writtenRules = written.split('\n').filter((l) => l.includes('{') && l.includes('}')).length
console.log(`✅ 已同步 ${rules.length} 条规则 → ${path.relative(process.cwd(), CSS_FILE)}（解析到 ${writtenRules} 条）`)
