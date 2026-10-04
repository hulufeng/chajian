// 嵌入式专用工具：编译 / 烧录 / 串口回读
// 包装 arduino-cli（toolchain.ts）与 serialport（serialService.ts），让 Agent 能真正干硬件活，
// 对齐 TrieCode 截图里 agent 调 compile/upload/run_commands 的能力。
// 工具名 compile/upload 已被 agent-runner 验证闸门识别为"验证动作"，改文件后调用即视为已验证。
import { findToolchain, compileSketch, uploadSketch, listConnectedBoardsWithSerial } from '../../services/toolchain'
import { listPorts, openSerialMonitor, writeSerial, closeSerial, readSerialBuffer, listSerialSessions, readSerialLog, clearSerialLog } from '../../services/serialService'
import type { ToolDefinition, ToolContext, ToolResult } from '../types'

const COMPILE_TIMEOUT_MS = 180_000
const UPLOAD_TIMEOUT_MS = 120_000

function resolveSketch(args: Record<string, unknown>, ctx: ToolContext): string {
  return args.sketch ? String(args.sketch) : (ctx.projectRoot || ctx.cwd)
}

// ---------- 工具1: compile ----------
const compile: ToolDefinition = {
  name: 'compile',
  description: '用 arduino-cli 编译当前项目（.ino/.cpp）。编译输出实时流式返回，结束给出成功/失败与错误摘要。这是嵌入式项目的"构建验证"动作——修改代码后应调用本工具确认能编译通过。',
  parameters: {
    type: 'object',
    properties: {
      fqbn: { type: 'string', description: '板卡 FQBN，如 esp32:esp32:esp32c3。留空则自动使用已连接板子的 FQBN' },
      sketch: { type: 'string', description: '项目/sketch 目录路径，默认项目根目录' }
    },
    required: []
  },
  category: 'execute',
  execute: async (args, ctx): Promise<ToolResult> => {
    const bin = findToolchain()
    if (!bin) {
      return { ok: false, content: '', error: '未找到 arduino-cli。请在设置中一键安装或手动配置 Arduino CLI 工具链。' }
    }
    const sketch = resolveSketch(args, ctx)
    let fqbn = args.fqbn ? String(args.fqbn) : ''
    if (!fqbn) {
      const boards = await listConnectedBoardsWithSerial(bin)
      if (boards.length > 0 && boards[0].fqbn) fqbn = boards[0].fqbn
    }
    if (!fqbn) {
      return { ok: false, content: '', error: '未指定 fqbn 且未检测到已连接板子，请提供 fqbn（如 esp32:esp32:esp32c3）。' }
    }
    return new Promise<ToolResult>((resolve) => {
      let out = ''
      const cp = compileSketch(
        { sketch, fqbn, bin },
        (c) => { out += c; ctx.onOutput?.(c) },
        (code) => {
          const ok = code === 0
          const tail = out.length > 3000 ? '\n...(编译输出较长，仅显示末尾)\n' + out.slice(-3000) : out
          resolve({ ok, content: `编译${ok ? '成功' : '失败'}（退出码 ${code}）。\n${tail}`, data: { exitCode: code } })
        }
      )
      const timer = setTimeout(() => {
        try { cp.kill() } catch { /* 忽略 */ }
        resolve({ ok: false, content: out + '\n(编译超时，已终止)', error: `编译超时（默认 ${COMPILE_TIMEOUT_MS / 1000}s）` })
      }, COMPILE_TIMEOUT_MS)
      cp.on('close', () => clearTimeout(timer))
    })
  }
}

