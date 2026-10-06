/**
 * 编译数据库 / Include 路径推导自检（纯函数，不依赖 Electron / 不依赖真实工具链）。
 * 覆盖：fqbn 解析、候选包含路径、库路径、宏定义、编译条目生成、重复路径去重。
 * 用法：node scripts/check-lsp-compiledb.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const entry = join(root, 'src/main/services/lsp-compile-db.ts')

const tmp = mkdtempSync(join(tmpdir(), 'lspdb-'))
const outfile = join(tmp, 'db.mjs')
buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile })
const mod = await import('file://' + outfile.replace(/\\/g, '/'))
const {
  parseFqbn, candidateIncludePaths, libraryIncludePaths, arduinoDefines,
  makeCppEntry, existingPaths, writeCompileCommands,
} = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// --- parseFqbn ---
check('解析三段 fqbn', (() => {
  const p = parseFqbn('esp32:esp32:esp32s3')
  return p && p.packager === 'esp32' && p.arch === 'esp32' && p.board === 'esp32s3'
})())
check('STM32 fqbn 三段以上也取前三', (() => {
  const p = parseFqbn('STMicroelectronics:stm32:Nucleo_144:opt=xxx')
  return p && p.packager === 'STMicroelectronics' && p.arch === 'stm32' && p.board === 'Nucleo_144'
})())
check('缺段返回 null（不全）', parseFqbn('esp32:esp32') === null)
check('空串返回 null', parseFqbn('') === null)

// --- candidateIncludePaths ---
const core = 'C:/pkg/esp32'
const inc = candidateIncludePaths({ coreRoot: core, arch: 'esp32', variant: 'esp32s3' })
check('含 cores/<arch>', inc.some((p) => p.endsWith(join('cores', 'esp32'))))
check('含 variants/<variant>', inc.some((p) => p.endsWith(join('variants', 'esp32s3'))))
check('含 libraries', inc.some((p) => p.endsWith('libraries')))
check('默认不含 tools/sdk', !inc.some((p) => p.includes('sdk')))
check('sdk=true 时含 tools/sdk', candidateIncludePaths({ coreRoot: core, arch: 'esp32', variant: 'v', sdk: true }).some((p) => p.endsWith(join('tools', 'sdk'))))
check('coreRoot 尾斜杠归一', candidateIncludePaths({ coreRoot: 'C:/pkg/esp32/', arch: 'esp32', variant: 'v' })[0].startsWith('C:'))

// --- libraryIncludePaths ---
const libs = libraryIncludePaths(core, ['WiFi', 'Wire'])
check('库路径展开到 <Lib>/src', libs.length === 2 && libs[0].endsWith(join('libraries', 'WiFi', 'src')) && libs[1].endsWith(join('libraries', 'Wire', 'src')))

// --- arduinoDefines ---
const d = arduinoDefines({ packager: 'esp32', arch: 'esp32', board: 'esp32s3' }, { fqbn: 'esp32:esp32:esp32s3', cpuFreqMHz: 240, variant: 'esp32s3' })
check('含 ARDUINO', d.includes('ARDUINO=10812'))
check('含 ARDUINO_ARCH_ESP32', d.includes('ARDUINO_ARCH_ESP32'))
check('含 ARDUINO_ESP32_DEV', d.includes('ARDUINO_ESP32_DEV'))
check('含 F_CPU（MHz 转 Hz）', d.includes('F_CPU=240000000L'))
check('esp32 架构补 ESP32 宏', d.includes('ESP32=ESP32'))
check('esp32 补芯片宏 ESP32S3', d.includes('ESP32S3=1'))
check('ARDUINO_BOARD 带引号原样', d.includes('ARDUINO_BOARD="esp32:esp32:esp32s3"'))
const davr = arduinoDefines({ packager: 'arduino', arch: 'avr', board: 'uno' }, { fqbn: 'arduino:avr:uno', cpuFreqMHz: 16 })
check('avr 不含 ESP32 宏（不串味）', !davr.includes('ESP32=ESP32'))
check('avr 含 ARDUINO_ARCH_AVR', davr.includes('ARDUINO_ARCH_AVR'))

// --- makeCppEntry ---
const e = makeCppEntry({
  file: 'D:/p/sketch/sketch.ino',
  directory: 'D:/p/sketch',
  includes: ['/core/cores/esp32'],
  defines: ['ARDUINO=10812'],
  extraArgs: ['-DESP32=ESP32']
})
check('默认编译器 clang++', e.arguments[0] === 'clang++')
check('.ino 走 C++ 方言解析（关键）', e.arguments.includes('--driver-mode=g++'))
check('含 -std=c++17', e.arguments.includes('-std=c++17'))
check('include 拼 -I', e.arguments.includes('-I/core/cores/esp32'))
check('define 拼 -D', e.arguments.includes('-DARDUINO=10812'))
check('extraArgs 透传', e.arguments.includes('-DESP32=ESP32'))
check('目标文件在最后（clangd 要求）', e.arguments[e.arguments.length - 1] === 'D:/p/sketch/sketch.ino')
check('directory 保留', e.directory === 'D:/p/sketch')
check('自定义 std 生效', makeCppEntry({ file: 'f', directory: 'd', includes: [], defines: [], std: 'gnu++17' }).arguments.includes('-std=gnu++17'))

// --- existingPaths：去重 + 只留存在的 ---
const real = mkdtempSync(join(tmpdir(), 'real-'))
const abs = join(real, 'a.txt')
writeFileSync(abs, 'x')
check('存在路径收录', existingPaths([real]).length === 1)
check('不存在路径丢弃', existingPaths([join(real, 'nope-nope')]).length === 0)
check('重复路径去重', existingPaths([real, real, real]).length === 1)

// --- writeCompileCommands：幂等 ---
const proj = mkdtempSync(join(tmpdir(), 'proj-'))
mkdirSync(join(proj, 'sub'))
const entries = [makeCppEntry({ file: 'x.ino', directory: proj, includes: [real], defines: [] })]
const out1 = writeCompileCommands(proj, entries)
check('写到 compile_commands.json', out1.endsWith('compile_commands.json'))
const parsed = JSON.parse(readFileSync(out1, 'utf8'))
check('落盘是合法 JSON 数组', Array.isArray(parsed) && parsed.length === 1)
check('条目保留 arguments', Array.isArray(parsed[0].arguments))
const before = readFileSync(out1, 'utf8')
writeCompileCommands(proj, entries)
check('重复写内容一致（幂等）', readFileSync(out1, 'utf8') === before)

rmSync(tmp, { recursive: true, force: true })

console.log(`\n编译数据库自检：通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
} else {
  console.log('✓ 全部通过')
}
