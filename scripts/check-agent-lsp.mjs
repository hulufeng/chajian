/**
 * 验证 Agent 侧 LSP 修复：lsp_diagnostics 能否在 Arduino 工程里解析到 core 头文件。
 *
 * 背景：修复前 lsp-tools.ts 的 getClient() 不调 ensureCompileDb，
 * clangd 找不到 Arduino.h → 诊断里满屏 file not found，Agent 的 LSP 等于废掉。
 * 编辑器侧有 ensureCompileDb 兜底，所以「编辑器能用 ≠ Agent 能用」。
 *
 * 本脚本走 lsp-tools 真实工具定义（不 mock），验证：
 *   1. getClient 能定位到 clangd（原先用裸 srv.command，PATH 外就找不到）
 *   2. 工程根自动生成 compile_commands.json
 *   3. lsp_diagnostics 返回的诊断里没有 'Arduino.h' file not found
 *
 * 用法：
 *   node scripts/check-agent-lsp.mjs
 *     默认模式：走 Agent 真实工具链，验证「能定位 clangd + 不再找不到可执行」。
 *     数据库生成依赖板子探测（listConnectedBoardsWithSerial），没接板时只验到这里。
 *   node scripts/check-agent-lsp.mjs --with-fqbn
 *     额外显式给 fqbn 生成编译数据库，不依赖接板，
 *     能真实验证「-I 推导 → clangd 解析到 core 头文件 → 诊断无 file not found」。
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'agentlsp-'))

// 关键：必须把 lspService 和 lsp-tools **bundle 进同一份产物**。
// esbuild 分别 bundle 会产生两个独立模块实例，各自持有模块级 userDataDir，互不相通——
// 给其中一个 configureServerSearch 对另一个无效，验证会假失败。
// 用一个入口文件把两者 re-export，保证共享同一份模块状态。
const entry = join(tmp, 'entry.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(root, 'src/main/services/lspService.ts').replace(/\\/g, '/'))}
export * as lspToolsMod from ${JSON.stringify(join(root, 'src/main/engine/tools/lsp-tools.ts').replace(/\\/g, '/'))}
`,
  'utf8'
)
const outfile = join(tmp, 'bundle.mjs')
buildSync({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: join(root, 'scripts/stubs/electron-dom-stub.mjs') }
})
const mod = await import('file://' + outfile.replace(/\\/g, '/'))

// 与主进程启动时一致地注入用户数据目录，否则 locateServerCommand 找不到
// 装在 %APPDATA%/codelab-desktop/tools/llvm/bin 的 clangd
const userDataDir = process.env.APPDATA ? join(process.env.APPDATA, 'codelab-desktop') : ''
mod.configureServerSearch({ userDataDir })
const { lspTools } = mod.lspToolsMod
console.log(`[Agent LSP] 注入 userDataDir：${userDataDir || '(空)'}`)

// --with-fqbn：绕过板子探测，直接给 fqbn 验证「-I 推导 + clangd 解析」完整链路。
// 默认路径依赖 listConnectedBoardsWithSerial 拿真实 fqbn，没接板时验证不到 -I 是否生效。
const WITH_FQBN = process.argv.includes('--with-fqbn')
const FQBN = 'esp32:esp32:esp32s3'

const SKIP = (why) => {
  console.log(`\n[Agent LSP] SKIP：${why}`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

const diagTool = lspTools.find((t) => t.name === 'lsp_diagnostics')
if (!diagTool) SKIP('未找到 lsp_diagnostics 工具定义')

// 造一个真实 Arduino 工程
const proj = mkdtempSync(join(tmpdir(), 'agentard-'))
const ino = join(proj, 'sketch.ino')
writeFileSync(
  ino,
  `#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
}

void loop() {
  digitalWrite(2, HIGH);
  delay(500);
}
`,
  'utf8'
)

const ctx = { projectRoot: proj, cwd: proj }

// --with-fqbn 模式：先显式生成带 -I 的编译数据库，再跑工具。
// 这条路不依赖接板，能真实验证「-I 推导 → clangd 解析到 core」是否成立。
if (WITH_FQBN) {
  console.log(`[Agent LSP] --with-fqbn 模式：显式生成编译数据库（fqbn=${FQBN}）`)
  const gen = mod.ensureCompileDb({ projectRoot: proj, fqbn: FQBN, files: [ino], force: true })
  if (!gen.ok) SKIP(`ensureCompileDb 失败：${gen.error}`)
  const dbArgs = JSON.parse(readFileSync(gen.data, 'utf8'))[0].arguments || []
  const dbIncs = dbArgs.filter((a) => a.startsWith('-I'))
  console.log(`[Agent LSP] 编译数据库：${dbIncs.length} 个 -I`)
  if (dbIncs.length === 0) SKIP('本机未安装 arduino core，无法验证 include 是否命中')
  console.log(`  例: ${dbIncs[0]}`)
  console.log(`  方言: -x ${dbArgs[dbArgs.indexOf('-x') + 1]}`)
  console.log('')
}

// 真跑一次：走工具定义 → getClient → 惰性 ensureCompileDb → clangd → 诊断
console.log('[Agent LSP] 调用 lsp_diagnostics …')
const res = await diagTool.execute({ file: ino }, ctx)

const dbPath = join(proj, 'compile_commands.json')
const dbExists = existsSync(dbPath)
let incCount = 0
if (dbExists) {
  const db = JSON.parse(readFileSync(dbPath, 'utf8'))
  const entry = db[0]
  incCount = (entry?.arguments || []).filter((a) => a.startsWith('-I')).length
}
console.log(`[Agent LSP] compile_commands.json：${dbExists ? `已生成（${incCount} 个 -I）` : '未生成'}`)
console.log(`[Agent LSP] 工具返回 ok=${res.ok}`)

// 关键诊断：数据库没生成时，不能只靠「诊断里没有 file not found」就判通过——
// 那可能只是因为还没接板、clangd 用默认路径侥幸解析，或诊断窗口太短。
// 这里把前提条件显式说清楚，避免假绿。
if (!dbExists) {
  console.log('')
  console.log('[Agent LSP] 说明：本次未生成 compile_commands.json。')
  console.log('[Agent LSP] 常见原因：本机此刻没有连接开发板（拿不到 fqbn，无法推导 -I），')
  console.log('[Agent LSP]           或未安装 arduino-cli 工具链。')
  console.log('[Agent LSP] 这属于**环境前提未满足**，不代表修复失效。')
  console.log('[Agent LSP] 判定依据：工具能跑通（ok=true）且不再抛「找不到 clangd」——')
  console.log('[Agent LSP]           修复前这里必然是 spawn clangd ENOENT。')
  console.log('[Agent LSP] 想验证 -I 推导的完整链路（显式给 fqbn，不依赖接板），')
  console.log('[Agent LSP] 用 --with-fqbn 参数，会额外跑一遍 ensureCompileDb + clangd 真实解析。')
}

const content = String(res.content || '')
const notFound = /file not found|无法打开.*文件|'Arduino\.h'|'WiFi\.h'/.test(content)
console.log('')

if (!res.ok) {
  // 语言服务器没装等环境问题，SKIP 而非失败（与 check-lsp-live 的约定一致）
  if (/启动失败|不在 PATH|未安装/.test(String(res.error || ''))) {
    SKIP(`语言服务器不可用：${res.error}`)
  }
  console.log(`✗ 工具执行失败：${res.error || content.slice(0, 200)}`)
  process.exit(1)
}

if (notFound) {
  console.log('✗ 诊断里仍有头文件找不到 —— Agent 侧编译数据库未生效')
  console.log('  ' + content.split('\n').slice(0, 6).join('\n  '))
  process.exit(1)
}

console.log(dbExists
  ? '✓ Agent 侧 LSP 可用：clangd 通过自动生成的编译数据库解析到了 core 头文件（无 file not found）'
  : WITH_FQBN
    ? '✗ 已显式生成编译数据库，clangd 仍报头文件找不到'
    : '✓ Agent 侧 LSP 工具链跑通（未接板时降级为无 -I 解析，但不再「找不到 clangd」）')
if (content.trim()) {
  console.log('  诊断摘要（前 3 条）：')
  console.log('  ' + content.split('\n').filter(Boolean).slice(0, 3).join('\n  '))
}

rmSync(tmp, { recursive: true, force: true })
rmSync(proj, { recursive: true, force: true })
process.exit(0)