// ---------- 工具2: upload ----------
const upload: ToolDefinition = {
  name: 'upload',
  description: '编译并烧录当前项目到开发板（arduino-cli upload）。自动检测已连接端口；若指定 port 则用之。这是嵌入式项目的"部署"动作——把代码真正写入硬件。',
  parameters: {
    type: 'object',
    properties: {
      fqbn: { type: 'string', description: '板卡 FQBN，如 esp32:esp32:esp32c3。留空自动用已连接板子' },
      port: { type: 'string', description: '串口端口，如 COM3 / /dev/ttyUSB0。留空自动检测已连接板子' },
      sketch: { type: 'string', description: '项目目录，默认项目根目录' }
    },
    required: []
  },
  category: 'execute',
  execute: async (args, ctx): Promise<ToolResult> => {
    const bin = findToolchain()
    if (!bin) {
      return { ok: false, content: '', error: '未找到 arduino-cli。请先安装/配置工具链。' }
    }
    const sketch = resolveSketch(args, ctx)
    let fqbn = args.fqbn ? String(args.fqbn) : ''
    let port = args.port ? String(args.port) : ''
    const boards = await listConnectedBoardsWithSerial(bin)
    if (!fqbn && boards[0]?.fqbn) fqbn = boards[0].fqbn
    if (!port && boards[0]?.port) port = boards[0].port
    if (!fqbn) {
      return { ok: false, content: '', error: '未指定 fqbn 且未检测到已连接板子，请提供 fqbn。' }
    }
    if (!port) {
      return { ok: false, content: '', error: '未指定 port 且未检测到已连接板子，请连接设备后重试，或显式传入 port。' }
    }
    // 先编译，确保烧录的是最新代码
    const compiled = await new Promise<{ ok: boolean; out: string; code: number }>((resolve) => {
      let o = ''
      const cp = compileSketch(
        { sketch, fqbn, bin },
        (c) => { o += c; ctx.onOutput?.(c) },
        (code) => resolve({ ok: code === 0, out: o, code })
      )
      const t = setTimeout(() => { try { cp.kill() } catch { /* 忽略 */ } resolve({ ok: false, out: o, code: -1 }) }, COMPILE_TIMEOUT_MS)
      cp.on('close', () => clearTimeout(t))
    })
    if (!compiled.ok) {
      return { ok: false, content: `烧录前编译失败（退出码 ${compiled.code}），已中止烧录。\n${compiled.out.slice(-2000)}`, error: '编译失败' }
    }
    // 再烧录
    return new Promise<ToolResult>((resolve) => {
      let o = ''
      const cp = uploadSketch(
        { sketch, fqbn, bin, port },
        (c) => { o += c; ctx.onOutput?.(c) },
        (code) => {
          const ok = code === 0
          resolve({ ok, content: `烧录${ok ? '成功' : '失败'}（退出码 ${code}）。\n${o.length > 2000 ? o.slice(-2000) : o}`, data: { exitCode: code } })
        }
      )
      const timer = setTimeout(() => {
        try { cp.kill() } catch { /* 忽略 */ }
        resolve({ ok: false, content: o + '\n(烧录超时，已终止)', error: `烧录超时（默认 ${UPLOAD_TIMEOUT_MS / 1000}s）` })
      }, UPLOAD_TIMEOUT_MS)
      cp.on('close', () => clearTimeout(timer))
    })
  }
}

// ---------- 工具3: serial_monitor ----------
const serialMonitor: ToolDefinition = {
  name: 'serial_monitor',
  description: '串口监视器。两种模式：①采样模式（默认）：打开端口读取指定时长（默认 8 秒，波特率 115200）内设备输出，超时自动关闭，不阻塞；②持续模式（continuous:true）：打开端口后保持连接不自动关闭，立即返回会话 ID（serial-端口），后续用 serial_read 读回、serial_send 发送、serial_stop 关闭。用于烧录后回读设备日志/传感器读数，或做交互式串口通信。',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'string', description: '串口端口，如 COM3。留空自动取第一个可用端口' },
      baud: { type: 'number', description: '波特率，默认 115200' },
      duration: { type: 'number', description: '采样模式读取时长（毫秒），默认 8000' },
      continuous: { type: 'boolean', description: '是否持续模式。true 时打开端口并保持连接（不自动关闭），立即返回会话 ID，需手动 serial_stop 关闭' }
    },
    required: []
  },
  category: 'execute',
  execute: async (args, ctx): Promise<ToolResult> => {
    let port = args.port ? String(args.port) : ''
    const baud = Number(args.baud) || 115200
    const duration = Number(args.duration) || 8000
    const continuous = args.continuous === true || args.continuous === 'true'
    if (!port) {
      const ports = await listPorts()
      if (ports.length === 0) {
        return { ok: false, content: '', error: '未检测到可用串口。请连接开发板后重试。' }
      }
      port = ports[0].path
    }
    const sessionId = `serial-${port}`
    if (continuous) {
      let resolved = false
      return new Promise<ToolResult>((resolve) => {
        const close = openSerialMonitor(
          { port, baud },
          (c) => { ctx.onOutput?.(c) },
          (msg) => {
            if (!resolved) {
              resolved = true
              // 连接失败/端口断开：返回错误（onClose 在出错时也会带失败信息）
              resolve({ ok: false, content: '', error: msg })
            }
          }
        )
        // 给 initialize 一点时间，连接成功会先 onData("[port] 已连接")
        setTimeout(() => {
          if (resolved) return
          resolved = true
          resolve({
            ok: true,
            content: `已打开持续串口会话 ${sessionId}（${port} @ ${baud}）。\n用 serial_send 发送指令，serial_read 读回设备响应，serial_stop 关闭会话。`,
            data: { sessionId, port, baud, continuous: true }
          })
        }, 800)
      })
    }
    return new Promise<ToolResult>((resolve) => {
      let buf = ''
      const close = openSerialMonitor(
        { port, baud },
        (c) => { buf += c; ctx.onOutput?.(c) },
        (msg) => {
          resolve({
            ok: buf.length > 0,
            content: `串口 ${port} @ ${baud} 读取结束（${duration}ms）：\n${buf || '(无输出)'}\n${msg}`,
            data: { port, baud }
          })
        }
      )
      setTimeout(() => {
        try { close() } catch { /* 忽略 */ }
      }, duration)
    })
  }
}

