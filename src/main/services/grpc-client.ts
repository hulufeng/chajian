// Arduino CLI gRPC Client
// 对齐 TrieCode gRPC 层：arduino-cli daemon 模式 + gRPC 通信
// daemon 启动 → 端口检测 → gRPC 连接 → 编译/烧录/板卡/库 调用
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

const WIN = process.platform === 'win32'
const EXE = WIN ? 'arduino-cli.exe' : 'arduino-cli'

// Proto 路径（开发模式从项目根目录，打包后从 resources）
function protoDir(): string {
  // 开发模式：项目根目录/proto（electron-vite 打包后 __dirname=out/main）
  const devPath = join(process.cwd(), 'proto')
  if (existsSync(devPath)) return devPath
  // 尝试 __dirname 上溯
  const altPath = resolve(__dirname, '..', '..', 'proto')
  if (existsSync(altPath)) return altPath
  // 打包后：resources/proto
  const prodPath = join(process.resourcesPath || '', 'proto')
  if (existsSync(prodPath)) return prodPath
  return devPath // fallback
}

const PROTO_FILE = join(protoDir(), 'cc', 'arduino', 'cli', 'commands', 'v1', 'commands.proto')

export interface GrpcClientState {
  connected: boolean
  port: number | null
  daemonPid: number | null
  error: string | null
}

export interface CompileResult {
  success: boolean
  output: string
  error?: string
  buildPath?: string
}

export interface BoardInfo {
  fqbn: string
  name: string
  platform?: string
}

export interface LibraryInfo {
  name: string
  version: string
  author?: string
  sentence?: string
}

export interface PlatformInfo {
  id: string
  version: string
  name?: string
}

export interface CompileProgress {
  percent: number
  message: string
}

class ArduinoGrpcClient {
  private daemon: ChildProcess | null = null
  private client: any = null
  private port: number | null = null
  private packageDefinition: any = null
  private protoDescriptor: any = null
  private instance: any = null
  private state: GrpcClientState = { connected: false, port: null, daemonPid: null, error: null }

  getState(): GrpcClientState {
    return { ...this.state }
  }

