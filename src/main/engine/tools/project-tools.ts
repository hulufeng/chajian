// 项目配置/写保护/检查点 工具（P0）
import type { ToolDefinition, ToolContext, ToolResult } from '../types'
import {
  generateProjectConfig,
  listProtectedFiles,
  createCheckpoint,
  listCheckpoints,
  rewindCheckpoint,
  forkCheckpoint,
  LABIGNORE_NAME,
  LABCODE_MD_NAME
} from '../project-config'
import { buildProjectContext } from '../project-context'

function requireRoot(ctx: ToolContext): string | ToolResult {
  if (!ctx.projectRoot) {
    return {
      ok: false,
      content: '',
      error: '未打开项目（无项目根目录）。请先打开/创建一个项目后再操作。'
    }
  }
  return ctx.projectRoot
}

// 生成 labcode.md
const projectInit: ToolDefinition = {
  name: 'project_init',
  description:
    `在当前项目根生成 ${LABCODE_MD_NAME} 项目配置文件（目标芯片/开发板/框架、构建与烧录命令、串口、项目规则）。该文件每次对话自动加载且优先级最高。已存在则不覆盖。建议每个固件项目开始时调用一次，再按实际情况补全。`,
  parameters: {
    type: 'object',
    properties: {},
    required: []
  },
  category: 'write',
  execute: async (_args, ctx) => {
    const root = requireRoot(ctx)
    if (typeof root !== 'string') return root
    try {
      const r = generateProjectConfig(root)
      if (!r.created) {
        return { ok: true, content: `${LABCODE_MD_NAME} 已存在，未覆盖：${r.path}。可直接编辑它补全项目信息。` }
      }
      return {
        ok: true,
        content: `已生成项目配置：${r.path}\n请补全目标芯片/开发板、构建与烧录命令等；之后每次对话都会自动加载。`
      }
    } catch (e) {
      return { ok: false, content: '', error: `生成 ${LABCODE_MD_NAME} 失败: ${(e as Error).message}` }
    }
  }
}

// 查看写保护规则与被保护文件
const labignoreCheck: ToolDefinition = {
  name: 'labignore_check',
  description:
    `查看 ${LABIGNORE_NAME} 写保护规则，以及当前被保护（AI 不可改）的文件清单。没有 ${LABIGNORE_NAME} 时会给出创建方法。`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要检查的子目录，默认整个项目' }
    },
    required: []
  },
  category: 'read',
  execute: async (args, ctx) => {
    const root = requireRoot(ctx)
    if (typeof root !== 'string') return root
    try {
      const dir = args.path ? String(args.path) : undefined
      const { rules, blocked } = listProtectedFiles(root, dir)
      if (rules.length === 0) {
        return {
          ok: true,
          content:
            `项目中没有 ${LABIGNORE_NAME}。可在项目根创建它来保护关键文件（gitignore 语法），例如：
  vendor/            保护整个目录
  *.bin              保护某类文件
  **/generated/**    保护任意层级的 generated 目录
  !src/gen/cfg.h     单独放行某个文件
被保护的文件 AI 不会修改，但仍可读取作为上下文。`
        }
      }
      return {
        ok: true,
        content:
          `写保护规则（${rules.length}）：
${rules.map((r) => '  ' + r).join('\n')}

当前被保护文件（${blocked.length}）：
${blocked.map((f) => '  ' + f).join('\n') || '  （暂无匹配文件）'}`
      }
    } catch (e) {
      return { ok: false, content: '', error: `查看写保护失败: ${(e as Error).message}` }
    }
  }
}

// 检查点：创建
const checkpointCreate: ToolDefinition = {
  name: 'checkpoint_create',
  description:
    '为当前项目创建检查点（快照全部源码文本文件）。大改动前可先创建，之后可用 checkpoint_rewind 回退、checkpoint_fork 从该点分叉。快照存于项目内 .labcode/checkpoints。',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: '说明性标签，如"重构串口驱动前"，留空用时间戳' }
    },
    required: []
  },
  category: 'execute',
  execute: async (args, ctx) => {
    const root = requireRoot(ctx)
    if (typeof root !== 'string') return root
    try {
      const cp = createCheckpoint(root, args.label ? String(args.label) : undefined)
      return {
        ok: true,
        content: `已创建检查点 ${cp.id}（${cp.label}），快照 ${cp.files.length} 个文件。\n回退：checkpoint_rewind({id:"${cp.id}"})；分叉：checkpoint_fork({id:"${cp.id}"})。`
      }
    } catch (e) {
      return { ok: false, content: '', error: `创建检查点失败: ${(e as Error).message}` }
    }
  }
}

