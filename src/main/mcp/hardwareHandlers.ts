/**
 * MCP 硬件工具的具体实现：把 board/compile/upload/serial 标准化为 MCP tools/call 可驱动的能力。
 * 直接复用嵌入式链路已有的底层服务（toolchain.ts / serialService.ts），与 Agent 内嵌的
 * embedded-tools 共享同一套 arduino-cli / serialport 调用，保证行为一致。
 */
import {
  findToolchain,
  compileSketch,
  uploadSketch,
  listConnectedBoardsWithSerial
} from '../services/toolchain'
import {
  listPorts,
  openSerialMonitor,
  writeSerial,
  closeSerial,
  readSerialBuffer,
  listSerialSessions
} from '../services/serialService'
import type { HardwareToolResult } from './mcpTypes'

const COMPILE_TIMEOUT = 180_000
const UPLOAD_TIMEOUT = 120_000

function runCompile(opts: {
  sketch: string
  fqbn: string
  bin: string
}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const cp = compileSketch(
      opts,
      (c) => {
        out += c
      },
      (code) => resolve({ code, out })
    )
    const t = setTimeout(() => {
      try {
        cp.kill()
      } catch {
        /* ignore */
      }
      resolve({ code: -1, out })
    }, COMPILE_TIMEOUT)
    cp.on('close', () => clearTimeout(t))
  })
}

function runUpload(opts: {
  sketch: string
  fqbn: string
  bin: string
  port: string
}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const cp = uploadSketch(
      opts,
      (c) => {
        out += c
      },
      (code) => resolve({ code, out })
    )
    const t = setTimeout(() => {
      try {
        cp.kill()
      } catch {
        /* ignore */
      }
      resolve({ code: -1, out })
    }, UPLOAD_TIMEOUT)
    cp.on('close', () => clearTimeout(t))
  })
}

function noToolchain(): HardwareToolResult {
  return { content: '未找到 arduino-cli 工具链，请先在设置中安装或配置 Arduino CLI。', isError: true }
}

/**
 * MCP 工具派发入口：name 对应 HARDWARE_MCP_TOOLS 中的工具名。
 */
