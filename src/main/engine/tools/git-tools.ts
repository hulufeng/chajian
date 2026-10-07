// git 工具面：把已有的 gitService 能力暴露给 Agent。
//
// 为什么此前没有：gitService 早就实现了 20+ 个函数（status/diff/commit/log/branch/pull/push），
// 但只接给了 IDE 的 Git 面板，从没包装成 Agent 工具 —— 导致 orchestrator 里
// review 角色白名单写着 git_status/git_diff/git_log，调用时却被「白名单内无此工具」拒绝。
//
// 这里只做「接线」：薄封装 + 把 GitStatus.unavailable 如实翻译给模型
// （区分「没装 git」与「不是仓库」，别让模型误判成该 git init）。
import {
  isRepo, getStatus, getDiff, getLog, locateGit,
  stage, stageAll, unstage, commit, createBranch, checkoutBranch, listBranches
} from '../../services/gitService'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

function requireRoot(ctx: ToolContext): string | null {
  return ctx.projectRoot || ctx.cwd || null
}

/** git 没装 → 如实回报，而不是伪装成空仓库 */
function unavailableReason(): string | null {
  if (!locateGit()) {
    return '当前环境找不到 git 可执行文件（本机未安装或不在 PATH）。请改用文件读写工具完成修改，不要假装已提交版本。'
  }
  return null
}

function fmtFiles(files: Array<{ path: string; status: string; staged?: boolean }>): string {
  if (!files.length) return '（无）'
  return files.map((f) => `${f.staged ? '[已暂存] ' : ''}${f.path} (${f.status})`).join('\n')
}

const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description:
    '查看工程的 git 状态：当前分支、与远端的领先/落后、已暂存/未暂存/未跟踪的文件清单。' +
    '改完文件后想知道「到底有哪些改动」时先调它。',
  parameters: { type: 'object', properties: {}, required: [] },
  category: 'read',
  execute: async (_args, ctx: ToolContext): Promise<ToolResult> => {
    const root = requireRoot(ctx)
    if (!root) return { ok: false, content: '', error: '没有工程根，无法执行 git' }
    const noGit = unavailableReason()
    if (noGit) return { ok: false, content: '', error: noGit }
    const s = await getStatus(root)
    if (!s.isRepo) {
      return { ok: false, content: '', error: `${root} 还不是 git 仓库。需要版本管理时先征得用户同意再 git init。` }
    }
    const parts = [
      `分支：${s.branch || '(未知)'}${s.upstream ? ` → ${s.upstream}` : ' (无上游)'}`,
      `领先 ${s.ahead} / 落后 ${s.behind}`,
      '',
      '已暂存：',
      fmtFiles(s.staged),
      '',
      '未暂存：',
      fmtFiles(s.unstaged),
      '',
      '未跟踪：',
      fmtFiles(s.untracked)
    ]
    const clean = !s.staged.length && !s.unstaged.length && !s.untracked.length
    if (clean) parts.push('', '工作区干净，无改动。')
    return { ok: true, content: parts.join('\n') }
  }
}

const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description:
    '查看某个文件的 git 差异。改完代码要确认改动内容、或回溯某文件之前长什么样时调用。' +
    'path 相对工程根；staged=true 看已暂存内容，默认看工作区相对暂存区的差异。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工程根的文件路径，如 src/main.ino' },
      staged: { type: 'boolean', description: 'true 看已暂存差异，默认 false 看工作区未暂存差异' }
    },
    required: ['path']
  },
  category: 'read',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const root = requireRoot(ctx)
    if (!root) return { ok: false, content: '', error: '没有工程根，无法执行 git' }
    const noGit = unavailableReason()
    if (noGit) return { ok: false, content: '', error: noGit }
    const path = String(args.path || '').trim()
    if (!path) return { ok: false, content: '', error: 'path 不能为空' }
    if (!(await isRepo(root))) {
      return { ok: false, content: '', error: `${root} 还不是 git 仓库，无法查看 diff。` }
    }
    const diff = await getDiff(root, path, Boolean(args.staged))
    return { ok: true, content: diff || '（该文件无差异）' }
  }
}

