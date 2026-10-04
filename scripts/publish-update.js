/**
 * 发布更新产物到更新服务器。
 *
 * 用法：
 *   node scripts/publish-update.js --to-dir "D:\\updates\\codelab"
 *   node scripts/publish-update.js --scp "root@1.2.3.4:/var/www/codelab/updates"
 *
 * 自动收集 dist/ 下的最新安装包（BlueCode-Setup-*.exe）+ latest.yml + .blockmap，
 * 复制到本地发布目录或通过系统 scp（Windows 10+ 自带 OpenSSH 客户端）上传到服务器。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const distDir = path.join(root, 'dist')

function parseArgs() {
  const a = process.argv.slice(2)
  const out = { toDir: null, scp: null }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--to-dir') out.toDir = a[i + 1]
    if (a[i] === '--scp') out.scp = a[i + 1]
  }
  return out
}

function collectArtifacts() {
  if (!fs.existsSync(distDir)) {
    console.error(`[发布] 未找到 dist 目录：${distDir}。请先运行 npm run dist 打包。`)
    process.exit(1)
  }
  const files = fs.readdirSync(distDir).filter((f) => /^BlueCode-Setup-.*\.exe(\.blockmap)?$/.test(f) || f === 'latest.yml')
  if (!files.includes('latest.yml')) {
    console.error('[发布] 未找到 latest.yml。请确认 package.json build.publish 已配置后重新打包。')
    process.exit(1)
  }
  return files.map((f) => path.join(distDir, f))
}

function copyToDir(files, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const f of files) {
    fs.copyFileSync(f, path.join(toDir, path.basename(f)))
    console.log(`[发布] 已复制 ${path.basename(f)} -> ${toDir}`)
  }
}

function scpUp(files, dest) {
  for (const f of files) {
    const r = spawnSync('scp', [f, dest], { stdio: 'inherit', shell: true })
    if (r.status !== 0) {
      console.error(`[发布] scp 上传 ${path.basename(f)} 失败（exit ${r.status}）`)
      process.exit(1)
    }
    console.log(`[发布] 已上传 ${path.basename(f)} -> ${dest}`)
  }
}

function main() {
  const args = parseArgs()
  if (!args.toDir && !args.scp) {
    console.error('用法：node scripts/publish-update.js --to-dir <本地目录> | --scp <user@host:/remote/dir>')
    process.exit(1)
  }
  const files = collectArtifacts()
  if (args.toDir) copyToDir(files, args.toDir)
  if (args.scp) scpUp(files, args.scp)
  console.log('[发布] 完成。记得把应用内更新源指向：')
  console.log('  环境变量：CODELAB_UPDATE_URL=https://你的域名/codelab')
  console.log('  或运行：  node scripts/set-update-url.js https://你的域名/codelab')
}

main()