export async function dispatchHardwareTool(
  name: string,
  args: Record<string, unknown>
): Promise<HardwareToolResult> {
  switch (name) {
    case 'board_list': {
      const bin = findToolchain()
      if (!bin) return noToolchain()
      const boards = await listConnectedBoardsWithSerial(bin)
      const limit = Number(args.limit) || 8
      const shown = boards.slice(0, limit)
      const text = shown.length
        ? shown
            .map((b, i) => `${i + 1}. ${b.name || '未知板'} ｜ FQBN: ${b.fqbn || '-'} ｜ 端口: ${b.port || '-'}`)
            .join('\n')
        : '未检测到已连接的串口设备。'
      return { content: text, data: { count: boards.length, boards: shown } }
    }

    case 'board_detect': {
      const bin = findToolchain()
      if (!bin) return noToolchain()
      const boards = await listConnectedBoardsWithSerial(bin)
      if (boards.length === 0) return { content: '未检测到已连接板子。', isError: true }
      const b = boards[0]
      return {
        content: `已检测第一块板：name=${b.name || '-'} ｜ FQBN=${b.fqbn || '-'} ｜ port=${b.port || '-'}`,
        data: { name: b.name, fqbn: b.fqbn, port: b.port }
      }
    }

    case 'compile': {
      const bin = findToolchain()
      if (!bin) return noToolchain()
      let fqbn = args.fqbn ? String(args.fqbn) : ''
      const sketch = args.sketch ? String(args.sketch) : process.cwd()
      if (!fqbn) {
        const boards = await listConnectedBoardsWithSerial(bin)
        if (boards[0]?.fqbn) fqbn = boards[0].fqbn
      }
      if (!fqbn) {
        return { content: '未指定 fqbn 且未检测到已连接板子，请提供 fqbn（如 esp32:esp32:esp32c3）。', isError: true }
      }
      const { code, out } = await runCompile({ sketch, fqbn, bin })
      const ok = code === 0
      return {
        content: ok
          ? `编译成功（退出码 0）。\n${out.slice(-3000)}`
          : `编译失败（退出码 ${code}）。\n${out.slice(-3000)}`,
        isError: !ok,
        data: { exitCode: code }
      }
    }

    case 'upload': {
      const bin = findToolchain()
      if (!bin) return noToolchain()
      let fqbn = args.fqbn ? String(args.fqbn) : ''
      let port = args.port ? String(args.port) : ''
      const sketch = args.sketch ? String(args.sketch) : process.cwd()
      const boards = await listConnectedBoardsWithSerial(bin)
      if (!fqbn && boards[0]?.fqbn) fqbn = boards[0].fqbn
      if (!port && boards[0]?.port) port = boards[0].port
      if (!fqbn) {
        return { content: '未指定 fqbn 且未检测到已连接板子，请提供 fqbn。', isError: true }
      }
      if (!port) {
        return { content: '未指定 port 且未检测到已连接板子，请连接设备后重试或显式传入 port。', isError: true }
      }
      const comp = await runCompile({ sketch, fqbn, bin })
      if (comp.code !== 0) {
        return {
          content: `烧录前编译失败（退出码 ${comp.code}），已中止烧录。\n${comp.out.slice(-2000)}`,
          isError: true
        }
      }
      const up = await runUpload({ sketch, fqbn, bin, port })
      const ok = up.code === 0
      return {
        content: ok
          ? `烧录成功（退出码 0）。\n${up.out.slice(-2000)}`
          : `烧录失败（退出码 ${up.code}）。\n${up.out.slice(-2000)}`,
        isError: !ok,
        data: { exitCode: up.code }
      }
    }

    case 'serial_monitor': {
      let port = args.port ? String(args.port) : ''
      const baud = Number(args.baud) || 115200
      const duration = Number(args.duration) || 8000
      const continuous = args.continuous === true || args.continuous === 'true'
      if (!port) {
        const ports = await listPorts()
        if (ports.length === 0) return { content: '未检测到可用串口，请连接开发板后重试。', isError: true }
        port = ports[0].path
      }
      const sessionId = `serial-${port}`
      if (continuous) {
        let resolved = false
        return new Promise<HardwareToolResult>((resolve) => {
          openSerialMonitor(
            { port, baud },
            () => undefined,
            (msg) => {
              if (!resolved) {
                resolved = true
                resolve({ content: msg, isError: true })
              }
            }
          )
          setTimeout(() => {
            if (resolved) return
            resolved = true
            resolve({
              content: `已打开持续串口会话 ${sessionId}（${port} @ ${baud}）。用 serial_send 下发指令、serial_read 读回、serial_stop 关闭。`,
              data: { sessionId, port, baud }
            })
          }, 800)
        })
      }
      return new Promise<HardwareToolResult>((resolve) => {
        let buf = ''
        const close = openSerialMonitor(
          { port, baud },
          (c) => {
            buf += c
          },
          () => undefined
        )
        setTimeout(() => {
          try {
            close()
          } catch {
            /* ignore */
          }
          resolve({
            content: `串口 ${port} @ ${baud} 读取结束（${duration}ms）：\n${buf || '(无输出)'}`,
            data: { port, baud }
          })
        }, duration)
      })
    }

    case 'serial_send': {
      let port = args.port ? String(args.port) : ''
      const data = String(args.data ?? '')
      if (!port) {
        const sessions = listSerialSessions()
        if (sessions.length > 0) port = sessions[0].id.replace(/^serial-/, '')
        else {
          const ports = await listPorts()
          if (ports.length === 0) return { content: '未指定 port 且未检测到可用串口。', isError: true }
          port = ports[0].path
        }
      }
      const id = `serial-${port}`
      if (!listSerialSessions().some((s) => s.id === id)) {
        const baud = Number(args.baud) || 115200
        let opened = false
        await new Promise<void>((resolve) => {
          openSerialMonitor(
            { port, baud },
            () => undefined,
            (msg) => {
              if (msg.includes('失败') || msg.includes('不可用')) resolve()
            }
          )
          setTimeout(() => {
            opened = true
            resolve()
          }, 800)
        })
        if (!opened) return { content: `无法自动打开串口 ${port}（设备未连接或 serialport 不可用）。`, isError: true }
      }
      const r = writeSerial(id, data)
      if (!r.ok) return { content: r.error || '发送失败', isError: true }
      return { content: `已向 ${id} 发送：${data}` }
    }

    case 'serial_read': {
      let port = args.port ? String(args.port) : ''
      if (!port) {
        const sessions = listSerialSessions()
        if (sessions.length === 0) return { content: '未指定 port 且当前无打开的串口会话。', isError: true }
        port = sessions[0].id.replace(/^serial-/, '')
      }
      const keep = args.keep === true || args.keep === 'true'
      const r = readSerialBuffer(`serial-${port}`, !keep)
      if (!r.ok) return { content: r.error || '读取失败', isError: true }
      return { content: `串口 serial-${port} 设备输出：\n${r.data || '(无新输出)'}`, data: { port } }
    }

    case 'serial_stop': {
      const port = String(args.port || '')
      const r = closeSerial(`serial-${port}`)
      if (!r.ok) return { content: r.error || '关闭失败', isError: true }
      return { content: `已关闭串口会话 serial-${port}。` }
    }

    default:
      return { content: `未知工具：${name}`, isError: true }
  }
}
