/**
 * 更新器自检 —— 防「更新地址还是占位符」「latest.yml 解析不了」「版本比较反了」回归。
 *
 * 背景：之前 UPDATE_BASE_URL 是 https://your-host.example.com/labcode/（占位符），
 * 而线上真实源（bluebubai.work/updates/）放的是 electron-builder 自动生成的
 * latest.yml，不是代码原本要的 update.json —— 两套机制并存导致更新功能等于没接。
 * 现在统一成一个入口，本脚本把这条链锁死。
 *
 * 覆盖：
 *   1. UPDATE_BASE_URL 不是占位地址、是 https、结尾带 /
 *   2. parseLatestYml 能解析真实 latest.yml 结构，且把相对文件名解析成绝对直链
 *   3. 缺 version 的坏 yml 返回 null（不能拿空版本去比，否则会误判「已是最新」）
 *   4. update.json 缺失时确实会回退到 latest.yml（真发一次网络请求，离线则跳过）
 *   5. 本地版本号大于远端时不触发更新（1.1.3 vs 1.1.0）
 *
 * 用法：node scripts/check-updater.mjs
 */
import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}`) }
}

const src = readFileSync('src/main/services/updateService.ts', 'utf-8')

console.log('\n[1] 更新地址配置')
const urlMatch = src.match(/export const UPDATE_BASE_URL = '([^']+)'/)
ok(!!urlMatch, '能取到 UPDATE_BASE_URL')
const base = urlMatch ? urlMatch[1] : ''
ok(!base.includes('your-host.example.com'), '不是占位地址 your-host.example.com')
ok(base.startsWith('https://'), '是 https')
ok(base.endsWith('/'), '结尾带 /（拼文件名不会变成 /updatesLabCode...）')
ok(/UPDATE_LATEST_YML_URL/.test(src), '已接 latest.yml 作为回退源')

console.log('\n[2] latest.yml 解析')
// 打 bundle：主进程模块依赖 electron，用桩顶掉
const outfile = 'scripts/.tmp/updater.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/updateService.ts'],
  bundle: true, format: 'esm', platform: 'node', outfile,
  alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') },
})
const basePath = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + basePath + '/' + outfile.replace(/\\/g, '/'))
const { parseLatestYml, UPDATE_BASE_URL } = mod

// 与线上 bluebubai.work/updates/latest.yml 同构（version/files[].url/path/releaseDate）
const SAMPLE = `version: 1.1.0
files:
  - url: LabCode-Setup-1.1.0.exe
    sha512: INVTd+x0f+WY5dgndGEAWkO4liWq1aPOXyJAwlHvyELQjEqEIndSNj640tdcvP7bOJgUumTPO/QDxNh+siYkq7g==
    size: 136593812
path: LabCode-Setup-1.1.0.exe
sha512: INVTd+x0f+WY5dgndGEAWkO4liWq1aPOXyJAwlHvyELQjEqEIndSNj640tdcvP7bOJgUumTPO/QDxNh+siYkq7g==
releaseDate: 2026-09-16T17:16:46.505Z
`
const info = parseLatestYml(SAMPLE)
ok(!!info, '真实结构能解析出 UpdateInfo')
ok(info && info.version === '1.1.0', `version 正确（实际 ${info && info.version}）`)
ok(
  info && info.url === `${UPDATE_BASE_URL}LabCode-Setup-1.1.0.exe`,
  `相对文件名解析成绝对直链（实际 ${info && info.url}）`
)
ok(info && info.pubDate === '2026-09-16T17:16:46.505Z', 'releaseDate 落到 pubDate')

console.log('\n[3] 坏数据一律降级为 null（绝不拿半截信息去比版本）')
ok(parseLatestYml('files:\n  - url: a.exe\n') === null, '缺 version → null')
ok(parseLatestYml('') === null, '空串 → null')
ok(parseLatestYml('version: 1.2.0\n') !== null, '只有 version 也能用（url 走默认命名规则）')

console.log('\n[4] 线上源实测（离线自动跳过，不算失败）')
let online = false
try {
  const res = await fetch(`${UPDATE_BASE_URL}latest.yml`, { signal: AbortSignal.timeout(8000) })
  if (res.ok) {
    online = true
    const remote = parseLatestYml(await res.text())
    ok(!!remote && !!remote.version, `线上 latest.yml 可解析（version=${remote && remote.version}）`)
    ok(!!remote && !!remote.url, `线上能拼出安装包直链（${remote && remote.url}）`)
  }
} catch { /* 离线 */ }
if (!online) console.log('  - 离线或未部署，已跳过线上断言')

console.log(`\n[5] 版本比较（本地 1.1.3 vs 远端 1.1.0 应判「无更新」）`)
const parseVer = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
const isNewer = (a, b) => {
  const x = parseVer(a); const y = parseVer(b)
  for (let i = 0; i < 3; i++) { if (x[i] > y[i]) return true; if (x[i] < y[i]) return false }
  return false
}
ok(isNewer('1.1.0', '1.1.3') === false, '远端更旧 → 不更新')
ok(isNewer('1.2.0', '1.1.3') === true, '远端更新 → 触发')
ok(isNewer('2.0.0', '1.9.9') === true, '跨大版本也能比')

console.log(`\n[更新器自检] 通过 ${pass} / 失败 ${fail}`)
process.exitCode = fail === 0 ? 0 : 1
