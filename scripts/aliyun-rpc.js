/** 通用阿里云 RPC API 调用（POST） */
const crypto = require('node:crypto')
const https = require('node:https')
const AK = process.env.ALIYUN_AK
const SK = process.env.ALIYUN_SK
function pe(s) {
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
}
const ACTION = process.argv[2]
const REGION = process.argv[3] || 'cn-qingdao'
const HOST = process.argv[4] || 'ecs.cn-qingdao.aliyuncs.com'
// 额外参数 key=value（重复项可再传）
const extra = {}
for (let i = 5; i < process.argv.length; i++) {
  const kv = process.argv[i].split('=')
  extra[kv[0]] = kv.slice(1).join('=')
}
const params = {
  AccessKeyId: AK,
  Action: ACTION,
  Format: 'JSON',
  SignatureMethod: 'HMAC-SHA1',
  SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
  SignatureVersion: '1.0',
  Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  Version: '2014-05-26',
  ...extra
}
if (REGION) params.RegionId = REGION
const keys = Object.keys(params).sort()
const canonical = keys.map((k) => pe(k) + '=' + pe(params[k])).join('&')
const sts = 'POST&' + pe('/') + '&' + pe(canonical)
params.Signature = crypto.createHmac('sha1', SK + '&').update(sts, 'utf-8').digest('base64')
const body = Object.keys(params)
  .map((k) => pe(k) + '=' + pe(params[k]))
  .join('&')
const req = https.request(
  {
    hostname: HOST,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  },
  (r) => {
    let d = ''
    r.on('data', (c) => (d += c))
    r.on('end', () => {
      console.log(`[${ACTION}] HTTP ${r.statusCode}`)
      console.log(d.slice(0, 800))
    })
  }
)
req.on('error', (e) => console.error(e))
req.write(body)
req.end()
