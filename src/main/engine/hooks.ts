// 外部进程钩子（对齐 TrieCode packages/engine/dist/hooks.js）
//
// 为什么要有这层：tool-registry 已有 pre/around/post 三层管道，但挂上去的只有
// tool-observers 的耗时统计与慢工具提示——它们只能「看」，不能「拦」。
// 项目红线（禁止改 platformio.ini、terminal 必须加确认、危险命令脱敏）如果只能写进
// 系统提示，模型一上头就会绕过；外置成脚本后，拦截发生在工具真正执行之前，绕不过去。
//
// 两类事件：
//   PreToolUse  —— 执行前。可拒绝（decision=reject）、可改参（args）。
//   PostToolUse —— 执行后。纯观测，结果一律不影响流程。
//
// 配置来源（项目覆盖全局）：
//   1) 全局：%APPDATA%/CodeLab/hooks.json
//   2) 项目：<projectRoot>/.labcode/hooks.json
// 格式：
// {
//   "hooks": {
//     "PreToolUse":  [{ "matcher": "write_file,edit_file", "command": "node .labcode/guard.js", "timeoutMs": 5000 }],
//     "PostToolUse": [{ "matcher": "*", "command": "node .labcode/audit.js" }]
//   }
// }
//
// 安全边界（重要）：钩子命令由用户自己写，信任边界 = 用户本机配置，与 TrieCode 一致。
// 但钩子**永远不能把 Agent 卡死**：超时/spawn 失败/输出不可解析 → 一律放行 + console.warn。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { PipelineContext, PreMiddleware, PostMiddleware, NamedMiddleware } from './tool-registry'

export type HookEvent = 'PreToolUse' | 'PostToolUse'

interface HookDef {
  /** 匹配的 tool 名：`*` 全部 / 逗号分隔 / 支持尾缀通配 `compile*` */
  matcher?: string
  command: string
  timeoutMs?: number
}

interface HookConfig {
  hooks?: Partial<Record<HookEvent, HookDef[]>>
}

interface HookOutcome {
  decision: 'allow' | 'reject'
  reason?: string
  args?: Record<string, unknown>
}

const HOOK_FILE_NAME = 'hooks.json'
const PROJECT_HOOK_DIR = '.labcode'
const DEFAULT_TIMEOUT_MS = 5000
/** 传给钩子的工具结果截断长度：避免把整份文件内容塞进子进程 stdin */
const MAX_RESULT_CHARS = 2000
/** mtime 缓存：钩子配置在 run 期间基本不变，逐次工具调用都读盘太浪费 */
const configCache = new Map<string, { mtimeMs: number; cfg: HookConfig }>()

function readConfigFile(path: string): HookConfig {
  if (!existsSync(path)) return {}
  try {
    const mtimeMs = statSync(path).mtimeMs
    const hit = configCache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return hit.cfg
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as HookConfig
    configCache.set(path, { mtimeMs, cfg })
    return cfg
  } catch (e) {
    console.warn(`[hooks] 配置解析失败，忽略：${path} (${(e as Error).message})`)
    return {}
  }
}

function globalHookPath(): string {
  try {
    return join(app.getPath('userData'), HOOK_FILE_NAME)
  } catch {
    return ''
  }
}

/**
 * 全局 + 项目合并：**项目覆盖全局**（按事件粒度）。
 *
 * 规格（docs/AGENT-对齐TrieCode-任务规划.md §二.2）写的是「项目覆盖全局」，
 * 不是拼接。早先实现是拼接，导致全局钩子仍能拒绝/改参——项目里明明写了自己的
 * 红线规则，却拦不住全局那条，语义与文档不符。这里改成：某个事件只要项目配置了
 * （哪怕是空数组，表示「本工程明确不需要这类钩子」），就完全采用项目的。
 */
export function loadHooks(projectRoot: string | null): Record<HookEvent, HookDef[]> {
  const merged: Record<HookEvent, HookDef[]> = { PreToolUse: [], PostToolUse: [] }
  const globalPath = globalHookPath()
  const globalCfg = globalPath ? readConfigFile(globalPath).hooks || {} : {}
  const projectCfg = projectRoot
    ? readConfigFile(join(projectRoot, PROJECT_HOOK_DIR, HOOK_FILE_NAME)).hooks || {}
    : null

  for (const ev of ['PreToolUse', 'PostToolUse'] as HookEvent[]) {
    const fromProject = projectCfg ? (projectCfg[ev] as HookDef[] | undefined) : undefined
    const fromGlobal = (globalCfg[ev] as HookDef[] | undefined) || []
    // 项目显式给了该事件（含空数组）→ 覆盖全局；没给 → 继续用全局
    merged[ev] = fromProject ? [...fromProject] : [...fromGlobal]
  }
  return merged
}

/** matcher 匹配：`*` / 逗号分隔列表 / 尾缀通配 `compile*` */
export function matchTool(matcher: string | undefined, toolName: string): boolean {
  const m = (matcher || '').trim()
  if (!m || m === '*') return true
  const name = (toolName || '').trim()
  if (!name) return false
  return m
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((pat) => {
      if (pat === '*') return true
      if (pat.endsWith('*')) return name.startsWith(pat.slice(0, -1))
      return pat === name
    })
}

/** 解析钩子 stdout：只认 JSON 对象里的 decision / reason / args，其它一律放行 */
function parseOutcome(stdout: string): HookOutcome | null {
  const text = (stdout || '').trim()
  if (!text.startsWith('{')) return null
  try {
    const obj = JSON.parse(text) as Record<string, unknown>
    const decision = obj.decision === 'reject' ? 'reject' : 'allow'
    const out: HookOutcome = { decision }
    if (typeof obj.reason === 'string') out.reason = obj.reason
    if (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)) {
      out.args = obj.args as Record<string, unknown>
    }
    return out
  } catch {
    return null
  }
}