const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description:
    '查看最近提交记录（sha / 作者 / 时间 / 标题）。想知道某段功能是什么时候加的、' +
    '或找某个历史实现时调用。',
  parameters: {
    type: 'object',
    properties: {
      n: { type: 'number', description: '返回条数，默认 20，上限 100' }
    },
    required: []
  },
  category: 'read',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const root = requireRoot(ctx)
    if (!root) return { ok: false, content: '', error: '没有工程根，无法执行 git' }
    const noGit = unavailableReason()
    if (noGit) return { ok: false, content: '', error: noGit }
    if (!(await isRepo(root))) {
      return { ok: false, content: '', error: `${root} 还不是 git 仓库，没有提交历史。` }
    }
    const nRaw = Number(args.n ?? 20)
    const n = Math.max(1, Math.min(100, Number.isFinite(nRaw) ? Math.floor(nRaw) : 20))
    const log = await getLog(root, n)
    if (!log.length) return { ok: true, content: '（无提交记录，可能是刚 init 还没有 commit）' }
    const body = log.map((e) => `${e.sha} ${e.date} ${e.author}: ${e.subject}`).join('\n')
    return { ok: true, content: `最近 ${log.length} 条提交：\n${body}` }
  }
}

// ── 写类操作 ──
// 一律 category: 'write' → PermissionPolicy 默认模式下会弹确认框（auto 模式才直放）。
// 服务层已做分支名校验等安全处理，这里不再重复校验，只做参数兜底与错误如实回报。

const gitStageTool: ToolDefinition = {
  name: 'git_stage',
  description:
    '把改动加入暂存区。commit 前必须先 stage。paths 省略或为空时暂存全部改动。' +
    '只影响 git 索引，不修改文件内容。',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: '相对工程根的文件路径列表；省略表示全部' }
    },
    required: []
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const root = requireRoot(ctx)
    if (!root) return { ok: false, content: '', error: '没有工程根，无法执行 git' }
    const noGit = unavailableReason()
    if (noGit) return { ok: false, content: '', error: noGit }
    if (!(await isRepo(root))) return { ok: false, content: '', error: `${root} 还不是 git 仓库。` }
    const raw = args.paths
    const paths = Array.isArray(raw) ? raw.map((p) => String(p).trim()).filter(Boolean) : []
    // stageAll 额外返回 skipped（无 commit 的子仓库），stage 没有——分开处理避免联合类型收窄失败
    let skipped: string[] = []
    if (paths.length) {
      const r = await stage(root, paths)
      if (!r.ok) return { ok: false, content: '', error: r.error || '暂存失败' }
      return { ok: true, content: `已暂存 ${paths.length} 个文件：${paths.join(', ')}` }
    } else {
      const r = await stageAll(root)
      if (!r.ok) return { ok: false, content: '', error: r.error || '暂存失败' }
      skipped = r.skipped || []
    }
    const note = skipped.length ? `（跳过无 commit 的子仓库：${skipped.join(', ')}）` : ''
    return { ok: true, content: `已暂存全部改动${note}` }
  }
}

const gitUnstageTool: ToolDefinition = {
  name: 'git_unstage',
  description: '把文件从暂存区移出（保留工作区改动不变）。想重新选择要提交哪些文件时调用。',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: '相对工程根的文件路径列表' }
    },
    required: ['paths']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const root = requireRoot(ctx)
    if (!root) return { ok: false, content: '', error: '没有工程根，无法执行 git' }
    const noGit = unavailableReason()
    if (noGit) return { ok: false, content: '', error: noGit }
    if (!(await isRepo(root))) return { ok: false, content: '', error: `${root} 还不是 git 仓库。` }
    const raw = args.paths
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, content: '', error: 'paths 不能为空' }
    const paths = raw.map((p) => String(p).trim()).filter(Boolean)
    const r = await unstage(root, paths)
    if (!r.ok) return { ok: false, content: '', error: r.error || '取消暂存失败' }
    return { ok: true, content: `已取消暂存 ${paths.length} 个文件：${paths.join(', ')}` }
  }
}

