/**
 * 渲染层颜色扫描 —— 守「theme.css 是唯一颜色源，渲染层不准出现 hex / rgb 字面量」。
 *
 * 为什么需要它：code-review 查出 PartitionEditor / KconfigEditor 两个新组件共 30+ 处
 * 硬编码 `#333 / #ddd / #151515`，换主题时这两个弹窗完全不跟随。修完之后必须有扫描兜底，
 * 否则下次加组件又会抄一遍 hex。
 *
 * 白名单（**唯一**允许的两种 hex，别再往外扩）：
 *   1. `cssColor('--token', '#xxxxxx')` 的第二个参数 —— Canvas 2D 不认 var()，
 *      必须给一个能直接用的真值（见 SerialPlotter）。
 *   2. 白名单常量块（如 CAT_FALLBACKS）里紧邻 `cssColor` 兜底用的数组。
 * 除这两处外，任何 hex / rgb() 都算违规。
 *
 * 自查：本脚本对当前仓库应报 0 命中；若报了，先确认是不是真的违规，别改判据迁就代码。
 *
 * 用法：node scripts/scan-renderer-hex.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT_DIRS = ['src/renderer/src']
const SKIP_FILES = new Set(['theme.css'])
const HEX = /#[0-9a-fA-F]{3,8}\b/g
const RGB = /\brgba?\(/g

/** 收集所有 .ts / .tsx（theme.css 由 generate 方单独管，css 走 grep 另说） */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const abs = join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(abs, out)
    else if (/\.(ts|tsx)$/.test(name) && !SKIP_FILES.has(name)) out.push(abs)
  }
  return out
}

/** 把代码里所有 cssColor(...) 兜底参数的字符区间标成白名单 */
function cssColorRanges(text) {
  const ranges = []
  const re = /cssColor\s*\(/g
  let m
  while ((m = re.exec(text))) {
    // 从 '(' 起做一次括号配平，取整个调用区间
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    ranges.push([m.index, Math.min(i + 1, text.length)])
  }
  return ranges
}

/** 兜底常量块：紧跟在 cssColor 相关注释/声明附近的字符串数组，这里按变量名白名单 */
const FALLBACK_BLOCK_RE = /const\s+[A-Z_]*(?:FALLBACK|PALETTE)[A-Z_]*\s*=\s*\[[\s\S]*?\]/g
function fallbackRanges(text) {
  const ranges = []
  let m
  while ((m = FALLBACK_BLOCK_RE.exec(text))) ranges.push([m.index, m.index + m[0].length])
  return ranges
}

const inRanges = (ranges, idx) => ranges.some(([a, b]) => idx >= a && idx < b)

const files = ROOT_DIRS.flatMap((d) => walk(d))
let hits = 0
const details = []

for (const file of files) {
  const text = readFileSync(file, 'utf-8')
  const allow = [...cssColorRanges(text), ...fallbackRanges(text)]
  const lines = text.split(/\r?\n/)
  let offset = 0
  lines.forEach((line, li) => {
    const lineStart = offset
    offset += line.length + 1
    const stripped = line.replace(/\/\/.*$/, '')
    for (const re of [HEX, RGB]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(stripped))) {
        const abs = lineStart + m.index
        if (inRanges(allow, abs)) continue
        hits++
        if (details.length < 40) {
          details.push(`  ${relative(process.cwd(), file)}:${li + 1}  ${stripped.trim().slice(0, 110)}`)
        }
      }
    }
  })
}

console.log(`\n=== 渲染层硬编码颜色扫描（${files.length} 个文件）===\n`)
if (hits === 0) {
  console.log('[OK] 未发现硬编码 hex / rgb（cssColor 兜底与 FALLBACK/PALETTE 常量块已豁免）')
} else {
  console.log(`[NG] 发现 ${hits} 处硬编码颜色（应改走 theme.css 令牌）：`)
  details.forEach((d) => console.log(d))
}
console.log(`\n命中：${hits}`)
process.exitCode = hits === 0 ? 0 : 1
