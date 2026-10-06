/**
 * 打包后自检：工具链内置 Web UI（平台管理 / 库管理 / 设置）的页面到底在不在包里、
 * 主进程能不能拼出 file:// URL。
 *
 * 起因：这几个页面打包后「必然」打不开 —— 渲染层拼了 process.resourcesPath（渲染层根本没 process），
 * 打包目录名还写错，最后整个左侧栏白屏。修完之后这类回归必须能被自动抓到，
 * 不能每次都靠人肉打开安装包点三下 tab。
 *
 * 用法：node scripts/check-ui-assets.mjs <安装包目录>
 *   例：node scripts/check-ui-assets.mjs pkgout19
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { listPackage } from '@electron/asar'

/**
 * 踩过的：@electron/asar 根本没导出 getFilesystemSync（Object.keys 里只有
 * listPackage / extractFile / statFile 等），之前 destructuring 出来是 undefined，
 * 兜底分支每次静默 catch 成 null，等于「只认磁盘文件、查不出 asar 内的文件」还以为自己查了。
 * 正确入口是 listPackage，且它返回的路径**带前导斜杠**（/node_modules/...、/out/main/index.js），
 * 用之前忘了前导斜杠会一个都匹配不上。
 */
function listAsarFiles(asarPath) {
  try {
    return new Set(listPackage(asarPath).map((f) => String(f).replaceAll('\\', '/')))
  } catch {
    return null
  }
}

const pkgDir = process.argv[2]
if (!pkgDir) {
  console.error('用法：node scripts/check-ui-assets.mjs <安装包目录>')
  process.exit(1)
}

const asarPath = join(pkgDir, 'win-unpacked', 'resources', 'app.asar')
if (!existsSync(asarPath)) {
  console.error(`找不到 ${asarPath}\n        先跑 electron-builder（--dir 也行）。`)
  process.exit(1)
}

/** 与 src/main/index.ts 的 'toolchain:ui-url' handler 保持同一套候选（顺序也一致） */
const rel = join('plugins', 'arduino-toolchain', 'ui')
const R = join(pkgDir, 'win-unpacked', 'resources')
const roots = process.argv[3] === 'dev'
  ? [join(process.cwd(), 'out', 'main')]
  : [
      // asarUnpack 解包的落盘位置，打包后唯一能 existsSync 判存成功的根
      join(R, 'app.asar.unpacked', 'out', 'main'),
      join(R, 'app.asar', 'out', 'main'),
      join(R, 'out', 'main'),
    ]

const TABS = ['platforms', 'libraries', 'settings']
let fail = 0
// asar 是单个文件，existsSync 看不见里面；判存时先找磁盘，找不到再问 asar 的文件表
const asarFiles = process.argv[3] === 'dev' ? null : listAsarFiles(asarPath)

/** 包内某文件在不在：先找磁盘真实文件，找不到再问 asar 的文件表 */
function inPackage(absPath, key) {
  if (existsSync(absPath)) return true
  return !!(asarFiles && asarFiles.has(`/${key}`))
}

for (const tab of TABS) {
  const file = join(rel, `${tab}.html`)
  const hit = roots.map((r) => join(r, file)).find((p) => existsSync(p))
  if (!inPackage(hit ?? '', `out/${file.replace(/\\/g, '/')}`)) {
    console.log(`✗ ${tab}.html  包里找不到（候选根：${roots.join(' , ')}）`)
    fail++
    continue
  }
  if (hit) {
    console.log(`✓ ${tab}.html  落盘 → file:///${hit.replace(/\\/g, '/')}`)
  } else {
    console.log(`△ ${tab}.html  仅在 app.asar 内（existsSync 看不见）—— file:// iframe 大概率加载不了`)
    fail++
  }
}

if (fail > 0) {
  console.error(`\n[check-ui-assets] ${fail} 个内置页面缺失，左侧栏对应 tab 会显示「页面未随安装包分发」。`)
  process.exit(1)
}
console.log('\n[check-ui-assets] 三个内置页面均在包内，URL 可拼。')