const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description:
    '提交暂存区的改动。message 用祈使句写清「做了什么」（如「修复串口超时后未关闭端口」）。' +
    '只会提交**已暂存**内容，不会自动 stage ——提交前先用 git_stage。',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '提交信息，第一行用祈使句概括改动' }
    },
    required: ['message']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const root = requireRoot(ctx)
    if (!root) return { ok: false, content: '', error: '没有工程根，无法执行 git' }
    const noGit = unavailableReason()
    if (noGit) return { ok: false, content: '', error: noGit }
    if (!(await isRepo(root))) return { ok: false, content: '', error: `${root} 还不是 git 仓库。` }
    const message = String(args.message || '').trim()
    if (!message) return { ok: false, content: '', error: 'message 不能为空' }
    // 没有暂存内容时如实报错，别让模型以为已提交
    const s = await getStatus(root)
    if (!s.staged.length) {
      const hint = s.unstaged.length || s.untracked.length ? '当前有未暂存改动，请先 git_stage。' : '工作区干净，没有可提交的改动。'
      return { ok: false, content: '', error: `暂存区为空，未执行提交。${hint}` }
    }
    const r = await commit(root, message)
    if (!r.ok) return { ok: false, content: '', error: r.error || '提交失败' }
    return { ok: true, content: `已提交 ${r.sha || ''}：${message.split('\n')[0]}（共 ${s.staged.length} 个文件）` }
  }
}

const gitBranchTool: ToolDefinition = {
  name: 'git_branch',
  description:
    '分支操作。action=create 新建（可同时切换）、list 列出、checkout 切换已有分支。' +
    '做实验性改动前先建分支，避免污染主分支。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'create | list | checkout' },
      name: { type: 'string', description: '分支名（create/checkout 时必填）' },
      checkout: { type: 'boolean', description: 'create 时是否顺便切换，默认 true' }
    },
    required: ['action']
  },
  category: 'write',
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const root = requireRoot(ctx)
    if (!root) return { ok: false, content: '', error: '没有工程根，无法执行 git' }
    const noGit = unavailableReason()
    if (noGit) return { ok: false, content: '', error: noGit }
    if (!(await isRepo(root))) return { ok: false, content: '', error: `${root} 还不是 git 仓库。` }
    const action = String(args.action || '').trim()
    const name = String(args.name || '').trim()

    if (action === 'list') {
      const view = await listBranches(root)
      const lines = view.branches.map((b) => `${b.current ? '* ' : '  '}${b.name}${b.current ? '（当前）' : ''}`)
      return { ok: true, content: `分支列表：\n${lines.join('\n') || '（无）'}` }
    }
    if (!name) return { ok: false, content: '', error: `${action} 时 name 不能为空` }
    if (action === 'create') {
      const r = await createBranch(root, name, args.checkout !== false)
      if (!r.ok) return { ok: false, content: '', error: r.error || '建分支失败' }
      return { ok: true, content: args.checkout !== false ? `已新建并切换到分支 ${name}` : `已新建分支 ${name}（未切换）` }
    }
    if (action === 'checkout') {
      const r = await checkoutBranch(root, name)
      if (!r.ok) return { ok: false, content: '', error: r.error || '切换分支失败' }
      return { ok: true, content: `已切换到分支 ${name}` }
    }
    return { ok: false, content: '', error: `未知 action：${action}（支持 create / list / checkout）` }
  }
}

export const gitTools: ToolDefinition[] = [
  gitStatusTool, gitDiffTool, gitLogTool,
  gitStageTool, gitUnstageTool, gitCommitTool, gitBranchTool
]