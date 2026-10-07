import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * gRPC 通道桥接：manifest 里 transport=grpc 的工具由这里真实执行。
 *
 * 自研设计要点（不引用任何第三方插件实现，仅使用官方 npm 依赖 @grpc/grpc-js / @grpc/proto-loader）：
 *   1. 动态反射：运行时加载插件自带的 .proto，按 package.service/method 直接调用，
 *      不必为每个服务预生成桩代码——插件带一个 .proto 就能接上任意 gRPC 服务。
 *   2. 两级缓存：proto 定义按路径缓存（proto 解析较重），客户端按 addr+service 缓存（复用连接）。
 *   3. deadline 超时：一元 RPC 一律带 deadline，服务端不响应时返回结构化错误，绝不挂住 IDE。
 *   4. 缺依赖降级：未装 gRPC 依赖时返回结构化错误，不抛异常、不崩溃。
 */

const req = createRequire(import.meta.url)
// 非字面量拼接：让打包器无法在构建期静态解析（gRPC 属可选能力，未安装也要能构建）
const GRPC_PKG = '@grpc/' + 'grpc-js'
const PROTO_PKG = '@grpc/' + 'proto-loader'

export interface GrpcCallSpec {
  /** 服务端地址，如 127.0.0.1:50051 */
  addr?: string
  /** .proto 文件路径，支持 {plugin}/x.proto */
  proto?: string
  /** proto package 名（可选：也可把 package 写进 service） */
  package?: string
  service?: string
  method?: string
  timeoutMs?: number
  /** 是否走 TLS，默认明文 */
  tls?: boolean
}

export interface GrpcCallResult {
  ok: boolean
  data?: unknown
  error?: string
  /** gRPC 状态码（错误时才有） */
  code?: number
}

export const DEFAULT_GRPC_TIMEOUT_MS = 15000

type AnyRec = Record<string, any>

function loadGrpcDeps(): { grpc: AnyRec; protoLoader: AnyRec } | null {
  try {
    return { grpc: req(GRPC_PKG), protoLoader: req(PROTO_PKG) }
  } catch {
    return null
  }
}

/**
 * proto 路径解析（三条规则，与插件侧 ctx.resolve 同一口径）：
 *   1. 绝对路径 → 直接用
 *   2. {plugin}/x.proto → 插件资源目录 cwd/src/main/plugins/<插件名>/
 *   3. 其余 → 相对 cwd
 */
export function resolveProtoPath(proto: string, pluginName?: string): string {
  if (isAbsolute(proto)) return proto
  const PREFIX = '{plugin}/'
  if (proto.startsWith(PREFIX)) {
    const rest = proto.slice(PREFIX.length)
    const base = pluginName ? join(process.cwd(), 'src', 'main', 'plugins', pluginName) : process.cwd()
    return join(base, rest)
  }
  return resolve(process.cwd(), proto)
}

class GrpcBridge {
  /** protoPath → packageDefinition */
  private defs = new Map<string, unknown>()
  /** 缓存 key → 已建客户端 */
  private clients = new Map<string, AnyRec>()

  /** gRPC 依赖是否可用（插件市场可据此提示"该能力需安装依赖"） */
  isAvailable(): boolean {
    return loadGrpcDeps() !== null
  }

  /** 关闭全部客户端（插件热加载/卸载时调用，避免残留连接） */
  closeAll(): void {
    for (const [, c] of this.clients) {
      try {
        if (typeof c.close === 'function') c.close()
      } catch {
        /* 关闭失败不影响主流程 */
      }
    }
    this.clients.clear()
  }

  /** 一元 RPC 调用（payload 即 proto 里该方法的请求消息体） */
  async call(
    spec: GrpcCallSpec,
    payload: Record<string, unknown>,
    pluginName?: string
  ): Promise<GrpcCallResult> {
    if (!spec || !spec.addr) {
      return { ok: false, error: 'gRPC 工具缺少 grpc.addr（服务端地址，如 127.0.0.1:50051）' }
    }
    if (!spec.service) return { ok: false, error: 'gRPC 工具缺少 grpc.service（服务名）' }
    if (!spec.method) return { ok: false, error: 'gRPC 工具缺少 grpc.method（方法名）' }
    if (!spec.proto) {
      return { ok: false, error: 'gRPC 工具缺少 grpc.proto（.proto 文件路径，支持 {plugin}/x.proto）' }
    }

    const deps = loadGrpcDeps()
    if (!deps) {
      return { ok: false, error: '未安装 gRPC 依赖（@grpc/grpc-js + @grpc/proto-loader），gRPC 通道不可用' }
    }

    const protoPath = resolveProtoPath(spec.proto, pluginName)
    if (!existsSync(protoPath)) return { ok: false, error: `找不到 proto 文件: ${protoPath}` }

    let pkgDef = this.defs.get(protoPath)
    if (!pkgDef) {
      try {
        pkgDef = deps.protoLoader.loadSync(protoPath, {
          keepCase: false,
          longs: String,
          enums: String,
          defaults: true,
          oneofs: true
        })
        this.defs.set(protoPath, pkgDef)
      } catch (e) {
        return { ok: false, error: `proto 解析失败 ${protoPath}: ${(e as Error).message}` }
      }
    }

    const grpcObj = deps.grpc.loadPackageDefinition(pkgDef) as AnyRec
    const fullService = spec.package ? `${spec.package}.${spec.service}` : (spec.service as string)
    let ServiceCtor: any = grpcObj
    for (const part of fullService.split('.').filter(Boolean)) {
      ServiceCtor = ServiceCtor?.[part]
      if (!ServiceCtor) return { ok: false, error: `proto ${protoPath} 中找不到服务: ${fullService}` }
    }

    const cacheKey = [spec.addr, protoPath, fullService, spec.tls ? 'tls' : 'plain'].join('|')
    let client = this.clients.get(cacheKey)
    if (!client) {
      const creds = spec.tls ? deps.grpc.credentials.createSsl() : deps.grpc.credentials.createInsecure()
      client = new ServiceCtor(spec.addr, creds) as AnyRec
      this.clients.set(cacheKey, client)
    }

    // 收窄成非空常量再进闭包：直接捕获 let 变量会让 TS 失去非空判断
    const c: AnyRec = client as AnyRec

    // 方法名兼容：proto 里习惯写 PascalCase，而 proto-loader(keepCase:false) 生成 camelCase，两边都命中
    const m = spec.method as string
    const fn: any = c[m] || c[m.charAt(0).toLowerCase() + m.slice(1)]
    if (typeof fn !== 'function') {
      return { ok: false, error: `服务 ${fullService} 上没有可调用方法: ${m}` }
    }

    const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : DEFAULT_GRPC_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    const MetaCtor = deps.grpc.Metadata
    const meta = typeof MetaCtor === 'function' ? new MetaCtor() : undefined

    return await new Promise<GrpcCallResult>((res) => {
      try {
        fn.call(c, payload, meta, { deadline }, (err: any, resp: unknown) => {
          if (err) {
            res({
              ok: false,
              error: err.message || String(err),
              code: typeof err.code === 'number' ? err.code : undefined
            })
          } else {
            res({ ok: true, data: resp })
          }
        })
      } catch (e) {
        res({ ok: false, error: `gRPC 调用异常: ${(e as Error).message}` })
      }
    })
  }
}

export const grpcBridge = new GrpcBridge()
