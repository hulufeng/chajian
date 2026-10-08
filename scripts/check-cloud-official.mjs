/**
 * 官方通道（云端）UI 接线自检 —— 防「官方账号 / 积分 / 内置模型」回归。
 *
 * 背景：用户要「加上云端功能，后台自己搭」。客户端严格照 aiGateway.ts 既有契约：
 *   POST /api/auth/login    {email,password}      -> {token,user}
 *   POST /api/auth/register {email,password}      -> {token,user}
 *   GET  /api/me            (Bearer token)        -> {user}
 * 本脚本覆盖两端：
 *   - 静态接线：preload 的 ipcRenderer.invoke('ai:login'|'ai:register'|'ai:logout'|'ai:refreshMe')
 *     必须在 main 有对应 ipcMain.handle（scan-ipc-handlers 也查，这里再锁一次具体 4 个通道）。
 *   - 网关逻辑（真实跑）：login/register/refreshAccount 把 token + 积分落地到 AiState；
 *     logout 只清账号字段，保留 BYOK profile / 本地引擎 / 模型选择（不能像 clearAiState 那样清空一切）。
 *   - 渲染层：SettingsModal 必须用到 window.api.ai.login|register|logout|refreshMe。
 *
 * 用法：node scripts/check-cloud-official.mjs
 */
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) }
}

const CHANNELS = ['ai:login', 'ai:register', 'ai:logout', 'ai:refreshMe']
const preload = readFileSync('src/preload/index.ts', 'utf-8')
const main = readFileSync('src/main/index.ts', 'utf-8')
const gateway = readFileSync('src/main/services/aiGateway.ts', 'utf-8')
const settings = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf-8')

console.log('\n=== 1. 静态接线（preload invoke ↔ main handle）===')
for (const ch of CHANNELS) {
  const inPre = preload.includes(`ipcRenderer.invoke('${ch}'`)
  const inMain = main.includes(`ipcMain.handle('${ch}'`)
  ok(inPre, `preload 暴露 ${ch}`)
  ok(inMain, `main 注册 handler ${ch}`)
  ok(inPre && inMain, `通道闭合：${ch}`)
}

console.log('\n=== 2. 网关导出（aiGateway.ts）===')
for (const fn of ['login', 'register', 'logout', 'refreshAccount', 'authLogin', 'authRegister', 'refreshMe']) {
  ok(new RegExp(`export (async )?function ${fn}\\b`).test(gateway), `导出 ${fn}`)
}

console.log('\n=== 3. 渲染层使用（SettingsModal.tsx）===')
for (const m of ['login', 'register', 'logout', 'refreshMe']) {
  ok(settings.includes(`window.api.ai.${m}`), `渲染层调用 window.api.ai.${m}`)
}

console.log('\n=== 4. 网关逻辑真跑（login/register/refresh/logout 落地 AiState）===')
// 用临时 userData，避免污染真机配置
process.env.TEST_APPDATA = mkdtempSync(join(tmpdir(), 'codelab-cloud-'))
// 桩 fetch：所有账号接口返回同一份 {token,user}
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    token: 'tok-123',
    user: { email: 'u@b.c', planCredits: 10, rechargeCredits: 5, totalCredits: 15, planMonth: '2026-12' }
  })
})

const outfile = 'scripts/.tmp/cloud-official.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/aiGateway.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: join(process.cwd(), 'scripts/stubs/electron-dom-stub.mjs') }
})
const base = process.cwd().replace(/\\/g, '/')
const mod = await import('file://' + base + '/' + outfile.replace(/\\/g, '/'))
const { login, register, logout, refreshAccount, setAiState, getAiState } = mod

// 4.1 login 落地
const s1 = await login('u@b.c', 'pw')
ok(s1.token === 'tok-123' && s1.email === 'u@b.c', 'login 把 token + email 写入状态')
ok(s1.totalCredits === 15 && s1.planMonth === '2026-12', 'login 把积分 / 套餐有效期写入状态')

// 4.2 register 落地（与 login 同结构）
const s2 = await register('u@b.c', 'pw')
ok(s2.token === 'tok-123', 'register 同样落地 token（注册即自动登录）')

// 4.3 refreshAccount 用本地 token 刷新积分
const s3 = await refreshAccount()
ok(s3.totalCredits === 15 && s3.token === 'tok-123', 'refreshAccount 刷新积分且保留 token')

// 4.4 logout 只清账号字段，保留 BYOK / 模型选择（关键：不能像 clearAiState 那样清空一切）
setAiState({
  token: 'tok-123', email: 'u@b.c', planCredits: 1, rechargeCredits: 2, totalCredits: 3, planMonth: '2026-09',
  modelId: 'byok:abc', byok: null, byokProfiles: [{ id: 'abc', name: 'DP', baseUrl: 'x', apiKey: 'k', model: 'm' }], activeByokId: 'abc'
})
const s4 = logout()
ok(s4.token === null && s4.email === null, 'logout 清空 token / email')
ok(s4.planCredits === null && s4.totalCredits === null, 'logout 清空积分字段')
ok(s4.byokProfiles.length === 1 && s4.byokProfiles[0].id === 'abc', 'logout 保留 BYOK profile（不清空）')
ok(s4.modelId === 'byok:abc' && s4.activeByokId === 'abc', 'logout 保留模型选择 / 激活 profile')
// 落盘也要一致
const persisted = getAiState()
ok(persisted.token === null && persisted.byokProfiles.length === 1 && persisted.modelId === 'byok:abc', 'logout 落盘：账号清、BYOK/模型留')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
