/**
 * 编译数据库（compile_commands.json）与 Include 路径推导 —— 让 clangd 能看懂 Arduino / ESP32 代码。
 *
 * 为什么必须自己造：clangd 靠 compile_commands.json（或 compile_flags.txt）知道
 * 「这个文件用什么编译器、带哪些 -I 和 -D」。
 * Arduino 工程没有这个东西（arduino-cli 内部走 cmake/avr-gcc 自行拼装），
 * 于是 clangd 一打开 .ino 就满屏「'Arduino.h' file not found」，补全/跳转/悬停全废。
 *
 * 设计：
 * - 纯函数部分（候选路径拼装 / 宏定义 / 条目生成）不碰磁盘，便于 check-lsp-compiledb 直跑真单测；
 * - I/O 部分（existsSync 过滤、写盘）单独列出，依赖 injection，便于测试替身。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 提取自 fqbn（`esp32:esp32:esp32s3` -> 三段）。fqbn 由 boardRegistry 提供保证。 */
export interface FqbnParts {
  /** 打包者，如 esp32 / arduino / STMicroelectronics */
  packager: string
  /** 平台架构，如 esp32 / avr / stm32 */
  arch: string
  /** 板型 id，如 esp32s3 / uno / nucleo_f411re */
  board: string
}

export function parseFqbn(fqbn: string): FqbnParts | null {
  const parts = String(fqbn || '').split(':')
  if (parts.length < 3) return null
  const [packager, arch, board] = parts
  if (!packager || !arch || !board) return null
  return { packager, arch, board }
}

/**
 * Arduino core 的标准包含目录（相对 core 根）。
 * 依据 Arduino 平台目录约定：core 根下有 cores/<arch>、variants/<variant>、libraries/<X>/src；
 * ESP32 另有 SDK 头文件 tools/sdk/**\/include。这些是 Arduino core 布局的公开约定。
 */
export function candidateIncludePaths(spec: {
  coreRoot: string
  arch: string
  variant: string
  sdk?: boolean
}): string[] {
  const { coreRoot, arch, variant, sdk } = spec
  const root = coreRoot.replace(/[\\/]+$/, '')
  const paths: string[] = [
    join(root, 'cores', arch),
    join(root, 'variants', variant),
    join(root, 'libraries')
  ]
  // ESP32 core 的 SDK 头在 tools/sdk/<chip>/include/<component>/include，层级深且多，
  // 这里给到 tools/sdk 让调用方按芯片再下钻；clangd 支持 -I 目录递归查找（配合 -Wno-unknown）。
  if (sdk) paths.push(join(root, 'tools', 'sdk'))
  return paths
}

/** 常用库在 core 里是 <Lib>/src 布局；按需传入 libs，避免把全部库塞进 -I 拖慢 clangd 索引 */
export function libraryIncludePaths(coreRoot: string, libs: string[]): string[] {
  const root = coreRoot.replace(/[\\/]+$/, '')
  return libs.map((l) => join(root, 'libraries', l, 'src'))
}

/**
 * Arduino 编译期的宏定义。事实来源：Arduino 构建规则（ARDUINO / ARDUINO_* / F_CPU 等）。
 * clangd 缺这些宏时，条件编译分支会整个变灰，补全跟着少一大半。
 */
export function arduinoDefines(parts: FqbnParts, opts: {
  fqbn: string
  cpuFreqMHz?: number
  variant?: string
}): string[] {
  const archUp = parts.arch.toUpperCase()
  const defines = [
    `ARDUINO=10812`,
    `ARDUINO_${archUp}_DEV`,
    `ARDUINO_ARCH_${archUp}`,
    `ARDUINO_BOARD=${JSON.stringify(opts.fqbn)}`,
    `ARDUINO_VARIANT=${JSON.stringify(opts.variant ?? parts.board)}`
  ]
  if (opts.cpuFreqMHz) defines.push(`F_CPU=${opts.cpuFreqMHz}000000L`)
  // ESP32 专用：与 core 的 platform.txt 一致
  if (parts.arch === 'esp32') {
    defines.push(`ESP32=ESP32`)
    const chip = String(parts.board || '').toUpperCase()
    if (chip) defines.push(`${chip}=1`)
  }
  return defines
}

/** 编译数据库条目（compile_commands.json 的标准形状） */
export interface CompileEntry {
  file: string
  directory: string
  arguments: string[]
}

/**
 * 生成一条 clangd 可吃的编译命令。
 * `--driver-mode=g++` 让 clangd 按 C++ 处理 .ino（Arduino 本质是 C++），
 * 否则 .ino 会被当成未知方言、Arduino 语法全报错。
 */
export function makeCppEntry(opts: {
  file: string
  directory: string
  compiler?: string
  includes: string[]
  defines: string[]
  extraArgs?: string[]
  std?: string
}): CompileEntry {
  const compiler = opts.compiler || 'clang++'
  const std = opts.std || 'c++17'
  const args: string[] = [compiler]
  args.push(`--driver-mode=g++`)
  args.push(`-std=${std}`)
  for (const inc of opts.includes) args.push(`-I${inc}`)
  for (const def of opts.defines) args.push(`-D${def}`)
  args.push(`-Wno-unknown-warning-option`)
  if (opts.extraArgs) args.push(...opts.extraArgs)
  args.push(opts.file)
  return { file: opts.file, directory: opts.directory, arguments: args }
}

/** 已存在才收录（避免把不存在的路径塞进 -I，clangd 会告警且无用） */
export function existingPaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const norm = resolve(p)
    if (seen.has(norm)) continue
    seen.add(norm)
    if (existsSync(norm)) out.push(norm)
  }
  return out
}

/**
 * 写 compile_commands.json 到工程根目录（clangd 的默认查找位置）。
 * 幂等：内容一致时不重写（省 IO、也避免 mtime 变动触发 clangd 重新索引）。
 */
export function writeCompileCommands(projectRoot: string, entries: CompileEntry[]): string {
  const file = join(projectRoot, 'compile_commands.json')
  const json = JSON.stringify(entries, null, 2)
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  try {
    if (readFileSync(file, 'utf8') === json) return file
  } catch {
    // 文件不存在 / 不可读 -> 直接写
  }
  writeFileSync(file, json, 'utf8')
  return file
}
