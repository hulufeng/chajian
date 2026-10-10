import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import * as espIdf from '../../services/espIdf'
import manifest from './manifest.json'
import type { PluginContext, StreamTask } from '../pluginManager'

export { manifest }

/**
 * ESP-IDF 工具链插件（LabCode 实现）
 * 与原 TrieCode espressif-idf-toolchain v0.1.11 界面一致，但从设计上修复三个 bug：
 *  - 检测逻辑全部自实现（findEspIdf），所有工具统一从一次检测结果取值，杜绝路径源不一致；
 *  - 检测阶段对所有路径 realpath 规范化，消除 junction/真实路径串误报；
 *  - 兼容官方 idf-env.json 字典格式（idfInstalled 为 dict 或 array 均支持）。
 */
export function load(ctx: PluginContext): void {
  const stream = (
    fn: (push: (c: string) => void, done: (c: number) => void) => import('node:child_process').ChildProcess | null
  ): StreamTask => ({
    start: (push, done) => {
      const cp = fn(push, done)
      return () => {
        try {
          cp?.kill()
        } catch {
          /* 忽略 */
        }
      }
    }
  })

  // ========== backend：流式执行 ==========
  ctx.registerBackend('espIdf.compile', (args) => stream((push, done) => espIdf.compileProject(args as never, push, done)))
  ctx.registerBackend('espIdf.flash', (args) => stream((push, done) => espIdf.flashProject(args as never, push, done)))
  ctx.registerBackend('espIdf.setTarget', (args) => stream((push, done) => espIdf.setTargetProject(args as never, push, done)))
  ctx.registerBackend('espIdf.clean', (args) => stream((push, done) => espIdf.cleanProject(args as never, push, done)))
  ctx.registerBackend('espIdf.eraseFlash', (args) => stream((push, done) => espIdf.eraseFlash(args as never, push, done)))
  ctx.registerBackend('espIdf.menuconfig', (args) => stream((push, done) => espIdf.startConfServer(args as never, push, done)))
  ctx.registerBackend('espIdf.createComponent', (args) => stream((push, done) => createComponent(args as never, push, done)))

  // ========== backend：查询/修改（返回 JSON） ==========
  ctx.registerBackend('espIdf.listTargets', (args) => espIdf.listTargetsSync((args as { projectPath?: string })?.projectPath))
  ctx.registerBackend('espIdf.configGet', (args) => {
    const a = args as { projectPath: string; symbol: string }
    return espIdf.configGet(a.projectPath, a.symbol)
  })
  ctx.registerBackend('espIdf.configSet', (args) => {
    const a = args as { projectPath: string; symbol: string; value: string }
    return espIdf.configSet(a.projectPath, a.symbol, a.value)
  })
  ctx.registerBackend('espIdf.partitionGet', (args) => partitionGet(args as { projectPath: string; file?: string }))
  ctx.registerBackend('espIdf.partitionSet', (args) => partitionSet(args as { projectPath: string; file?: string; csv: string }))

  // ========== internal ==========
  ctx.registerInternal('espIdf.status', () => espIdf.detectEspIdf())
  ctx.registerInternal('espIdf.install', async () => {
    const r = await espIdf.prepareInstaller()
    if (r.success && r.exePath) {
      const launched = espIdf.launchInstaller(r.exePath)
      return { ok: launched.ok, exePath: r.exePath, error: launched.error }
    }
    return { ok: false, error: r.error }
  })
}

// ---------- 分区表读写（main/partitions.csv） ----------
function partitionGet(args: { projectPath: string; file?: string }): { ok: boolean; csv?: string; error?: string; candidates?: string[] } {
  const p = args.file || join(args.projectPath, 'main', 'partitions.csv')
  if (!existsSync(p)) {
    return { ok: false, error: '未找到分区表', candidates: [join(args.projectPath, 'main', 'partitions.csv')] }
  }
  return { ok: true, csv: readFileSync(p, 'utf-8') }
}

function partitionSet(args: { projectPath: string; file?: string; csv: string }): { ok: boolean; path?: string; error?: string } {
  const p = args.file || join(args.projectPath, 'main', 'partitions.csv')
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, args.csv)
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------- 创建组件（idf.py create-component） ----------
function createComponent(
  args: { projectPath: string; name: string },
  onData: (c: string) => void,
  onExit: (c: number) => void
): import('node:child_process').ChildProcess | null {
  const st = espIdf.detectEspIdf()
  if (!st.available || !st.pythonExe || !st.path) {
    onData('[ESP-IDF] 未检测到 ESP-IDF，无法创建组件。\n')
    onExit(1)
    return null
  }
  const target = join(args.projectPath, 'main', 'components', args.name)
  const cp = spawn(
    st.pythonExe,
    [join(st.path, 'tools', 'idf.py'), 'create-component', '--path', target, args.name],
    { cwd: args.projectPath, env: espIdf.buildEnv(st), windowsHide: true }
  )
  cp.stdout?.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr?.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[ESP-IDF 错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}
