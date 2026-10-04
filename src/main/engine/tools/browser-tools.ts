// 浏览器自动化 Agent 工具：导航 / 截图 / 点击 / 填表 / 执行 JS / 网络记录 / 关闭
// 对齐 TrieCode 截图里 agent 的"浏览器自动化（导航/截图/点击/填表/网络请求/JS 执行）"能力。
// 依赖 Playwright（动态加载，未安装时提示 npm i playwright）。
import {
  browserNavigate,
  browserScreenshot,
  browserClick,
  browserFill,
  browserEvaluate,
  browserNetwork,
  browserClose,
  browserUpload,
  browserDownload,
  browserDialogHandler
} from '../../services/browser-automation'
import type { ToolDefinition, ToolResult } from '../types'

function guard(fn: () => Promise<string>): Promise<ToolResult> {
  return fn()
    .then((content) => ({ ok: true, content }))
    .catch((e) => ({ ok: false, content: '', error: (e as Error).message }))
}

const browserNavigateTool: ToolDefinition = {
  name: 'browser_navigate',
  description: '浏览器自动化：导航到指定 URL。需已安装 Playwright（npm i playwright && npx playwright install chromium）。后续 click/fill/screenshot 共享同一页面。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标网址，如 https://example.com' }
    },
    required: ['url']
  },
  category: 'execute',
  execute: (args) => guard(() => browserNavigate(String(args.url)))
}

const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  description: '浏览器自动化：对当前页面截图并保存为 PNG，返回文件路径。可用于查看页面渲染结果。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '可选：保存路径，默认临时目录' }
    },
    required: []
  },
  category: 'execute',
  execute: (args) => guard(() => browserScreenshot(args.path ? String(args.path) : undefined))
}

const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  description: '浏览器自动化：点击页面上匹配 CSS 选择器的元素（如 button#submit、a.link）。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS 选择器，如 #id、.class、button' }
    },
    required: ['selector']
  },
  category: 'execute',
  execute: (args) => guard(() => browserClick(String(args.selector)))
}

const browserFillTool: ToolDefinition = {
  name: 'browser_fill',
  description: '浏览器自动化：在输入框（CSS 选择器匹配）中填写文本，用于表单自动填写。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '输入框 CSS 选择器' },
      value: { type: 'string', description: '要填写的文本' }
    },
    required: ['selector', 'value']
  },
  category: 'execute',
  execute: (args) => guard(() => browserFill(String(args.selector), String(args.value)))
}

const browserEvaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  description: '浏览器自动化：在当前页面执行一段 JavaScript 并返回结果（可用于读取 DOM、调用页面 API、提取数据）。',
  parameters: {
    type: 'object',
    properties: {
      js: { type: 'string', description: '要执行的 JavaScript 代码' }
    },
    required: ['js']
  },
  category: 'execute',
  execute: (args) => guard(() => browserEvaluate(String(args.js)))
}

const browserNetworkTool: ToolDefinition = {
  name: 'browser_network',
  description: '浏览器自动化：返回本次会话已发生的网络请求记录（URL/方法/状态码），用于检查页面加载了哪些资源或接口调用。',
  parameters: {
    type: 'object',
    properties: {},
    required: []
  },
  category: 'execute',
  execute: () => {
    const recs = browserNetwork()
    if (recs.length === 0) return Promise.resolve({ ok: true, content: '（暂无网络请求记录，先 browser_navigate 访问页面）' })
    const lines = recs.map((r) => `  [${r.method}] ${r.status ?? '-'} ${r.url}`)
    return Promise.resolve({ ok: true, content: `网络请求（${recs.length} 条）：\n${lines.join('\n')}` })
  }
}

const browserCloseTool: ToolDefinition = {
  name: 'browser_close',
  description: '浏览器自动化：关闭浏览器会话，释放资源。完成自动化任务后建议调用。',
  parameters: {
    type: 'object',
    properties: {},
    required: []
  },
  category: 'execute',
  execute: () => {
    browserClose()
    return Promise.resolve({ ok: true, content: '浏览器会话已关闭。' })
  }
}

const browserUploadTool: ToolDefinition = {
  name: 'browser_upload',
  description: '浏览器自动化：在文件输入框（CSS 选择器匹配）中设置要上传的本地文件并触发上传。用于自动化文件上传表单（如固件/图片上传）。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '文件输入框的 CSS 选择器，如 input[type=file]' },
      file_path: { type: 'string', description: '要上传的本地文件绝对路径' }
    },
    required: ['selector', 'file_path']
  },
  category: 'execute',
  execute: (args) => guard(() => browserUpload(String(args.selector), String(args.file_path)))
}

const browserDownloadTool: ToolDefinition = {
  name: 'browser_download',
  description: '浏览器自动化：等待并保存一次下载。给定 url（下载直链）则先导航再等待下载；不传 url 则等待页面后续点击触发的下载（最长 30s）。返回保存的本地路径。用于自动下载文件（如固件/资料）。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '可选：下载直链 URL，访问后触发下载' },
      timeout: { type: 'number', description: '等待下载超时（毫秒），默认 30000' }
    },
    required: []
  },
  category: 'execute',
  execute: (args) => guard(() => browserDownload(args.url ? String(args.url) : undefined, args.timeout ? Number(args.timeout) : 30000))
}

const browserDialogTool: ToolDefinition = {
  name: 'browser_handle_dialog',
  description: '浏览器自动化：设定网页对话框（alert/confirm/prompt）的自动处理策略。action=accept 自动确认（可填 text 应对 prompt）；action=dismiss 自动取消；action=ignore 交页面默认。常用于自动确认下载/提交确认框。返回最近一次捕获的对话框消息（若有）。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '处理策略', enum: ['accept', 'dismiss', 'ignore'] },
      text: { type: 'string', description: 'accept 时填充到 prompt 的文本，可选' }
    },
    required: ['action']
  },
  category: 'execute',
  execute: (args) => {
    try {
      const msg = browserDialogHandler(String(args.action) as 'accept' | 'dismiss' | 'ignore', args.text ? String(args.text) : undefined)
      return Promise.resolve({ ok: true, content: msg })
    } catch (e) {
      return Promise.resolve({ ok: false, content: '', error: (e as Error).message })
    }
  }
}

export const browserTools: ToolDefinition[] = [
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserFillTool,
  browserEvaluateTool,
  browserNetworkTool,
  browserCloseTool,
  browserUploadTool,
  browserDownloadTool,
  browserDialogTool
]
