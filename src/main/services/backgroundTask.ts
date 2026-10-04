// 终端后台任务管理：让 Agent 能启动长命令（编译/服务/监视）而不阻塞单轮工具调用。
// 基于 commandService.runCommand 返回的 ChildProcess 进行缓存，按 taskId 索引。
// 配合 terminal 工具的 background:true 与 task_output / task_stop 工具使用。
import type { ChildProcess } from 'node:child_process'
import { runCommand, type ShellType } from './commandService'

export interface BgTaskInfo {
  id: string
  command: string
  startedAt: number
  done: boolean
  exitCode: number | null
}

interface BgTask extends BgTaskInfo {
  proc: ChildProcess | null
  output: string
}

const tasks = new Map<string, BgTask>()
let seq = 0

/**
 * 启动一个后台命令，立即返回 taskId。
 * 输出持续缓冲，可用 getTaskOutput 读取；用 stopTask 终止。
 */
export function startBackgroundTask(cmd: string, cwd: string, shell?: ShellType): string {
  const id = `task-${++seq}`
  const task: BgTask = {
    id,
    command: cmd,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    proc: null,
    output: ''
  }
  tasks.set(id, task)
  let proc: ChildProcess
  try {
    proc = runCommand(
      cmd,
      cwd,
      (chunk: string) => {
        task.output += chunk
      },
      (code: number) => {
        task.exitCode = code
        task.done = true
        task.proc = null
      },
      shell
    )
  } catch (e) {
    task.exitCode = -1
    task.done = true
    task.output += `\n[启动失败] ${(e as Error).message}`
    return id
  }
  task.proc = proc
  return id
}

export interface TaskOutput {
  ok: boolean
  done: boolean
  exitCode: number | null
  content: string
  error?: string
}

/** 读取后台任务截至目前的输出。tail 限制返回末尾字符数。 */
export function getTaskOutput(id: string, tail?: number): TaskOutput {
  const task = tasks.get(id)
  if (!task) {
    return { ok: false, done: false, exitCode: null, content: '', error: `未找到后台任务 ${id}（可能已完成且被清理，或用 task_list 查看）` }
  }
  let content = task.output
  if (tail && content.length > tail) {
    content = '\n...(仅显示末尾 ' + tail + ' 字符)\n' + content.slice(-tail)
  }
  return { ok: true, done: task.done, exitCode: task.exitCode, content }
}

/** 终止后台任务（SIGTERM）。 */
export function stopTask(id: string): { ok: boolean; error?: string } {
  const task = tasks.get(id)
  if (!task) return { ok: false, error: `未找到后台任务 ${id}` }
  if (task.done) return { ok: true }
  try {
    task.proc?.kill('SIGTERM')
  } catch {
    /* 忽略 */
  }
  task.done = true
  return { ok: true }
}

/** 列出当前后台任务摘要。 */
export function listTasks(): BgTaskInfo[] {
  return Array.from(tasks.values()).map((t) => ({
    id: t.id,
    command: t.command,
    startedAt: t.startedAt,
    done: t.done,
    exitCode: t.exitCode
  }))
}
