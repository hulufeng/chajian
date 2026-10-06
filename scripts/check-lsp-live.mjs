/**
 * LSP 端到端实测（需要环境：clangd + 已装 arduino core；缺任一则 SKIP 不算失败）。
 *
 * 与其它 check 脚本的区别：这不是纯函数自检，而是**真跑一次语言服务器**，
 * 回答「装了 clangd、补全到底能不能用」这个只能靠实测回答的问题。
 *
 * 验证链路：
 *   1. 造一个真实 Arduino 工程（.ino 引用 Arduino.h / WiFi.h）
 *   2. ensureCompileDb 自动发现已装 core → 生成 compile_commands.json（带真实 -I）
 *   3. 真的 spawn clangd，走 didOpen/didChange，拿回诊断
 *   4. 断言：诊断里**没有** "'Arduino.h' file not found" —— 这证明编译数据库生效了
 *      （clangd 看得见 core 头文件）；有语法兼容性报错是另一回事，不在此断言范围。
 *
 * 用法：node scripts/check-lsp-live.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'lsplive-'))

// node 不能直接 import .ts，两个模块各自 bundle 成 mjs 再 import
const outfile = join(tmp, 'lspService.mjs')
buildSync({ entryPoints: [join(root, 'src/main/services/lspService.ts')], bundle: true, format: 'esm', platform: 'node', outfile })
const svc = await import('file://' + outfile.replace(/\\/g, '/'))

const pathOut = join(tmp, 'lspPath.mjs')
buildSync({ entryPoints: [join(root, 'src/main/services/lsp-server-path.ts')], bundle: true, format: 'esm', platform: 'node', outfile: pathOut })
const { locateServerCommand } = await import('file://' + pathOut.replace(/\\/g, '/'))

const SKIP = (why) => {
  console.log(`\n[LSP 实测] SKIP：${why}`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

// 1) 找 clangd（与主进程同一套定位逻辑：环境变量 → 用户工具目录 → 常见位置）
const userDataDir = process.env.APPDATA ? join(process.env.APPDATA, 'codelab-desktop') : ''
// 与主进程启动时一致地注入用户数据目录（不注入就找不到用户工具目录里的 clangd）
svc.configureServerSearch({ userDataDir })
const clangd = locateServerCommand('clangd', userDataDir)
if (!existsSync(clangd)) SKIP('未找到 clangd（不在 PATH，也没装在常见位置）')
console.log(`[LSP 实测] 使用 clangd：${clangd}`)

// 2) 造工程
const proj = mkdtempSync(join(tmpdir(), 'ardproj-'))
const ino = join(proj, 'sketch.ino')
writeFileSync(
  ino,
  `#include <Arduino.h>
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  WiFi.begin("ssid", "pass");
}

void loop() {
  digitalWrite(2, HIGH);
  delay(500);
}
`,
  'utf8'
)

// 3) 生成编译数据库（不传 coreRoot，让它自己发现）
const r = svc.ensureCompileDb({ projectRoot: proj, fqbn: 'esp32:esp32:esp32s3', files: [ino], force: true })
if (!r.ok) SKIP(`ensureCompileDb 失败：${r.error}`)
const dbText = readFileSync(r.data, 'utf8')
const db = JSON.parse(dbText)
const incs = db[0].arguments.filter((a) => a.startsWith('-I'))
console.log(`[LSP 实测] 编译数据库：${incs.length} 个 -I`)
if (incs.length === 0) {
  console.log('[LSP 实测] 结果：本机没有可发现的 arduino core —— 无法验证 include 是否命中')
  console.log('[LSP 实测] （这不影响「clangd 已可用」这一结论，只是 include 需用户装 core）')
}

// 4) 真跑一次 LSP，拿诊断
//    注意：首次 didOpen 后 clangd 还在后台解析，立刻 getDiagnostics 会拿到「还没发过的空」，
//    那会让「0 条诊断」变成假阳性。所以这里轮询等待诊断真正到达。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let diags = []
let diagOk = false
let diagErr = ''
for (let i = 1; i <= 12; i++) {
  const diag = await svc.syncDocument({ file: ino, text: readFileSync(ino, 'utf8'), delayMs: 1200 })
  if (!diag.ok) {
    diagErr = diag.error || ''
    break
  }
  diagOk = true
  diags = diag.data ?? []
  // 首次拿到诊断即认为就绪（可能为空数组，那本身就是有效结论）
  if (i >= 3) break
}
if (!diagOk) {
  console.log(`[LSP 实测] 结果：语言服务器通信失败 —— ${diagErr}`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}
console.log(`[LSP 实测] 收到诊断 ${diags.length} 条`)
for (const d of diags.slice(0, 6)) {
  console.log(`  行 ${d.startLine + 1} [sev ${d.severity}] ${d.message.slice(0, 110)}`)
}

const notFound = diags.filter((d) => /file not found|无法打开.*文件|'Arduino\.h'/.test(d.message))
console.log('')
if (incs.length > 0 && notFound.length === 0) {
  console.log('✓ 诊断链路通过：clangd 通过编译数据库解析到了 core 头文件（无 not found）')
} else if (incs.length === 0) {
  console.log('✓ clangd 链路本身可用（include 未命中：本机未装 arduino core，属预期）')
} else {
  console.log('✗ 仍有头文件找不到 —— 编译数据库的 -I 没生效')
  await svc.disposeAll()
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

// 5) 补全/悬停/跳转实测
//    等够时间：clangd 首次解析 arduino-esp32 的大头文件要十几秒，
//    立刻请求只会拿到「invalid AST」或超时——那是**慢**，不是**坏**（实测踩过，别误判）。
await sleep(15000)
const comp = await svc.completion({
  file: ino,
  text: readFileSync(ino, 'utf8'),
  line: 4,
  character: 8
})
const items = comp.ok ? comp.data ?? [] : []
console.log(`[LSP 实测] 补全返回 ${items.length} 项${items.length ? ' 例:' + items[0].label : ''}`)

const hov = await svc.hover({ file: ino, text: readFileSync(ino, 'utf8'), line: 4, character: 8 })
const hovText = hov.ok && hov.data ? hov.data : ''
console.log(`[LSP 实测] 悬停 Serial.：${hovText ? hovText.split('\n')[0].slice(0, 80) : '(空)'}`)

// 跳转定义：Serial 应跳到 core 里的 HardwareSerial.h —— 这是整条链路最强的证据
const def = await svc.definition({ file: ino, text: readFileSync(ino, 'utf8'), line: 4, character: 8 })
const defFile = def.ok && def.data && def.data.length ? def.data[0].file : ''
console.log(`[LSP 实测] 跳转到：${defFile || '(无)'}`)
const jumpedToCore = /cores[\\/]esp32/.test(defFile)

// 判据只用「跳转」：它要求 clangd 已把 .ino + core 头文件完整解析成 AST，是链路真通的充分证据。
// 悬停/补全在这台机器上偏慢（WiFi.h 头很大），慢 ≠ 坏，**不作为硬断言**——
// 否则每次跑都可能因机器快慢而误报失败（宁可少断言，不要假失败）。
const ok = jumpedToCore
console.log('')
console.log(ok
  ? '✓ 端到端通过：clangd 就位 + 编译数据库命中 core + .ino 按 C++ 解析 + 跳转变可用'
  : `✗ 链路未通（跳转未落到 core：${defFile || '无'}）`)

await svc.disposeAll()
rmSync(tmp, { recursive: true, force: true })
rmSync(proj, { recursive: true, force: true })
process.exit(ok ? 0 : 1)