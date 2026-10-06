/**
 * 编译数据库 / Include 路径推导自检（纯函数，不依赖 Electron / 不依赖真实工具链）。
 * 覆盖：fqbn 解析、候选包含路径、库路径、宏定义、编译条目生成、重复路径去重。
 * 用法：node scripts/check-lsp-compiledb.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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
  compareVersions, pickLatestVersion, buildCoreRoot, collectSourceFiles, defaultPackagesRoots,
} = mod

// lspService 会话层（含 ensureCompileDb 的 force 语义）。它只依赖 lsp-client/lsp-compile-db，
// 不碰 electron，所以可以直接 bundle 真跑。
const svcOut = join(tmp, 'lspService.mjs')
buildSync({ entryPoints: [join(root, 'src/main/services/lspService.ts')], bundle: true, format: 'esm', platform: 'node', outfile: svcOut })
const svc = await import('file://' + svcOut.replace(/\\/g, '/'))

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
check('.ino 走 C++ 方言解析（关键）', e.arguments.includes(`-x`))
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

// --- 版本比较 / 版本挑选（换板后要挑「最新已装 core」）---
check('compareVersions 1.10 > 1.9（不按字符串比）', compareVersions('1.10.0', '1.9.0') > 0)
check('compareVersions 3.3.11 > 3.3.9', compareVersions('3.3.11', '3.3.9') > 0)
check('compareVersions 相等为 0', compareVersions('2.0.0', '2.0.0') === 0)
check('compareVersions 缺失段当 0', compareVersions('3.3', '3.3.0') === 0)
check('pickLatestVersion 取最高', pickLatestVersion(['3.3.9', '3.3.11', '3.2.0']) === '3.3.11')
check('pickLatestVersion 过滤非数字开头目录', pickLatestVersion(['devel', 'src', '1.0.0']) === '1.0.0')
check('pickLatestVersion 空表返回 null', pickLatestVersion([]) === null)

// --- core 根目录拼装 ---
const cr = buildCoreRoot('C:/data/packages', 'esp32', 'esp32', '3.3.11')
check('buildCoreRoot 拼出 packages/packager/hardware/arch/version', cr.endsWith(['packages', 'esp32', 'hardware', 'esp32', '3.3.11'].join('/')) || cr.endsWith(['packages', 'esp32', 'hardware', 'esp32', '3.3.11'].join('\\')))
check('defaultPackagesRoots 非空且都是 packages 结尾', defaultPackagesRoots().length > 0 && defaultPackagesRoots().every((p) => p.endsWith('packages')))

// --- collectSourceFiles（真实目录夹具）---
const fsProj = mkdtempSync(join(tmpdir(), 'fsproj-'))
mkdirSync(join(fsProj, 'src'))
mkdirSync(join(fsProj, 'build'))
mkdirSync(join(fsProj, 'node_modules'))
mkdirSync(join(fsProj, '.pio'))
mkdirSync(join(fsProj, '.hidden'))
writeFileSync(join(fsProj, 'main.cpp'), '')
writeFileSync(join(fsProj, 'notes.txt'), '')
writeFileSync(join(fsProj, 'sketch.ino'), '')
writeFileSync(join(fsProj, 'src', 'util.cpp'), '')
writeFileSync(join(fsProj, 'src', 'api.h'), '')
writeFileSync(join(fsProj, 'build', 'gen.cpp'), '')
writeFileSync(join(fsProj, 'node_modules', 'dep.cpp'), '')
writeFileSync(join(fsProj, '.pio', 'p.cpp'), '')
writeFileSync(join(fsProj, '.hidden', 'h.cpp'), '')
const found = collectSourceFiles(fsProj)
check('收集到工程内源文件', found.some((f) => f.endsWith('main.cpp')) && found.some((f) => f.endsWith('util.cpp')))
check('收集 .ino / .h', found.some((f) => f.endsWith('sketch.ino')) && found.some((f) => f.endsWith('api.h')))
check('跳过 build 产物', !found.some((f) => f.includes('gen.cpp')))
check('跳过 node_modules', !found.some((f) => f.includes('dep.cpp')))
check('跳过 .pio', !found.some((f) => f.includes('p.cpp')))
check('跳过点开头的隐藏目录', !found.some((f) => f.includes('h.cpp')))
check('不收非源文件', !found.some((f) => f.endsWith('notes.txt')))

// --- ensureCompileDb：core 没装也要能落地，且 force 语义正确 ---
// 用一个肯定找不到 core 的 fqbn -> discoverCoreRoot 返回 null -> 走「无 -I 也要写」的降级分支
const dbProj = mkdtempSync(join(tmpdir(), 'dbproj-'))
writeFileSync(join(dbProj, 'main.ino'), 'void setup(){}\n')
const r1 = svc.ensureCompileDb({ projectRoot: dbProj, fqbn: 'nosuchvendor:nosucharch:nosuchboard', files: [join(dbProj, 'main.ino')] })
check('ensureCompileDb 落地成功', r1.ok === true)
const dbPath = join(dbProj, 'compile_commands.json')
check('生成 compile_commands.json', existsSync(dbPath))
const dbJson = JSON.parse(readFileSync(dbPath, 'utf8'))
check('条目含目标文件', dbJson.length === 1 && dbJson[0].file.endsWith('main.ino'))
check('无 core 时仍声明 C++ 方言（关键）', dbJson[0].arguments.includes(`-x`))
check('无 core 时没有 -I（不编造路径）', !dbJson[0].arguments.some((a) => a.startsWith('-I')))

// 篡改后：不带 force 应原样保留（复用），带 force 应重建覆盖
writeFileSync(dbPath, '[{"tampered":true}]', 'utf8')
const r2 = svc.ensureCompileDb({ projectRoot: dbProj, fqbn: 'nosuchvendor:nosucharch:nosuchboard', files: [join(dbProj, 'main.ino')] })
check('已有文件时不 force 则复用不重写', readFileSync(dbPath, 'utf8') === '[{"tampered":true}]' && r2.ok === true)
const r3 = svc.ensureCompileDb({ projectRoot: dbProj, fqbn: 'nosuchvendor:nosucharch:nosuchboard', files: [join(dbProj, 'main.ino')], force: true })
const dbJson2 = JSON.parse(readFileSync(dbPath, 'utf8'))
check('force=true 重建并覆盖旧内容', r3.ok === true && Array.isArray(dbJson2) && dbJson2[0].file.endsWith('main.ino'))
check('force 后内容不再是篡改版', readFileSync(dbPath, 'utf8') !== '[{"tampered":true}]')

rmSync(tmp, { recursive: true, force: true })

console.log(`\n编译数据库自检：通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
} else {
  console.log('✓ 全部通过')
}
