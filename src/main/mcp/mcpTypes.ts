/**
 * MCP（Model Context Protocol）协议类型 + 硬件工具定义。
 *
 * 设计目标：把 codelab 的「板卡识别 / 编译 / 烧录 / 串口」能力标准化为 MCP 工具，
 * 命名与入参尽量对齐 PlatformIO MCP 协议，使任意兼容 MCP 的 AI 客户端
 * （Claude Desktop / Cline / Cursor / 自研 Agent）都能直接驱动 ESP32 工具链。
 *
 * 本文件不依赖任何 Electron / electron-vite 专属模块，可独立在 Node 进程里运行，
 * 便于用 node 直接起一个 stdio 版 MCP server（`out/main/mcp-stdio.js --mcp`）。
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: JsonRpcError
}

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** tools/call 派发后返回的结构（与 MCP content 块解耦，由 mcpServer 包装成协议格式） */
export interface HardwareToolResult {
  content: string
  isError?: boolean
  data?: unknown
}

/**
 * 硬件 MCP 工具清单。命名对齐 PlatformIO MCP（board/compile/upload/monitor），
 * 入参尽量贴近其约定，方便熟悉 PlatformIO MCP 的客户端零成本迁移。
 */
export const HARDWARE_MCP_TOOLS: McpTool[] = [
  {
    name: 'board_list',
    description:
      '列出当前已连接的开发板（通过 arduino-cli board list + serialport 兜底识别，VID 303A 即 ESP32 类）。返回每块板的 name / fqbn / port。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少块，默认 8' }
      }
    }
  },
  {
    name: 'board_detect',
    description:
      '自动检测第一块已连接的开发板，返回其 fqbn / name / port（编译/烧录可直接复用，无需手工指定板型）。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'compile',
    description:
      '用 arduino-cli 编译一个 sketch（.ino/.cpp）。fqbn 留空则自动采用已连接板子的 FQBN。返回编译成功/失败与末尾输出。',
    inputSchema: {
      type: 'object',
      properties: {
        fqbn: { type: 'string', description: '板卡 FQBN，如 esp32:esp32:esp32c3。留空自动用已连接板子' },
        sketch: { type: 'string', description: '项目/sketch 目录路径。留空使用当前工作目录' }
      }
    }
  },
  {
    name: 'upload',
    description:
      '编译并烧录到开发板（arduino-cli upload）。fqbn/port 留空自动采用已连接板子。返回烧录结果。',
    inputSchema: {
      type: 'object',
      properties: {
        fqbn: { type: 'string', description: '板卡 FQBN，如 esp32:esp32:esp32c3。留空自动用已连接板子' },
        port: { type: 'string', description: '串口端口，如 COM3 / /dev/ttyUSB0。留空自动检测' },
        sketch: { type: 'string', description: '项目目录，默认当前工作目录' }
      }
    }
  },
  {
    name: 'serial_monitor',
    description:
      '串口监视器。duration 采样模式（默认 8000ms 内读取设备输出，超时自动关闭）；continuous:true 时保持连接并返回会话 ID（serial-端口），后续用 serial_send / serial_read / serial_stop 交互。',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '串口端口，如 COM3。留空自动取第一个可用端口' },
        baud: { type: 'number', description: '波特率，默认 115200' },
        duration: { type: 'number', description: '采样模式读取时长（毫秒），默认 8000' },
        continuous: { type: 'boolean', description: '持续模式：true 时保持连接并返回会话 ID' }
      }
    }
  },
  {
    name: 'serial_send',
    description: '向已打开的串口会话发送一行数据（自动补换行）。若端口未打开则自动建立持久会话。',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '串口端口，如 COM3' },
        data: { type: 'string', description: '要发送的文本（自动补 \\n）' },
        baud: { type: 'number', description: '仅在需要自动开端口时的波特率，默认 115200' }
      },
      required: ['data']
    }
  },
  {
    name: 'serial_read',
    description: '读取已打开串口会话截至目前的设备输出（消费式：读后清空缓冲）。',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '串口端口，如 COM3' },
        keep: { type: 'boolean', description: '保留缓冲（true 则不清空），默认 false' }
      }
    }
  },
  {
    name: 'serial_stop',
    description: '关闭一个持续串口会话，释放端口。',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '串口端口，如 COM3' }
      },
      required: ['port']
    }
  }
]
