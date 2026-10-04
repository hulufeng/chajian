/**
 * 设置应用内更新源地址（写入用户数据目录 settings.json，无需重新打包）。
 *
 * 用法：
 *   node scripts/set-update-url.js https://your-domain.com/codelab
 *   node scripts/set-update-url.js --reset
 *
 * 说明：写入的 updateUrl 会被打包版 CodeLab 在「检查更新」时优先读取（优先级：
 * 环境变量 CODELAB_UPDATE_URL > settings.json updateUrl > package.json build.publish.url）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 与 Electron app.getPath('userData') 对齐（Windows）
const userData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'codelab-desktop')
  : path.join(os.homedir(), '.config', 'codelab-desktop')

function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('用法：node scripts/set-update-url.js <url> | --reset')
    process.exit(1)
  }
  const settingsFile = path.join(userData, 'settings.json')
  const cur = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {}
  if (arg === '--reset') {
    delete cur.updateUrl
  } else {
    cur.updateUrl = arg
  }
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(cur, null, 2), 'utf-8')
  console.log(`[更新源] 已写入 ${settingsFile}`)
  console.log(`[更新源] 当前 updateUrl = ${cur.updateUrl ?? '（未设置）'}`)
}

main()
