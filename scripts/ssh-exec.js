/** 通过 SSH 在 ECS 上执行命令（密码登录） */
const { Client } = require('ssh2')

const HOST = process.argv[2] || '47.104.13.59'
const USER = process.argv[3] || 'root'
const PASS = process.argv[4] || 'Codelab#2026!Upd'
const CMD = process.argv.slice(5).join(' ') || 'whoami; uname -a; cat /etc/os-release | head -3'

const conn = new Client()
conn
  .on('ready', () => {
    console.log(`[SSH] 已连接 ${USER}@${HOST}`)
    conn.exec(CMD, (err, stream) => {
      if (err) {
        console.error('[SSH] exec 错误:', err.message)
        conn.end()
        process.exit(1)
      }
      stream.on('close', (code) => {
        console.log(`[SSH] 命令退出码: ${code}`)
        conn.end()
        process.exit(code || 0)
      })
      stream.on('data', (d) => process.stdout.write(d))
      stream.stderr.on('data', (d) => process.stderr.write(d))
    })
  })
  .on('error', (err) => {
    console.error('[SSH] 连接失败:', err.message)
    process.exit(1)
  })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 30000 })