// ---------- 工具4: serial_send ----------
const serialSend: ToolDefinition = {
  name: 'serial_send',
  description: '向已打开的串口会话发送一行数据（自动补换行）。会话可由 serial_monitor 的 continuous:true 建立，或发送时自动打开（若端口未打开则自动建立持久会话）。用于给开发板下发指令/AT 命令。',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'string', description: '串口端口，如 COM3。与已开会话的端口一致' },
      data: { type: 'string', description: '要发送的文本（会自动补 \\n）' },
      baud: { type: 'number', description: '仅在需要自动开端口时的波特率，默认 115200' }
    },
    required: ['data']
  },
  category: 'execute',
  execute: async (args, ctx): Promise<ToolResult> => {
    let port = args.port ? String(args.port) : ''
    const data = String(args.data)
    if (!port) {
      const sessions = listSerialSessions()
      if (sessions.length > 0) port = sessions[0].id.replace(/^serial-/, '')
      else {
        const ports = await listPorts()
        if (ports.length === 0) return { ok: false, content: '', error: '未指定 port 且未检测到可用串口。' }
        port = ports[0].path
      }
    }
    const id = `serial-${port}`
    // 若会话未打开，自动建立持久会话
    if (!listSerialSessions().some((s) => s.id === id)) {
      const baud = Number(args.baud) || 115200
      let opened = false
      await new Promise<void>((resolve) => {
        const close = openSerialMonitor({ port, baud }, () => undefined, (msg) => {
          if (msg.includes('失败') || msg.includes('不可用')) { opened = false; resolve() }
        })
        setTimeout(() => { opened = true; resolve() }, 800)
      })
      if (!opened) return { ok: false, content: '', error: `无法自动打开串口 ${port}（serialport 未加载或设备未连接）` }
    }
    const r = writeSerial(id, data)
    if (!r.ok) return { ok: false, content: '', error: r.error }
    return { ok: true, content: `已向 ${id} 发送：${data}` }
  }
}

// ---------- 工具5: serial_read ----------
const serialRead: ToolDefinition = {
  name: 'serial_read',
  description: '读取已打开串口会话截至目前的设备输出（消费式：读后清空缓冲）。需先由 serial_monitor continuous:true 或 serial_send 自动打开会话。用于发送指令后取回设备响应。',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'string', description: '串口端口，如 COM3。与已开会话一致' },
      keep: { type: 'boolean', description: '是否保留缓冲（true 则不清空，仅查看），默认 false（读后清空）' }
    },
    required: []
  },
  category: 'read',
  execute: async (args): Promise<ToolResult> => {
    let port = args.port ? String(args.port) : ''
    if (!port) {
      const sessions = listSerialSessions()
      if (sessions.length > 0) port = sessions[0].id.replace(/^serial-/, '')
      else return { ok: false, content: '', error: '未指定 port 且当前无打开的串口会话。' }
    }
    const id = `serial-${port}`
    const keep = args.keep === true || args.keep === 'true'
    const r = readSerialBuffer(id, !keep)
    if (!r.ok) return { ok: false, content: '', error: r.error }
    return { ok: true, content: `串口 ${id} 设备输出：\n${r.data || '(无新输出)'}` }
  }
}