// 检查点：列表
const checkpointList: ToolDefinition = {
  name: 'checkpoint_list',
  description: '列出当前项目的全部检查点（新→旧），含 ID、标签、时间、文件数。',
  parameters: {
    type: 'object',
    properties: {},
    required: []
  },
  category: 'read',
  execute: async (_args, ctx) => {
    const root = requireRoot(ctx)
    if (typeof root !== 'string') return root
    try {
      const list = listCheckpoints(root)
      if (list.length === 0) {
        return { ok: true, content: '暂无检查点。大改动前可调用 checkpoint_create 创建。' }
      }
      return {
        ok: true,
        content:
          `检查点（${list.length}）：
${list
  .map((cp) => `${cp.id}  ${cp.label}  [${new Date(cp.timestamp).toISOString().slice(0, 16)}]  ${cp.files.length} 文件`)
  .join('\n')}`
      }
    } catch (e) {
      return { ok: false, content: '', error: `列出检查点失败: ${(e as Error).message}` }
    }
  }
}

// 检查点：回退
const checkpointRewind: ToolDefinition = {
  name: 'checkpoint_rewind',
  description:
    '把项目文件回退到指定检查点的状态：恢复快照文件，并删除该检查点之后新增的受管文件（会在结果中列出）。操作前建议先 checkpoint_create 保存当前状态。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '检查点 ID（来自 checkpoint_list）' }
    },
    required: ['id']
  },
  category: 'write',
  execute: async (args, ctx) => {
    const root = requireRoot(ctx)
    if (typeof root !== 'string') return root
    try {
      const r = rewindCheckpoint(root, String(args.id))
      return {
        ok: true,
        content:
          `已回退到检查点 ${r.checkpoint.id}（${r.checkpoint.label}）。
恢复文件 ${r.restored} 个；删除快照后新增文件 ${r.deleted.length} 个${
            r.deleted.length > 0 ? '：\n' + r.deleted.map((f) => '  ' + f).join('\n') : ''
          }。
建议随后构建/运行以验证。`
      }
    } catch (e) {
      return { ok: false, content: '', error: `回退失败: ${(e as Error).message}` }
    }
  }
}

// 检查点：分叉
const checkpointFork: ToolDefinition = {
  name: 'checkpoint_fork',
  description:
    '从指定检查点分叉出一个新的项目目录（兄弟目录），不影响当前项目，不依赖 git。用于从历史状态探索另一种实现。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '检查点 ID' },
      branch: { type: 'string', description: '新目录名，留空自动生成' }
    },
    required: ['id']
  },
  category: 'write',
  execute: async (args, ctx) => {
    const root = requireRoot(ctx)
    if (typeof root !== 'string') return root
    try {
      const r = forkCheckpoint(root, String(args.id), args.branch ? String(args.branch) : undefined)
      return { ok: true, content: `已从检查点 ${r.checkpoint.id} 分叉出新目录：${r.newPath}（当前项目不受影响）。` }
    } catch (e) {
      return { ok: false, content: '', error: `分叉失败: ${(e as Error).message}` }
    }
  }
}

// 项目上下文（确定性扫描，P1-6）：手动刷新/查看
const projectOverview: ToolDefinition = {
  name: 'project_overview',
  description:
    '用确定性扫描（文件树 + 源码正则，零模型推理）输出项目总览：目录结构、关键源码文件、头文件/库依赖、引脚与外设使用、构建/工程配置。' +
    '会话启动时已自动注入该上下文；**当项目结构发生较大变化（新增文件/换框架/加库）需要刷新时再调用**，平时不要重复调用（避免浪费上下文）。',
  parameters: {
    type: 'object',
    properties: {
      depth: { type: 'number', description: '目录树深度，默认 3' }
    },
    required: []
  },
  category: 'read',
  execute: async (args, ctx) => {
    const root = requireRoot(ctx)
    if (typeof root !== 'string') return root
    try {
      const text = buildProjectContext(root, { depth: Number(args.depth) || 3, maxChars: 6000 })
      if (!text) return { ok: false, content: '', error: '项目根不可读或为空目录，无法生成上下文。' }
      return { ok: true, content: text }
    } catch (e) {
      return { ok: false, content: '', error: `扫描项目失败: ${(e as Error).message}` }
    }
  }
}

export const projectTools: ToolDefinition[] = [
  projectInit,
  projectOverview,
  labignoreCheck,
  checkpointCreate,
  checkpointList,
  checkpointRewind,
  checkpointFork
]
