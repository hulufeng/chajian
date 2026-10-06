/**
 * 编译诊断自检（build-diagnostics 是纯函数，不依赖 Electron，可以直接在 node 里跑真单测）。
 *
 * 盯的是三条项目硬规则 + 真实工具链输出的形状：
 *   ① 只有 `error` / `fatal error` 阻断编译，`warning` 绝不进 errors；
 *   ② `note` / `#pragma message` / `In file included from` 永远是提示，不进 errors，
 *      但要单独计数（用户最容易把这类行误判成"编译失败"）；
 *   ③ KNOWN_NOTES 里登记的已知无害提示必须能被认出来（UI 才能标「可忽略」）——
 *      这条曾经失效过（见 ⑥-2），用真实 ESP32 蓝牙栈那行盯死。
 *
 * 另外盯 parseBuildStage / parseFlashProgress：这两个决定"编译过程条"显示什么，
 * 之前出过「生成二进制那一格永远跳不过去」的死分支，靠累积日志的顺序敏感测试兜着。
 *
 * 用法：node scripts/check-build-diagnostics.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'bdg-'))
const outfile = join(out, 'buildDiagnostics.mjs')
buildSync({
  entryPoints: ['src/main/services/build-diagnostics.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile
})
const m = await import('file://' + outfile.replace(/\\/g, '/'))
rmSync(out, { recursive: true, force: true })

const { parseBuildOutput, parseBuildStage, parseFlashProgress, parseUsageSummary, formatBytes, classifyOutputLine } = m

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── ① 缺库：真实 gcc 格式（Windows 绝对路径 + fatal error） ────────────────
{
  // 真实 gcc 输出形状：错误行 + In file included from + 代码框（数字行 + 光标行）
  const text = [
    'C:\\Users\\dev\\AppData\\Local\\Temp\\arduino\\sketch\\Blink\\Blink.ino:5:10: fatal error: ArduinoJson.h: No such file or directory',
    ' In file included from C:\\Users\\dev\\AppData\\Local\\Temp\\arduino\\sketch\\Blink\\Blink.ino:5:',
    '     5 | #include <ArduinoJson.h>',
    '       |          ^~~~~~~~~~~~~~~',
    '     from <command-line>'
  ].join('\n')
  const r = parseBuildOutput(text)
  check('① 缺库算 error', r.errorCount === 1, `errorCount=${r.errorCount}`)
  check('  ↳ 分类是 missing_include', r.errors[0]?.category === 'missing_include', r.errors[0]?.category)
  check('  ↳ 抽出 file/line/col', r.errors[0]?.file.endsWith('Blink.ino') && r.errors[0]?.line === 5 && r.errors[0]?.column === 10,
    JSON.stringify({ f: r.errors[0]?.file, l: r.errors[0]?.line, c: r.errors[0]?.column }))
  check('  ↳ 给出可执行安装建议', r.suggestions.some((s) => /arduino-cli lib install "ArduinoJson"/.test(s)), JSON.stringify(r.suggestions))
  // ② 规则：In file included from / 代码框 是提示，不能算错误也不能算警告
  check('② "In file included from" 与光标行不进 errors/warnings', r.errorCount === 1 && r.warningCount === 0, `err=${r.errorCount} warn=${r.warningCount}`)
  check('  ↳ 提示被单独计数（In file included from + 光标行）', r.noteCount >= 2, `noteCount=${r.noteCount}`)
  check('  ↳ 光标行只算提示，不是第二条错误', r.errorCount === 1, `errorCount=${r.errorCount}`)
}

// 平台内置头文件（WiFi.h）不该被当成"缺库"去让人装东西
{
  const r = parseBuildOutput('fatal error: WiFiClient.h: No such file or directory')
  check('①-2 内置头文件命中 FQBN 提示而不是装库',
    r.errors[0]?.hint.includes('FQBN') && r.suggestions.length === 0,
    JSON.stringify({ hint: r.errors[0]?.hint?.slice(0, 40), sug: r.suggestions }))
}

// ── ② 警告不阻断，且绝不进 errors ────────────────────────────────────────
{
  const r = parseBuildOutput('Blink.ino:12: warning: unused variable \'x\' [-Wunused-variable]')
  check('② 警告进 warnings', r.warnings.length === 1 && r.warnings[0].severity === 'warning', `${r.warnings.length}`)
  check('  ↳ 警告不进 errors（ok 仍为 true）', r.errorCount === 0 && r.ok === true, `err=${r.errorCount} ok=${r.ok}`)
  check('  ↳ 摘要说"无错误"', /无错误/.test(r.summary), r.summary)
}

// ── ③ 链接错误 + 冗余收尾行要被去掉 ──────────────────────────────────────
{
  const text = [
    '/tmp/arduino/sketch/Blink/Blink.ino.o: undefined reference to `fooBar(int)\'',
    'collect2.exe: error: ld returned 1 exit status'
  ].join('\n')
  const r = parseBuildOutput(text)
  check('③ 链接错误被识别', r.errorCount === 1, `errorCount=${r.errorCount}`)
  check('  ↳ 分类是 undefined_reference', r.errors[0]?.category === 'undefined_reference', r.errors[0]?.category)
  check('  ↳ 冗余的 ld returned 收尾行被滤掉', !r.errors.some((d) => /collect2|ld returned/.test(d.raw)), JSON.stringify(r.errors.map((d) => d.raw)))
  check('  ↳ ok=false（阻断烧录）', r.ok === false)
}

// ── ④ strong signature：没有 "error" 字样的重复定义也要算错误 ────────────
{
  const r = parseBuildOutput('multiple definition of `g_ledPin`')
  check('④ 无 error 关键字的重复定义仍算 error', r.errorCount === 1 && r.errors[0].category === 'multiple_definition',
    `err=${r.errorCount} cat=${r.errors[0]?.category}`)
}

// ── ⑤ 烧录类错误分流 ────────────────────────────────────────────────────
{
  // esptool v4 的规范失败行（提交前测例写成 "failed to connect; aborting"，那不是 esptool 会打的东西）
  const a = parseBuildOutput('esptool.FatalError: Failed to connect to ESP32: Timed out waiting for packet header')
  check('⑤ 握手失败 → flash_error', a.errorCount === 1 && a.errors[0].category === 'flash_error', `${a.errorCount} / ${a.errors[0]?.category}`)
  // esptool 也有只打到 "Failed to connect" 就收尾的情况
  const a2 = parseBuildOutput('Failed to connect')
  check('  ↳ 只打 "Failed to connect" 也算 flash_error', a2.errorCount === 1 && a2.errors[0].category === 'flash_error', `${a2.errorCount} / ${a2.errors[0]?.category}`)
  const b = parseBuildOutput('A fatal error occurred: Wrong boot mode detected')
  check('⑤ 错误启动模式 → flash_error', b.errors[0]?.category === 'flash_error', b.errors[0]?.category)
  const c = parseBuildOutput('Failed to open COM7')
  check('⑤ 端口打不开 → port_error', c.errors[0]?.category === 'port_error', c.errors[0]?.category)
  const d = parseBuildOutput('serial.serial5 port error: Permission denied')
  check('⑤ 权限被拒 → permission', d.errors[0]?.category === 'permission', d.errors[0]?.category)
  // arduino-cli 建壳行 "Error during build" 是噪声，真实信息在下一行
  const e = parseBuildOutput('Error during build\nError: Unknown FQBN for board esp32:esp32:esp32s3')
  check('⑤ FQBN 非法 → board_platform', e.errorCount === 1 && e.errors[0].category === 'board_platform', `${e.errorCount} / ${e.errors[0]?.category}`)
  check('  ↳ 建壳噪声行不产生第二条错误', e.errors.length === 1, `errors=${e.errors.length}`)
  // 两条真实形态：带冒号（最常见）与 sh 前缀不带 command
  const f = parseBuildOutput('xtensa-esp32-elf-gcc: command not found')
  check('⑤ 工具链缺失（冒号后 command not found）→ toolchain_missing',
    f.errorCount === 1 && f.errors[0].category === 'toolchain_missing', `${f.errorCount} / ${f.errors[0]?.category}`)
  const f2 = parseBuildOutput('sh: 1: xtensa-esp32-elf-gcc: not found')
  check('  ↳ sh 前缀那条也认得', f2.errorCount === 1 && f2.errors[0].category === 'toolchain_missing', `${f2.errorCount} / ${f2.errors[0]?.category}`)
}

// ── ⑥ 提示级：#pragma message 与「已知无害」必须被认出来 ─────────────────
{
  const r = parseBuildOutput('#pragma message("Skipping some code for ESP32-C3")')
  check('⑥ #pragma message 是提示不是错误', r.errorCount === 0 && r.noteCount === 1, `err=${r.errorCount} note=${r.noteCount}`)
  check('  ↳ 命中已知提示库', r.knownNotes.length === 1 && r.knownNotes[0].known === true, JSON.stringify(r.knownNotes))
}
{
  // 真实 ESP32 经典蓝牙栈那行：没有 file:line: 前缀、也不是 #pragma，
  // 以前 classifyOutputLine 会把它判成 plain，KNOWN_NOTES 永远匹配不到 →
  // 「已知无害提示，可忽略」这个特性等于没做。
  const r = parseBuildOutput('BT: forcing BR/EDR max sync conn eff to 1')
  check('⑥-2 ESP32 蓝牙栈已知提示必须进 knownNotes', r.knownNotes.some((n) => /BR\/EDR max sync conn eff/.test(n.text)),
    `knownNotes=${JSON.stringify(r.knownNotes.map((n) => n.text))} noteCount=${r.noteCount}`)
}

// ── ⑦ 逐行着色分类 ──────────────────────────────────────────────────────
{
  check('⑦ error 行 → error', classifyOutputLine('Blink.ino:1:1: error: expected \';\'') === 'error')
  check('  ↳ fatal error 行 → error', classifyOutputLine('x.h:2: error: fatal error: foo.h: No such') === 'error')
  check('  ↳ warning 行 → warning', classifyOutputLine("Blink.ino:12: warning: unused variable 'x'") === 'warning')
  check('  ↳ note 行 → note', classifyOutputLine('Blink.ino:3:3: note: in expansion of macro') === 'note')
  check('  ↳ In file included from → context', classifyOutputLine('In file included from x.h:1') === 'context')
  check('  ↳ 成功行 → success', classifyOutputLine('✓ 编译完成') === 'success')
  check('  ↳ 普通行 → plain', classifyOutputLine('Sketch uses 300000 bytes') === 'plain')
  check('  ↳ 空行 → plain', classifyOutputLine('   ') === 'plain')
}

// ── ⑧ 阶段推进（吃累积日志，取"最晚"那个阶段） ───────────────────────────
{
  check('⑧ 只有 Compiling sketch → sketch', parseBuildStage('Compiling sketch...') === 'sketch')
  check('  ↳ 只有 Link → link', parseBuildStage('Linking everything together...') === 'link')
  check('  ↳ 编译完成行 → done', parseBuildStage('Sketch uses 300000 bytes of program storage') === 'done')
  // 累积日志：后面出现 Linking，必须判成 link（曾经 image 分支是死代码，要让 image 判得出来）
  check('  ↳ 累积日志里 Compiling 在先 Linking 在后 → link', parseBuildStage('Compiling libraries...\nCompiling sketch...\nLinking everything together') === 'link')
  check('  ↳ 生成二进制行能判到 image', parseBuildStage('Generating binary image ...') === 'image')
  check('  ↳ esptool 在写 → flashing', parseBuildStage('Writing at 0x0000e000... (62 %)') === 'flashing')
  check('  ↳ Hard resetting → flashed', parseBuildStage('Hard resetting via RTS pin') === 'flashed')
  check('  ↳ 空白 → prepare', parseBuildStage('') === 'prepare')
}

// ── ⑨ 烧录进度：百分比真的来自工具，label 不重复显示百分比 ───────────────
{
  const p = parseFlashProgress('Writing at 0x0000e000... (62 %)', 'COM7')
  check('⑨ 写入进度解析出 62', p?.stage === 'write' && p.percent === 62, JSON.stringify(p))
  check('  ↳ label 不把百分比再拼一遍', !!p && !/%/.test(p.label), p?.label)
  check('  ↳ 端口跟在后面', !!p && p.label.includes('COM7'), p?.label)
  const e = parseFlashProgress('Chip erase...')
  check('  ↳ 擦除阶段', e?.stage === 'erase' && e.percent === null, JSON.stringify(e))
  const v = parseFlashProgress('Hash of data verified...')
  check('  ↳ 校验阶段 → verify', v?.stage === 'verify', JSON.stringify(v))
  check('  ↳ 认不出的行返回 null（不猜测推进）', parseFlashProgress('some random line') === null)
  check('  ↳ 空串返回 null', parseFlashProgress('') === null)
}

// ── ⑩ 资源用量摘要 + 字节格式化 ─────────────────────────────────────────
{
  const text = 'Sketch uses 234567 bytes (18%) of program storage space.\nGlobal variables use 31234 bytes (12%) of dynamic memory, leaving 130446 bytes for local variables.'
  const u = parseUsageSummary(text)
  check('⑩ 解析 Flash 用量', u?.flashBytes === 234567 && u?.flashPercent === 18, JSON.stringify(u && { f: u.flashBytes, p: u.flashPercent }))
  check('  ↳ 解析 RAM 用量', u?.ramBytes === 31234 && u?.ramPercent === 12, JSON.stringify(u && { r: u.ramBytes }))
  check('  ↳ 认不出的文本返回 null', parseUsageSummary('随便一行') === null)
  check('  ↳ formatBytes 分级', formatBytes(0) === '0 B' && formatBytes(512) === '512 B' && formatBytes(2048) === '2.0 KB' && formatBytes(3 * 1024 * 1024) === '3.00 MB',
    [formatBytes(0), formatBytes(512), formatBytes(2048), formatBytes(3 * 1024 * 1024)].join(' / '))
}

// ── ⑪ 空输入不能炸 ──────────────────────────────────────────────────────
{
  const r = parseBuildOutput('')
  check('⑪ 空输出 ok=true 且无错误', r.ok && r.errorCount === 0 && r.noteCount === 0, JSON.stringify({ ok: r.ok, n: r.noteCount }))
  const p = parseFlashProgress('', 'COM1')
  check('  ↳ 空输出进度为 null', p === null)
}

console.log(`[diag] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[diag] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[diag] ✓ 全部通过')