// ---------- 工具6: serial_stop ----------
const serialStop: ToolDefinition = {
  name: 'serial_stop',
  description: '关闭一个持续串口会话，释放端口。给定 port（如 COM3）关闭对应的 serial-端口 会话。',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'string', description: '串口端口，如 COM3' }
    },
    required: ['port']
  },
  category: 'execute',
  execute: async (args): Promise<ToolResult> => {
    const port = String(args.port)
    const id = `serial-${port}`
    const r = closeSerial(id)
    if (!r.ok) return { ok: false, content: '', error: r.error }
    return { ok: true, content: `已关闭串口会话 ${id}。` }
  }
}

// ---------- 工具7: serial_log_tail（对齐 TrieCode serial_log 后台 buffer）----------
const serialLogTail: ToolDefinition = {
  name: 'serial_log_tail',
  description: '读取持续串口会话的后台累积日志（保留式，不清空）末尾 N 行。调试时先 serial_monitor continuous:true 打开会话，让设备输出持续积累；需要看最新输出/排查问题时用本工具取最近日志。',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'string', description: '串口端口，如 COM3。留空自动取第一个打开的会话' },
      lines: { type: 'number', description: '取末尾多少行，默认 50，最多 500' },
      clear: { type: 'boolean', description: '读取后是否清空累积日志（默认 false 保留，方便后续继续 tail/grep）' }
    },
    required: []
  },
  category: 'read',
  execute: async (args): Promise<ToolResult> => {
    let port = args.port ? String(args.port) : ''
    if (!port) {
      const sessions = listSerialSessions()
      if (sessions.length === 0) return { ok: false, content: '', error: '当前无打开的串口会话。请先 serial_monitor continuous:true 打开串口，让设备日志后台积累。' }
      port = sessions[0].id.replace(/^serial-/, '')
    }
    const id = `serial-${port}`
    const r = readSerialLog(id)
    if (!r.ok) return { ok: false, content: '', error: r.error }
    const lines = Number(args.lines) || 50
    const all = (r.data || '').split('\n').filter((l) => l.trim().length > 0)
    const tail = all.slice(-Math.min(lines, 500))
    if (args.clear === true || args.clear === 'true') clearSerialLog(id)
    if (tail.length === 0) return { ok: true, content: `串口 ${id} 累积日志为空（会话已打开，等待设备输出…）。` }
    return { ok: true, content: `串口 ${id} 后台日志末尾 ${tail.length} 行：\n${tail.join('\n')}`, data: { port, lines: tail.length } }
  }
}

// ---------- 工具8: serial_log_grep ----------
const serialLogGrep: ToolDefinition = {
  name: 'serial_log_grep',
  description: '在持续串口会话的后台累积日志中按关键词检索（保留式，不清空）。用于在海量设备日志里定位特定事件（如 error、crash、WiFi 连接、传感器读数）。',
  parameters: {
    type: 'object',
    properties: {
      port: { type: 'string', description: '串口端口，如 COM3。留空自动取第一个打开的会话' },
      pattern: { type: 'string', description: '检索关键词（大小写不敏感）' },
      lines: { type: 'number', description: '最多返回多少条匹配行，默认 30' }
    },
    required: ['pattern']
  },
  category: 'read',
  execute: async (args): Promise<ToolResult> => {
    let port = args.port ? String(args.port) : ''
    if (!port) {
      const sessions = listSerialSessions()
      if (sessions.length === 0) return { ok: false, content: '', error: '当前无打开的串口会话。请先 serial_monitor continuous:true 打开串口。' }
      port = sessions[0].id.replace(/^serial-/, '')
    }
    const id = `serial-${port}`
    const r = readSerialLog(id)
    if (!r.ok) return { ok: false, content: '', error: r.error }
    const pattern = String(args.pattern)
    if (!pattern) return { ok: false, content: '', error: 'pattern 不能为空' }
    const lines = Number(args.lines) || 30
    const hits = (r.data || '').split('\n').filter((l) => l.toLowerCase().includes(pattern.toLowerCase())).slice(-Math.min(lines, 200))
    if (hits.length === 0) return { ok: true, content: `串口 ${id} 日志中未找到包含 "${pattern}" 的行。` }
    return { ok: true, content: `串口 ${id} 日志中匹配 "${pattern}" 的 ${hits.length} 行：\n${hits.join('\n')}`, data: { port, hits: hits.length } }
  }
}

