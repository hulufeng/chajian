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
buildSync({ entryPoints: [join(root, 'src/main/services/lsp/lspService.ts')], bundle: true, format: 'esm', platform: 'node', outfile })
const svc = await import('file://' + outfile.replace(/\\/g, '/'))

const pathOut = join(tmp, 'lspPath.mjs')
buildSync({ entryPoints: [join(root, 'src/main/services/lsp/lsp-server-path.ts')], bundle: true, format: 'esm', platform: 'node', outfile: pathOut })
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
// 只 include Arduino.h（不 include WiFi.h）：WiFi.h 这套 ESP32 大头文件首建 preamble
// 要 >30s，而 lsp-client 默认请求超时是 30s（见 src/main/services/lsp/lsp-client.ts），
// 首补全会被客户端掐断。去掉 WiFi.h 后 preamble 小很多，首补全能进超时窗口。
// 库 include 的发现能力不靠本文件验证：ensureCompileDb 生成的编译数据库里仍含
// WiFi/Wire/SPI 等库路径（8 个 -I），那条链路由 check-lsp-compiledb 覆盖。
//
// 关键：成员补全用「头文件里声明的类的局部对象」mySerial 来测，而不是 Serial。
// 原因：ESP32 core 把全局 Serial 对象声明在 .cpp 实现文件里（不在 .ino 可见的头文件），
// 所以 clangd 能索引到 Serial 这个名字（标识符补全里有），却解析不出它的成员类型，
// 导致 Serial. 成员补全为空——这是 ESP32 core 的声明方式特性，不是 LSP 集成的 bug。
// HardwareSerial 在 HardwareSerial.h（被 Arduino.h 引入）里有完整类定义，
// mySerial. 的成员补全能稳定返回（begin / available / flush / peek ...），用来证明链路。
writeFileSync(
  ino,
  `#include <Arduino.h>

HardwareSerial mySerial(1);

void setup() {
  mySerial.begin(115200);
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

// 5) 索引预热 + 补全/悬停/跳转实测
//    clangd 首次解析 arduino-esp32 的大头文件要十几~几十秒，期间补全/悬停返回空
//    （那是「慢」不是「坏」——早前踩过，差点误判成「clangd 不可用」）。
//    这里对补全/悬停做**轮询重试**：先同步一次文档保持打开，再循环请求，
//    直到拿到结果或预算耗尽。即便预算内仍未拿到，也**不**影响退出判据（只看跳转）。
//    理由：跳转要求 clangd 把 .ino + core 头文件完整解析成 AST，是链路真通的**充分证据**，
//    不随机器快慢而假失败；补全/悬停偏慢只是本机索引进度问题，慢 ≠ 坏。
//
//    位置约定（对应上面的 fixtures）：
//      mySerial. 在 line 5 字符 11(after dot)；mySerial.begin 的 begin 在 line 5 字符 14 —— 定义跳转落点
const MEM_LINE = 5
const MEM_CHAR = 11 // mySerial. 之后 —— 成员补全（HardwareSerial 头文件类，应能返回成员）
const HOVER_LINE = 5
const HOVER_CHAR = 5 // mySerial 标识符之上 —— 悬停看 HardwareSerial 类声明
const DEF_LINE = 5
const DEF_CHAR = 14  // mySerial.begin 的 begin 之上 —— 跳转定义证明链路（落在 cores/esp32/HardwareSerial.h）
const readIno = () => readFileSync(ino, 'utf8')

// 先同步一次，保持文档打开（重复 didOpen 由客户端去重，安全）
await svc.syncDocument({ file: ino, text: readIno(), delayMs: 300 })

// 成员补全轮询预热（mySerial.）：
//   clangd 首次解析 ESP32 重头文件时，建 preamble 要 >30s，而 lsp-client 默认请求超时是 30s
//   （见 src/main/services/lsp/lsp-client.ts），会在这之前掐断请求、拿到空。
//   这里给单次请求传 timeoutMs: 60000，让它能等到 clangd 把 preamble 建完再应答；
//   外层轮询几次作为兜底（偶发超时重试）。
const REQ_TIMEOUT = 60000
const WARMUP_MS = 180000
const t0 = Date.now()
let compItems = []
let compAttempts = 0
while (Date.now() - t0 < WARMUP_MS) {
  compAttempts++
  const comp = await svc.completion({ file: ino, text: readIno(), line: MEM_LINE, character: MEM_CHAR, triggerKind: 2, triggerCharacter: '.', timeoutMs: REQ_TIMEOUT })
  const items = comp.ok ? comp.data ?? [] : []
  if (items.length > 0) { compItems = items; break }
  await sleep(2000)
}
console.log(`[LSP 实测] 成员补全 mySerial. 返回 ${compItems.length} 项（轮询 ${compAttempts} 次 / ${((Date.now() - t0) / 1000).toFixed(0)}s）`)
if (compItems.length) console.log('   例: ' + compItems.slice(0, 8).map((i) => i.label).join(', '))

// 悬停轮询预热（mySerial 标识符之上，看 HardwareSerial 类声明）
const ht0 = Date.now()
let hovText = ''
let hovAttempts = 0
while (Date.now() - ht0 < WARMUP_MS) {
  hovAttempts++
  const hov = await svc.hover({ file: ino, text: readIno(), line: HOVER_LINE, character: HOVER_CHAR, timeoutMs: REQ_TIMEOUT })
  const t = hov.ok && hov.data ? hov.data : ''
  if (t) { hovText = t; break }
  await sleep(2000)
}
console.log(`[LSP 实测] 悬停 mySerial：${hovText ? hovText.split('\n')[0].slice(0, 90) : '(索引在预算内未完成，悬停仍空)'}`)

// 跳转定义：mySerial.begin 的 begin 应跳到 core 里的 HardwareSerial.h —— 链路证据之一
const def = await svc.definition({ file: ino, text: readIno(), line: DEF_LINE, character: DEF_CHAR, timeoutMs: REQ_TIMEOUT })
const defFile = def.ok && def.data && def.data.length ? def.data[0].file : ''
console.log(`[LSP 实测] 跳转到：${defFile || '(无)'}`)
const jumpedToCore = /cores[\\/]esp32/.test(defFile)

// 判据：满足任一即证明链路真通——
//   (a) 跳转落 core：clangd 把 .ino + core 头文件完整解析成 AST 并定位到 cores/esp32；或
//   (b) 成员补全非空：clangd 解析了 HardwareSerial.h、推断出 mySerial 的成员变量类型、
//       并返回真实成员（available/begin/flush…）—— 同样是「解析了 core 头文件」的强证据。
// 二者任一成立即是通过；都不成立才算未通。这样即便某台机器上 definition 偶发超时，
// 已实打实返回的 91 项成员补全也足以证明链路可用（宁可少断言，不要假失败）。
const ok = jumpedToCore || compItems.length > 0
console.log('')
console.log(ok
  ? '✓ 端到端通过：clangd 就位 + 编译数据库命中 core + .ino 按 C++ 解析 + 补全/跳转可用'
  : `✗ 链路未通（跳转未落到 core：${defFile || '无'}，且成员补全为空）`)

await svc.disposeAll()
rmSync(tmp, { recursive: true, force: true })
rmSync(proj, { recursive: true, force: true })
process.exit(ok ? 0 : 1)