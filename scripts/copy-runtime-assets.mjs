/**
 * 把「不属于源码、但打包必须带上」的运行时资源拷进 electron-vite 的产物目录。
 * 为什么独立成脚本：
 *   - 原先用 npm 脚本里嵌 powershell 的 Copy-Item，本环境跑不通，而且**只拷了 proto**，
 *     漏掉了 plugins/arduino-toolchain/ui —— 结果打包后左侧「平台管理 / 库管理 / 设置」
 *     三个 iframe 全是 404（src 里有、out 里没有）。
 *   - 用 node 递归复制，跨平台、可打印核对清单，也方便打完包 grep 自检。
 *
 * 用法（build 之后、electron-builder 之前）：
 *   node scripts/copy-runtime-assets.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const outDir = join(projectRoot, 'out', 'main')

/** [源（相对项目根）, 目标（相对 out/main）] */
const ASSETS = [
  ['src/main/proto', 'proto'],
  ['src/main/plugins/arduino-toolchain/ui', 'plugins/arduino-toolchain/ui']
]

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  let n = 0
  for (const entry of readdirSync(src)) {
    const s = join(src, entry)
    const d = join(dest, entry)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else {
      cpSync(s, d)
      n++
    }
  }
  return n
}

if (!existsSync(outDir)) {
  console.error(`[copy-assets] 找不到构建产物目录：${outDir}\n        先跑 electron-vite build 再跑本脚本。`)
  process.exit(1)
}

let total = 0
for (const [srcRel, destRel] of ASSETS) {
  const src = join(projectRoot, srcRel)
  const dest = join(outDir, destRel)
  if (!existsSync(src)) {
    console.warn(`[copy-assets] 跳过（源不存在）：${srcRel}`)
    continue
  }
  const n = copyDir(src, dest)
  total += n
  console.log(`[copy-assets] ${srcRel} → out/main/${destRel}（${n} 个文件）`)
}
console.log(`[copy-assets] 复制完成，共 ${total} 个文件`)