// ---------- 工具9: analyze_crash（对齐 TrieCode crash-analyzer）----------
interface CrashSignature {
  re: RegExp
  title: string
  reason: string
  advice: string
}
const CRASH_SIGNATURES: CrashSignature[] = [
  {
    re: /Guru Meditation Error:\s*Core\s*\d+\s*panic'ed\s*\(([^)]*)\)/i,
    title: 'Guru Meditation 崩溃（esp32 panic）',
    reason: 'CPU 触发了异常陷阱。括号内即 cause（LoadProhibited=非法读地址、StoreProhibited=非法写地址、IllegalInstruction=执行非法指令、DivideError=除零、InstrFetchProhibited=跳转到非法地址、Unhandled debug exception 等）。',
    advice: '对照 cause 定位：Load/StoreProhibited 多为空指针/野指针/数组越界/访问已释放内存；IllegalInstruction 多为代码段损坏或跳转到数据区；InstrFetchProhibited 多为函数指针错误。用 Backtrace 行定位到具体函数，检查对应指针与下标。'
  },
  {
    re: /Backtrace:\s*(0x[0-9a-f]+:[0-9a-fx]+[\s\S]{0,200})/i,
    title: '崩溃堆栈回溯（Backtrace）',
    reason: '设备在崩溃点输出了函数调用栈（地址:偏移 序列）。',
    advice: '把 Backtrace 每一行的地址段对照编译产物用 addr2line 转成源码行号（esp-idf 工具链自带：xtensa-esp32-elf-addr2line -pfiaC -e 固件.elf 地址1 地址2 …），定位崩溃函数后检查该函数内指针/数组/边界。'
  },
  {
    re: /assertion\s+"([^"]+)"\s+failed/i,
    title: '断言失败（assertion failed）',
    reason: `代码或框架的断言 ${'"$1"'} 不成立。`,
    advice: '断言即前置条件被违反：检查断言涉及的变量值、参数合法性、状态机顺序（如在未初始化时调用、超范围索引）。'
  },
  {
    re: /abort\(\) was called at PC/i,
    title: 'abort 主动终止',
    reason: '程序调用了 abort（多为检测到不可恢复错误、或 assert 配置为 abort）。',
    advice: '查看 abort 前的日志上下文找根因；若与 assert 配合则看断言消息；检查是否有 ESP_ERROR_CHECK 失败未处理。'
  },
  {
    re: /Task watchdog got triggered/i,
    title: '任务看门狗超时',
    reason: '某个 FreeRTOS 任务长时间没有让出 CPU（IDLE/循环里阻塞或死循环）。',
    advice: '看触发信息里的任务名：最常见是 loop() 里 delay 过长或阻塞操作（如等待串口/等待互斥锁）挤占其他任务；检查是否有 while 忙等、无限轮询、临界区过长。'
  },
  {
    re: /Stack smashing detected/i,
    title: '栈溢出/栈破坏（stack smashing）',
    reason: '检测到栈金丝雀被破坏——典型栈溢出（局部数组越界写）或递归过深。',
    advice: '检查大型局部数组（如 char buf[1024] 配合不安全的拷贝/scanf）、递归深度、深层调用链；必要时把大数组挪到全局/static 或改用堆内存。'
  },
  {
    re: /Brownout detector was triggered/i,
    title: '欠压复位（Brownout）',
    reason: '芯片供电电压掉到阈值以下触发复位（USB 供电不足、电池电量低、瞬间大电流）。',
    advice: '换稳定电源/数据线、USB 口直连；若驱动大负载（电机/舵机）需外加电容或独立供电；检查 3.3V LDO 是否够力。'
  },
  {
    re: /rst:\s*0x([0-9a-f]+)\s*\((\w+)\)/i,
    title: '复位原因（rst reason）',
    reason: `复位寄存器值 0x${'$1'}，原因 ${'$2'}（POWERON=上电、SW=软件复位、TIMEWATCHDOG/RTCWDT=看门狗、DEEPSLEEP=深度睡眠唤醒、SDIO、BROWNOUT=欠压）。`,
    advice: '按原因对号：SW 多为主动 esp_restart；TIMEWATCHDOG 查死循环/长阻塞；BROWNOUT 查供电；DEEPSLEEP 属正常唤醒。复位紧接崩溃日志时，以崩溃签名（Guru/Backtrace/assert）为主。'
  },
  {
    re: /Rebooting\.\.\./i,
    title: 'ESP32 反复重启（Rebooting 循环）',
    reason: '设备复位后重新启动，若启动后再次崩溃则形成循环（典型：启动即崩溃、看门狗触发、panic 后重启）。',
    advice: '看每次重启前的崩溃原因：若是 panic 请按 Guru/Backtrace 处理；若启动打印后无崩溃又重启，查看门狗与电源。可临时在 setup 里加延时/关功能二分定位。'
  },
  {
    re: /[Cc]an't connect to WiFi|WiFi.*(fail|error|timeout)/i,
    title: 'WiFi 连接失败',
    reason: 'ESP32 未能连上指定 WiFi（SSID/密码错误、信号弱、路由限制、AP 未就绪）。',
    advice: '核对 SSID/密码与频段（2.4G）；确认 AP 正常；检查 WiFi.begin 返回值与重连逻辑；可加连接超时与状态打印。'
  }
]