/**
 * 杀掉钩子进程及其子进程树。
 *
 * 为什么不能只 `child.kill()`：spawn 用了 `shell: true`，child 是 cmd.exe，
 * 杀它只会让壳退出，真正的 `node guard.js` 变成孤儿继续跑（还会占着 stdin/管道）。
 * Windows 上用 `taskkill /T /F` 带树杀；其它平台退回 SIGKILL，失败一律忽略——
 * 钩子杀不干净也不能把 Agent 卡住。
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child?.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* 已退出 */ }
}

function runHook(hook: HookDef, event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const done = (o: HookOutcome) => {
      if (settled) return
      settled = true
      resolve(o)
    }
    const timeoutMs = typeof hook.timeoutMs === 'number' && hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_TIMEOUT_MS
    let child
    try {
      child = spawn(hook.command, {
        shell: true,
        windowsHide: true,
        cwd: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined
      })
    } catch (e) {
      console.warn(`[hooks] ${event} 命令启动失败，放行：${(e as Error).message}`)
      done({ decision: 'allow' })
      return
    }

    const timer = setTimeout(() => {
      console.warn(`[hooks] ${event} 钩子超时 ${timeoutMs}ms，放行：${hook.command}`)
      killTree(child)
      done({ decision: 'allow' })
    }, timeoutMs)

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => {
      clearTimeout(timer)
      console.warn(`[hooks] ${event} 钩子异常，放行：${(e as Error).message}`)
      done({ decision: 'allow' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      // PostToolUse 是观测型：无论钩子说什么都不改变执行结果
      if (event === 'PostToolUse') {
        done({ decision: 'allow' })
        return
      }
      if (code === 0) {
        done(parseOutcome(stdout) || { decision: 'allow' })
      } else if (code === 2) {
        const reason = (stderr || stdout || '钩子以退出码 2 拒绝').trim().slice(0, 500)
        done({ decision: 'reject', reason })
      } else {
        console.warn(`[hooks] ${event} 钩子退出码 ${code}，放行：${hook.command}`)
        done({ decision: 'allow' })
      }
    })

    try {
      child.stdin?.end(JSON.stringify(payload))
    } catch {
      /* 钩子不读 stdin 也没关系 */
    }
  })
}

function buildPayload(event: HookEvent, p: PipelineContext, projectRoot: string | null): Record<string, unknown> {
  return {
    event,
    tool: p.toolName,
    args: p.modifiedArgs || p.args,
    cwd: p.ctx?.cwd || '',
    projectRoot: projectRoot || '',
    ts: Date.now()
  }
}

/**
 * PreToolUse 中间件：命中钩子后按 outcome 拒绝或改参。
 * 任一钩子 reject 即停止后续钩子并标记 decision='reject'（由 tool-registry 转成失败结果）。
 */
export function makePreToolUseHookMiddleware(getProjectRoot: () => string | null): PreMiddleware {
  const mw: NamedMiddleware<PreMiddleware> = async (p: PipelineContext) => {
    const root = p.ctx?.projectRoot ?? getProjectRoot()
    const hooks = loadHooks(root).PreToolUse
    if (hooks.length === 0) return
    for (const hook of hooks) {
      if (!hook.command) continue
      if (!matchTool(hook.matcher, p.toolName)) continue
      const outcome = await runHook(hook, 'PreToolUse', buildPayload('PreToolUse', p, root))
      if (outcome.decision === 'reject') {
        p.decision = 'reject'
        p.rejectReason = `[PreToolUse 钩子] ${outcome.reason || '被项目钩子拒绝'}`
        return
      }
      if (outcome.args) {
        p.modifiedArgs = { ...(p.modifiedArgs || p.args), ...outcome.args }
      }
    }
  }
  // 箭头函数的 .name 是只读的，直接赋值会抛 TypeError（tool-observers 踩过同一个坑）
  try {
    Object.defineProperty(mw, 'name', { value: 'hooks-pre', configurable: true })
  } catch { /* 命名失败只影响幂等判断，不影响功能 */ }
  return mw
}

/** PostToolUse 中间件：纯观测，把工具结果（截断后）交给外部脚本 */
export function makePostToolUseHookMiddleware(getProjectRoot: () => string | null): PostMiddleware {
  const mw: NamedMiddleware<PostMiddleware> = async (p: PipelineContext, result) => {
    const root = p.ctx?.projectRoot ?? getProjectRoot()
    const hooks = loadHooks(root).PostToolUse
    if (hooks.length === 0) return
    // 观测型钩子并发跑：结果一律不影响工具执行，串行 await 会让
    // 「N 个钩子 × 各自超时上限」全部叠加到每一次工具调用上（N=5 时最多白等 25s）。
    const jobs = hooks
      .filter((hook) => hook.command && matchTool(hook.matcher, p.toolName))
      .map((hook) => {
        const payload = buildPayload('PostToolUse', p, root)
        payload.result = {
          ok: result.ok,
          error: result.error || '',
          content: String(result.content || '').slice(0, MAX_RESULT_CHARS)
        }
        return runHook(hook, 'PostToolUse', payload)
      })
    await Promise.allSettled(jobs)
  }
  try {
    Object.defineProperty(mw, 'name', { value: 'hooks-post', configurable: true })
  } catch { /* 同上 */ }
  return mw
}

/** 测试/排障用：清空配置缓存 */
export function clearHookConfigCache(): void {
  configCache.clear()
}
