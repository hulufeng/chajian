/**
 * MQTT 桥接运行时（差异化通道）。
 *
 * 作用：把「设备串口流」与「MQTT 主题」互转，让 ESP32 等硬件既能发数据上云、
 * 也能被远端指令驱动——这是相对 TrieCode 的差异化能力，原生支持物联网场景。
 *
 * 设计要点：
 *  - 依赖可选的 npm 包 `mqtt`；未安装时所有操作返回结构化错误，不崩溃、不静默。
 *  - 用变量名拼装包名（`'mq' + 'tt'`）避免打包器在构建期静态解析一个未安装的依赖，
 *    保证主构建与自检脚本都不会因为没装 mqtt 而失败；真正需要时才在运行时 require。
 *  - 同步接口 + 事件回调，便于宿主 UI / Agent 接入；connect 失败明确报错。
 */
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
// 非字面量包名，避免 esbuild 在打包期尝试解析未安装的 mqtt
const MQTT_PKG = 'mq' + 'tt'

export interface MqttServerSpec {
  name: string
  url: string
  username?: string
  password?: string
  clientId?: string
  topics?: string[]
}

export interface MqttOpResult {
  ok: boolean
  error?: string
  detail?: unknown
}

type MqttClient = {
  publish: (topic: string, payload: string, opts?: Record<string, unknown>) => void
  subscribe: (topic: string) => void
  unsubscribe: (topic: string) => void
  on: (event: string, cb: (...args: unknown[]) => void) => void
  end: (force?: boolean) => void
}

class MqttBridge extends EventEmitter {
  private clients = new Map<string, MqttClient>()
  private available: boolean | null = null

  /** 运行时探测 mqtt 包是否可用 */
  isAvailable(): boolean {
    if (this.available !== null) return this.available
    try {
      req(MQTT_PKG)
      this.available = true
    } catch {
      this.available = false
    }
    return this.available
  }

  /** 连接到声明的 MQTT 服务器（按 manifest mqttServers[].name 寻址） */
  connect(spec: MqttServerSpec): MqttOpResult {
    if (!this.isAvailable()) {
      return { ok: false, error: '未安装 mqtt 依赖（请 npm i mqtt 后在宿主启用 MQTT 通道）' }
    }
    if (this.clients.has(spec.name)) return { ok: true, detail: '已连接' }
    try {
      const mqtt = req(MQTT_PKG) as {
        connect: (url: string, opts: Record<string, unknown>) => MqttClient
      }
      const client = mqtt.connect(spec.url, {
        username: spec.username,
        password: spec.password,
        clientId: spec.clientId || `codelab-${spec.name}-${Date.now()}`,
        rejectUnauthorized: false,
      })
      client.on('error', (...args: unknown[]) =>
        this.emit('error', { server: spec.name, error: String(args[0]) })
      )
      this.clients.set(spec.name, client)
      return { ok: true, detail: '连接中' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 发布到主题 */
  publish(server: string, topic: string, payload: string): MqttOpResult {
    const client = this.clients.get(server) as MqttClient | undefined
    if (!client) return { ok: false, error: `MQTT 服务器未连接：${server}（请先 connect）` }
    try {
      client.publish(topic, payload)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 订阅主题，消息经回调吐出 */
  subscribe(server: string, topic: string, onMessage: (topic: string, payload: string) => void): MqttOpResult {
    const client = this.clients.get(server) as MqttClient | undefined
    if (!client) return { ok: false, error: `MQTT 服务器未连接：${server}（请先 connect）` }
    try {
      client.subscribe(topic)
      client.on('message', (...args: unknown[]) => {
        const t = args[0] as string
        const m = args[1] as Buffer
        if (t === topic) onMessage(t, m.toString())
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 断开某个服务器连接 */
  disconnect(server: string): MqttOpResult {
    const client = this.clients.get(server) as MqttClient | undefined
    if (!client) return { ok: true, detail: '本就未连接' }
    try {
      client.end(true)
      this.clients.delete(server)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 是否某个服务器已连 */
  isConnected(server: string): boolean {
    return this.clients.has(server)
  }
}

export const mqttBridge = new MqttBridge()