function analyzeCrashText(text: string): { title: string; reason: string; advice: string } | null {
  for (const sig of CRASH_SIGNATURES) {
    const m = text.match(sig.re)
    if (m) {
      return {
        title: sig.title,
        reason: sig.reason.replace(/\$1/g, m[1] ?? '').replace(/\$2/g, m[2] ?? ''),
        advice: sig.advice
      }
    }
  }
  return null
}

const analyzeCrash: ToolDefinition = {
  name: 'analyze_crash',
  description:
    '分析设备崩溃/异常日志（ESP32 常见故障签名）。两种输入：①text 参数直接贴崩溃日志；②不传 text 时自动读取当前打开的串口会话累积日志。' +
    '识别 Guru Meditation/Backtrace/assertion/看门狗/栈溢出/欠压/复位原因/WiFi 失败等，返回原因解释与修复建议。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '设备崩溃日志文本（可直接粘贴串口输出片段）。留空则自动读串口会话累积日志' },
      port: { type: 'string', description: 'text 留空时，从哪个串口会话读取日志（默认第一个打开的会话）' }
    },
    required: []
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    let text = String(args.text || '')
    if (!text.trim()) {
      let port = args.port ? String(args.port) : ''
      if (!port) {
        const sessions = listSerialSessions()
        if (sessions.length === 0) return { ok: false, content: '', error: 'text 为空且当前无打开的串口会话。请传入 text 或先 serial_monitor continuous:true 打开串口。' }
        port = sessions[0].id.replace(/^serial-/, '')
      }
      const r = readSerialLog(`serial-${port}`)
      if (!r.ok) return { ok: false, content: '', error: r.error }
      text = r.data || ''
    }
    if (!text.trim()) return { ok: true, content: '（日志为空，未发现崩溃痕迹）' }
    const hit = analyzeCrashText(text)
    if (!hit) {
      return { ok: true, content: '未匹配到常见 ESP32 崩溃签名（Guru Meditation/Backtrace/assert/看门狗/栈溢出/欠压/复位原因/WiFi 失败）。可把完整日志粘贴给我人工分析，或查看是否只是普通运行输出。' }
    }
    return {
      ok: true,
      content: `检测到崩溃签名：${hit.title}\n\n原因：${hit.reason}\n\n修复建议：${hit.advice}`,
      data: { signature: hit.title }
    }
  }
}

export const embeddedTools: ToolDefinition[] = [compile, upload, serialMonitor, serialSend, serialRead, serialStop, serialLogTail, serialLogGrep, analyzeCrash]
