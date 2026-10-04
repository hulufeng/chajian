/** SFTP 上传文件到 ECS */
const { Client } = require('ssh2')
const fs = require('node:fs')
const path = require('node:path')

const HOST = process.argv[2] || '47.104.13.59'
const USER = process.argv[3] || 'root'
const PASS = process.argv[4] || 'Codelab#2026!Upd'
const LOCAL = process.argv[5]
const REMOTE = process.argv[6]

if (!LOCAL || !REMOTE) {
  console.error('用法: node scripts/sftp-upload.js <host> <user> <pass> <本地文件> <远端路径>')
  process.exit(1)
}

const conn = new Client()
conn
  .on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) {
        console.error('[SFTP] sftp 初始化失败:', err.message)
        conn.end()
        process.exit(1)
      }
      const size = fs.statSync(LOCAL).size
      let sent = 0
      const start = Date.now()
      sftp.fastPut(LOCAL, REMOTE, (e) => {
        if (e) {
          console.error('[SFTP] 上传失败:', e.message)
          conn.end()
          process.exit(1)
        }
        const sec = ((Date.now() - start) / 1000).toFixed(1)
        console.log(`[SFTP] 上传完成: ${path.basename(LOCAL)} -> ${REMOTE} (${(size / 1048576).toFixed(1)}MB, ${sec}s)`)
        conn.end()
      })
      // 进度
      const timer = setInterval(() => {
        try {
          sftp.stat(REMOTE, (e2, st) => {
            if (!e2 && st) {
              const pct = Math.min(100, ((st.size / size) * 100).toFixed(0))
              process.stdout.write(`\r[SFTP] 进度: ${pct}%`)
            }
          })
        } catch (e) {}
      }, 2000)
      conn.on('close', () => clearInterval(timer))
    })
  })
  .on('error', (err) => {
    console.error('[SFTP] 连接失败:', err.message)
    process.exit(1)
  })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 30000 })