  /** 启动 arduino-cli daemon 并建立 gRPC 连接 */
  async start(binPath?: string): Promise<GrpcClientState> {
    if (this.state.connected && this.client && this.instance) {
      return this.state
    }

    const bin = binPath || this.findBin()
    if (!bin) {
      this.state.error = '未找到 arduino-cli'
      return this.state
    }

    try {
      // 加载 proto
      if (!this.packageDefinition) {
        this.packageDefinition = protoLoader.loadSync(PROTO_FILE, {
          keepCase: true,
          longs: String,
          enums: String,
          defaults: true,
          oneofs: true,
          includeDirs: [protoDir()]
        })
        this.protoDescriptor = grpc.loadPackageDefinition(this.packageDefinition)
      }

      // 启动 daemon（随机端口）
      const port = await this.startDaemon(bin)
      this.port = port

      // 建立 gRPC 连接
      const cc = this.protoDescriptor.cc.arduino.cli.commands.v1
      this.client = new cc.ArduinoCoreService(
        `localhost:${port}`,
        grpc.credentials.createInsecure(),
        {
          'grpc.max_receive_message_length': 16 * 1024 * 1024, // 16MB，对齐 TrieCode
          'grpc.max_send_message_length': 16 * 1024 * 1024
        }
      )

      // 建立 gRPC 连接（instance 初始化加超时防护：若 50051 被其他程序占用导致
      // socket 探测误判"连接成功"，或 daemon 假死，8 秒内快速失败 → 调用方降级 CLI 直编，
      // 避免 Compile 对着错误端口永久挂起、界面无任何输出）
      this.instance = await Promise.race([
        this.createInstance(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('gRPC instance 初始化超时（8 秒），可能端口被占用或 daemon 假死')), 8000)
        )
      ])
      // instance 为空对象说明 Create/Init 失败，同样视为连接失败以便降级
      if (!this.instance || !this.instance.number) {
        throw new Error('gRPC instance 初始化失败（Create/Init 未返回有效 instance）')
      }
      this.state = { connected: true, port, daemonPid: this.daemon?.pid || null, error: null }
      console.log(`[gRPC] arduino-cli daemon 已连接，端口 ${port}，PID ${this.daemon?.pid}`)
      return this.state
    } catch (e) {
      this.state.error = (e as Error).message
      console.error(`[gRPC] 启动失败: ${this.state.error}`)
      return this.state
    }
  }

  /** 停止 daemon 和 gRPC 连接 */
  stop(): void {
    if (this.client) {
      try { this.client.close() } catch { /* 忽略 */ }
      this.client = null
    }
    if (this.daemon) {
      try { this.daemon.kill() } catch { /* 忽略 */ }
      this.daemon = null
    }
    this.state = { connected: false, port: null, daemonPid: null, error: null }
  }

  /** 启动 daemon 进程，解析端口号 */
  private startDaemon(bin: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('arduino-cli daemon 启动超时（10秒）'))
      }, 10000)

      // Windows 上 arduino-cli daemon 需要真实控制台（stdio: 'inherit'），
      // 重定向到管道会导致进程立即退出。使用固定端口避免解析输出。
      const port = 50051
      this.daemon = spawn(bin, ['daemon', '--port', String(port)], {
        stdio: 'inherit',
        windowsHide: false
      })

      let resolved = false
      const checkPort = setInterval(() => {
        // 检查端口是否在监听
        const net = require('node:net')
        const socket = new net.Socket()
        socket.setTimeout(500)
        socket.on('connect', () => {
          socket.destroy()
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkPort)
            resolve(port)
          }
        })
        socket.on('error', () => { socket.destroy() })
        socket.on('timeout', () => { socket.destroy() })
        socket.connect(port, '127.0.0.1')
      }, 300)

      this.daemon.on('error', (err) => {
        if (!resolved) {
          clearTimeout(timeout)
          clearInterval(checkPort)
          reject(new Error(`daemon 进程错误: ${err.message}`))
        }
      })

      this.daemon.on('exit', (code) => {
        if (!resolved && code !== 0) {
          clearTimeout(timeout)
          clearInterval(checkPort)
          reject(new Error(`daemon 异常退出，码 ${code}`))
        }
      })
    })
  }

  private findBin(): string | null {
    const candidates = [
      EXE,
      join(process.env.APPDATA || '', 'codelab-desktop', 'tools', 'arduino-cli', EXE),
      join('C:', 'Program Files', 'Arduino CLI', EXE),
      join('C:', 'Program Files (x86)', 'Arduino', EXE),
    ]
    for (const c of candidates) {
      if (c === EXE) {
        try {
          const { spawnSync } = require('node:child_process')
          const r = spawnSync(EXE, ['version'], { encoding: 'utf-8', timeout: 3000 })
          if (r.status === 0) return EXE
        } catch { /* 继续 */ }
      } else if (existsSync(c)) {
        return c
      }
    }
    return null
  }

  // ── 核心 gRPC 方法 ──────────────────────────────────────

  /** 编译（server-streaming） */
  async compile(
    sketch: string,
    fqbn: string,
    onOutput?: (line: string) => void,
    onProgress?: (p: CompileProgress) => void
  ): Promise<CompileResult> {
    if (!this.client) return { success: false, output: '', error: 'gRPC 未连接' }

    return new Promise((resolve) => {
      const call = this.client.Compile({
        instance: this.instance || {},
        sketch_path: sketch,
        fqbn,
        warnings: 'all',
        optimize_for_debug: false,
        verbose: true
      })

      let output = ''
      let buildPath = ''

      call.on('data', (resp: any) => {
        if (resp.out_stream) {
          const line = Buffer.from(resp.out_stream).toString()
          output += line
          onOutput?.(line)
        }
        if (resp.err_stream) { const line = Buffer.from(resp.err_stream).toString(); output += line; onOutput?.(line) }
        if (resp.progress && resp.progress.percent > 0) { onProgress?.({ percent: resp.progress.percent, message: resp.progress.message || resp.progress.name || '' }) }
        if (resp.build_path) {
          buildPath = resp.build_path
        }
      })

      call.on('error', (err: any) => {
        console.error('[gRPC] Compile 错误:', err?.message || err, '| output:', output.substring(0, 300))
        resolve({ success: false, output, error: err?.message || '编译失败' })
      })

      call.on('end', () => {
        console.log('[gRPC] Compile 完成, output 长度:', output.length, 'buildPath:', buildPath)
        resolve({ success: true, output, buildPath })
      })
    })
  }

  /** 烧录（server-streaming） */
  async upload(
    sketch: string,
    fqbn: string,
    port: string,
    onOutput?: (line: string) => void,
    onProgress?: (p: CompileProgress) => void
  ): Promise<CompileResult> {
    if (!this.client) return { success: false, output: '', error: 'gRPC 未连接' }

    return new Promise((resolve) => {
      const call = this.client.Upload({
        instance: this.instance || {},
        sketch_path: sketch,
        fqbn,
        port,
        verify: true
      })

      let output = ''

      call.on('data', (resp: any) => {
        if (resp.out_stream) {
          const line = Buffer.from(resp.out_stream).toString()
          output += line
          onOutput?.(line)
        }
      })

      call.on('error', (err: any) => {
        resolve({ success: false, output, error: err?.message || '烧录失败' })
      })

      call.on('end', () => {
        resolve({ success: true, output })
      })
    })
  }

  /** 列出所有开发板 */
  async boardListAll(): Promise<BoardInfo[]> {
    if (!this.client) return []
    return new Promise((resolve) => {
      this.client.BoardListAll({ instance: this.instance || {} }, (err: any, resp: any) => {
        if (err) { resolve([]); return }
        const boards = resp?.boards || []
        resolve(boards.map((b: any) => ({
          fqbn: b.fqbn || b.id || '',
          name: b.name || '',
          platform: b.platform?.name || b.platform?.id
        })).filter((b: BoardInfo) => b.fqbn))
      })
    })
  }

  /** 列出连接的开发板 */
  async boardList(): Promise<Array<{ fqbn: string; name: string; port: string }>> {
    if (!this.client) return []
    return new Promise((resolve) => {
      this.client.BoardList({ instance: this.instance || {}, timeout: 5 }, (err: any, resp: any) => {
        if (err) { resolve([]); return }
        const ports = resp?.ports || []
        resolve(ports.map((p: any) => ({
          fqbn: p.matching_boards?.[0]?.fqbn || '',
          name: p.matching_boards?.[0]?.name || '',
          port: p.address?.address || p.address || ''
        })).filter((b: { port: string }) => b.port))
      })
    })
  }

  /** 开发板详情（配置选项） */
  async boardDetails(fqbn: string): Promise<{ fqbn: string; name: string; options: Array<{ option: string; label: string; values: Array<{ value: string; label: string }> }> }> {
    if (!this.client) return { fqbn, name: fqbn, options: [] }
    return new Promise((resolve) => {
      this.client.BoardDetails({ instance: this.instance || {}, fqbn }, (err: any, resp: any) => {
        if (err) { resolve({ fqbn, name: fqbn, options: [] }); return }
        const opts = resp?.config_options || []
        resolve({
          fqbn: resp?.fqbn || fqbn,
          name: resp?.name || fqbn,
          options: opts.map((o: any) => ({
            option: o.option || '',
            label: o.option_label || o.option || '',
            values: (o.values || []).map((v: any) => ({
              value: v.value || '',
              label: v.value_label || v.value || ''
            }))
          }))
        })
      })
    })
  }

  /** 搜索库 */
  async libSearch(keyword: string): Promise<LibraryInfo[]> {
    if (!this.client) return []
    return new Promise((resolve) => {
      this.client.LibrarySearch({ instance: this.instance || {}, query: keyword }, (err: any, resp: any) => {
        if (err) { resolve([]); return }
        const libs = resp?.libraries || []
        resolve(libs.map((l: any) => ({
          name: l.name || '',
          version: l.latest_version?.version || '',
          author: l.author || '',
          sentence: l.sentence || ''
        })).filter((l: LibraryInfo) => l.name))
      })
    })
  }

  /** 列出已安装库 */
  async libList(): Promise<LibraryInfo[]> {
    if (!this.client) return []
    return new Promise((resolve) => {
      this.client.LibraryList({ instance: this.instance || {} }, (err: any, resp: any) => {
        if (err) { resolve([]); return }
        const libs = resp?.installed_libraries || []
        resolve(libs.map((l: any) => ({
          name: l.library?.name || '',
          version: l.library?.version || '',
          author: l.library?.author || '',
          sentence: l.library?.sentence || ''
        })).filter((l: LibraryInfo) => l.name))
      })
    })
  }

  /** 安装库（server-streaming） */
  async libInstall(name: string, version?: string, onOutput?: (line: string) => void): Promise<boolean> {
    if (!this.client) return false
    return new Promise((resolve) => {
      const call = this.client.LibraryInstall({
        instance: this.instance || {},
        name,
        version: version || '',
        skip_post_install: false
      })
      call.on('data', (resp: any) => {
        if (resp.message) onOutput?.(resp.message)
        if (resp.progress) onOutput?.(`进度: ${resp.progress}%`)
      })
      call.on('error', () => resolve(false))
      call.on('end', () => resolve(true))
    })
  }

  /** 卸载库 */
  async libUninstall(name: string): Promise<boolean> {
    if (!this.client) return false
    return new Promise((resolve) => {
      this.client.LibraryUninstall({ instance: this.instance || {}, name }, (err: any) => {
        resolve(!err)
      })
    })
  }

  /** 列出已安装平台 */
  async coreList(): Promise<PlatformInfo[]> {
    if (!this.client) return []
    return new Promise((resolve) => {
      this.client.CoreList({ instance: this.instance || {} }, (err: any, resp: any) => {
        if (err) { resolve([]); return }
        const platforms = resp?.installed_platforms || []
        resolve(platforms.map((p: any) => ({
          id: p.id || '',
          version: p.installed || '',
          name: p.name || ''
        })).filter((p: PlatformInfo) => p.id))
      })
    })
  }

  /** 搜索平台 */
  async coreSearch(keyword: string): Promise<PlatformInfo[]> {
    if (!this.client) return []
    return new Promise((resolve) => {
      this.client.CoreSearch({ instance: this.instance || {}, query: keyword }, (err: any, resp: any) => {
        if (err) { resolve([]); return }
        const platforms = resp?.platforms || []
        resolve(platforms.map((p: any) => ({
          id: p.id || '',
          version: p.latest || '',
          name: p.name || ''
        })).filter((p: PlatformInfo) => p.id))
      })
    })
  }

  /** 安装平台（server-streaming） */
  async coreInstall(platform: string, version?: string, onOutput?: (line: string) => void): Promise<boolean> {
    if (!this.client) return false
    return new Promise((resolve) => {
      const call = this.client.CoreInstall({
        instance: this.instance || {},
        platform: platform + (version ? `@${version}` : '')
      })
      call.on('data', (resp: any) => {
        if (resp.message) onOutput?.(resp.message)
        if (resp.progress) onOutput?.(`进度: ${resp.progress}%`)
      })
      call.on('error', () => resolve(false))
      call.on('end', () => resolve(true))
    })
  }

  /** 卸载平台 */
  async coreUninstall(platform: string): Promise<boolean> {
    if (!this.client) return false
    return new Promise((resolve) => {
      this.client.CoreUninstall({ instance: this.instance || {}, platform }, (err: any) => {
        resolve(!err)
      })
    })
  }

  /** 创建 instance（arduino-cli gRPC 需要 instance 对象） */
  private createInstance(): Promise<any> {
    return new Promise((resolve) => {
      if (!this.client) { resolve({}); return }
      try {
        // 1. Create 创建空 instance
        this.client.Create({}, (err: any, resp: any) => {
          if (err) {
            console.error('[gRPC] Create instance 失败:', err?.message || err)
            resolve({})
            return
          }
          const inst = resp?.instance || {}
          console.log('[gRPC] Create instance 成功:', JSON.stringify(inst).substring(0, 100))

          // 2. Init 初始化 instance（加载平台/库索引）
          const initCall = this.client.Init({ instance: inst })
          let initError: any = null
          initCall.on('data', (r: any) => {
            if (r?.error) {
              initError = r.error
              console.error('[gRPC] Init 错误:', r.error?.message || r.error)
            }
            if (r?.init_progress?.task_progress?.name) {
              console.log('[gRPC] Init 进度:', r.init_progress.task_progress.name)
            }
          })
          initCall.on('error', (e: any) => {
            console.error('[gRPC] Init 调用失败:', e?.message || e)
            resolve(inst) // Init 失败仍返回 instance，让后续 Compile 尝试
          })
          initCall.on('end', () => {
            if (initError) {
              console.error('[gRPC] Init 完成但有错误')
            } else {
              console.log('[gRPC] Init 完成，instance 已就绪')
            }
            resolve(inst)
          })
        })
      } catch (e) {
        console.error('[gRPC] Create instance 异常:', (e as Error).message)
        resolve({})
      }
    })
  }
}

export const arduinoGrpc = new ArduinoGrpcClient()
