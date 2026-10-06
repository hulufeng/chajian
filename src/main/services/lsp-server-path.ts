/**
 * 语言服务器可执行定位（自研，零依赖、不依赖 electron）。
 *
 * 为什么需要：LspClient 直接 spawn('clangd') 只认 PATH。用户按官方文档装完 LLVM，
 * 往往没勾「Add to PATH」（msi 默认就不勾），于是「明明装了却提示未安装」——
 * 这是纯粹的路径问题，不该让用户去改系统环境变量。
 *
 * 优先级（先命中先用）：
 * 1. 环境变量覆盖 `<CMD>_PATH`（如 CLANGD_PATH）：给愿意显式指定的人；
 * 2. 本机常见安装位置（含与 arduino-cli 同惯例的用户级「本应用工具」目录）；
 * 3. 裸命令原样交回，由 PATH 解析；仍失败则由上层降级——这里绝不硬失败。
 *
 * 只做「文件是否存在」判断，不 spawn 探测：受限环境（EBUSY/EPERM）下 spawn 会误判成未安装，
 * 这个坑 toolchain.locateToolchain 已踩过并留了注释。
 *
 * 全部做成纯函数（exists 与 userDataDir 由调用方注入）→ 无 electron 依赖、可直接单测。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ResolveOptions {
  /** 文件是否存在判定（注入以便测试） */
  exists: (p: string) => boolean
  /** 应用数据目录（与 arduino-cli 的 userToolDir 同惯例），可为空 */
  userDataDir: string
  /** 环境变量（注入以便测试），默认 process.env */
  env?: Record<string, string | undefined>
  /** 用户 home，默认 os.homedir() */
  home?: string
  /** Windows 的 LOCALAPPDATA */
  localAppData?: string
  /** 是否 Windows 平台，默认当前平台 */
  win?: boolean
}

/** 可执行文件名补后缀（Windows 需要 .exe） */
export function exeName(command: string, win: boolean): string {
  return win && !command.toLowerCase().endsWith('.exe') ? `${command}.exe` : command
}

/** 常见搜索目录（纯函数：只拼路径，不碰文件系统） */
export function serverSearchDirs(opts: { userDataDir: string; home: string; localAppData: string; win: boolean }): string[] {
  const { userDataDir, home, localAppData, win } = opts
  const dirs: string[] = []
  // 与 arduino-cli 同惯例：用户级「本应用工具」目录（便携安装首选）
  if (userDataDir) dirs.push(join(userDataDir, 'tools', 'llvm', 'bin'))
  if (win) {
    dirs.push('C:\\Program Files\\LLVM\\bin')
    dirs.push('C:\\Program Files (x86)\\LLVM\\bin')
    if (localAppData) dirs.push(join(localAppData, 'Programs', 'LLVM', 'bin'))
  }
  // scoop / choco / 手动安装
  dirs.push(join(home, 'scoop', 'apps', 'llvm', 'current', 'bin'))
  dirs.push(join(home, '.local', 'bin'))
  dirs.push(join(home, 'bin'))
  return dirs
}

/** 从候选里挑第一个存在的（纯函数） */
export function firstExisting(candidates: string[], exists: (p: string) => boolean): string | null {
  for (const c of candidates) {
    if (c && exists(c)) return c
  }
  return null
}

/**
 * 定位语言服务器可执行。返回绝对路径，或返回原命令交给 PATH 解析。
 * 命令里已含路径分隔符 → 视为用户已指定，原样返回。
 */
export function resolveServerCommand(command: string, opts: ResolveOptions): string {
  if (/[\\/]/.test(command)) return command

  const env = opts.env ?? process.env
  const envKey = `${command.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`
  const fromEnv = env[envKey]
  if (fromEnv && opts.exists(fromEnv)) return fromEnv

  const win = opts.win ?? process.platform === 'win32'
  const dirs = serverSearchDirs({
    userDataDir: opts.userDataDir,
    home: opts.home ?? homedir(),
    localAppData: opts.localAppData ?? env.LOCALAPPDATA ?? '',
    win
  })
  const exe = exeName(command, win)
  return firstExisting(
    dirs.map((d) => join(d, exe)),
    opts.exists
  ) ?? command
}

/** 便捷包装：直接用 fs.existsSync + 当前进程环境 */
export function locateServerCommand(command: string, userDataDir = ''): string {
  return resolveServerCommand(command, { exists: existsSync, userDataDir })
}