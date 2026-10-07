/**
 * gRPC 通道自检（真实端到端，不依赖外网）。
 *
 * 做法：临时写一个 .proto，用 @grpc/grpc-js 起一个真实 server，
 * 再用 grpcBridge 的「动态 proto 反射」去调用它——验证插件只带一个 .proto 就能接上任意 gRPC 服务。
 *
 * 覆盖：
 *   - 真实一元调用成功（package.service/method 反射）
 *   - PascalCase / camelCase 方法名都能命中
 *   - 缺 addr / proto / service / method 各自的结构化报错
 *   - proto 不存在、服务不存在、方法不存在 → 明确报错（不崩溃）
 *   - 服务不可达时按 deadline 超时返回（不挂住 IDE）
 *   - resolveProtoPath 三条规则（绝对路径 / {plugin}/ / 相对 cwd）
 *
 * 用法：node scripts/check-grpc-bridge.mjs
 */
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

const req = createRequire(import.meta.url)

const outfile = 'scripts/.tmp/grpc-bridge.bundle.mjs'
buildSync({
  entryPoints: ['src/main/plugins/grpc-bridge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { grpcBridge, resolveProtoPath } = mod

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

// ── 准备：临时 proto + 真实 server ──
const dir = mkdtempSync(join(tmpdir(), 'grpcchk-'))
const protoPath = join(dir, 'hello.proto')
writeFileSync(
  protoPath,
  [
    'syntax = "proto3";',
    'package hello;',
    'service Greeter {',
    '  rpc SayHello (HelloRequest) returns (HelloReply) {}',
    '}',
    'message HelloRequest { string name = 1; }',
    'message HelloReply { string message = 1; }',
    ''
  ].join('\n')
)

const grpc = req('@grpc/grpc-js')
const protoLoader = req('@grpc/proto-loader')
const pkgDef = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})
const protoObj = grpc.loadPackageDefinition(pkgDef)

const server = new grpc.Server()
server.addService(protoObj.hello.Greeter.service, {
  SayHello: (call, cb) => cb(null, { message: 'Hello ' + call.request.name })
})
const port = await new Promise((res, rej) => {
  server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? rej(err) : res(p)))
})
server.start()
const addr = `127.0.0.1:${port}`

try {
  // ── 1. 真实调用 ──
  console.log('\n[1] 真实一元调用（动态 proto 反射）')
  const r1 = await grpcBridge.call(
    { addr, proto: protoPath, package: 'hello', service: 'Greeter', method: 'SayHello' },
    { name: 'LabCode' }
  )
  ok(r1.ok === true, `调用成功（${r1.ok ? JSON.stringify(r1.data) : r1.error}）`)
  ok(r1.data && r1.data.message === 'Hello LabCode', '返回值正确')

  // camelCase 方法名也要能命中（proto 里常写 PascalCase）
  const r2 = await grpcBridge.call(
    { addr, proto: protoPath, package: 'hello', service: 'Greeter', method: 'sayHello' },
    { name: 'Camel' }
  )
  ok(r2.ok === true && r2.data.message === 'Hello Camel', 'camelCase 方法名命中')

  // service 里直接带 package（不给 package 字段）
  const r3 = await grpcBridge.call(
    { addr, proto: protoPath, service: 'hello.Greeter', method: 'SayHello' },
    { name: 'Full' }
  )
  ok(r3.ok === true && r3.data.message === 'Hello Full', 'service 写成 hello.Greeter 也能解析')

  // ── 2. 参数校验 ──
  console.log('\n[2] 缺字段 → 结构化报错（不崩溃）')
  ok((await grpcBridge.call({ proto: protoPath, service: 'Greeter', method: 'SayHello' }, {})).error?.includes('addr'), '缺 addr 报错')
  ok((await grpcBridge.call({ addr, service: 'Greeter', method: 'SayHello' }, {})).error?.includes('proto'), '缺 proto 报错')
  ok((await grpcBridge.call({ addr, proto: protoPath, method: 'SayHello' }, {})).error?.includes('service'), '缺 service 报错')
  ok((await grpcBridge.call({ addr, proto: protoPath, service: 'Greeter' }, {})).error?.includes('method'), '缺 method 报错')

  // ── 3. 定位失败 ──
  console.log('\n[3] 目标不存在 → 明确报错')
  const noFile = await grpcBridge.call({ addr, proto: join(dir, 'nope.proto'), service: 'Greeter', method: 'SayHello' }, {})
  ok(noFile.ok === false && noFile.error.includes('找不到 proto'), `proto 文件不存在（${noFile.error}）`)
  const noSvc = await grpcBridge.call({ addr, proto: protoPath, package: 'hello', service: 'Nope', method: 'SayHello' }, {})
  ok(noSvc.ok === false && noSvc.error.includes('找不到服务'), `服务不存在（${noSvc.error}）`)
  const noMethod = await grpcBridge.call({ addr, proto: protoPath, package: 'hello', service: 'Greeter', method: 'Nope' }, {})
  ok(noMethod.ok === false && noMethod.error.includes('没有可调用方法'), `方法不存在（${noMethod.error}）`)

  // ── 4. 不可达 → deadline 超时，不挂住 ──
  console.log('\n[4] 服务不可达 → 按 deadline 返回')
  const t0 = Date.now()
  const dead = await grpcBridge.call(
    { addr: '127.0.0.1:1', proto: protoPath, package: 'hello', service: 'Greeter', method: 'SayHello', timeoutMs: 1200 },
    {}
  )
  const cost = Date.now() - t0
  ok(dead.ok === false, `不可达返回错误（${dead.error?.slice(0, 60)}）`)
  ok(cost < 10000, `未挂住（耗时 ${cost}ms，deadline 生效）`)

  // ── 5. resolveProtoPath ──
  console.log('\n[5] resolveProtoPath 路径规则')
  ok(resolveProtoPath(protoPath) === protoPath, '绝对路径原样返回')
  ok(resolveProtoPath('{plugin}/x.proto', 'demo').endsWith(join('src', 'main', 'plugins', 'demo', 'x.proto')), '{plugin}/ 解析到插件资源目录')
  ok(isAbsolute(resolveProtoPath('rel/x.proto')), '相对路径解析为绝对路径')
} finally {
  server.forceShutdown()
}

console.log('')
console.log(`[gRPC 通道自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
