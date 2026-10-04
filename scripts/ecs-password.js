const crypto = require('node:crypto')
const https = require('node:https')
const AK = process.env.ALIYUN_AK
const SK = process.env.ALIYUN_SK
const ACTION = process.argv[2] // ResetInstancePassword | RebootInstance
const PASSWORD = process.argv[3]
function pe(s) {
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
}
const params = {
  AccessKeyId: AK,
  Action: ACTION,
  Format: 'JSON',
  RegionId: 'cn-qingdao',
  SignatureMethod: 'HMAC-SHA1',
  SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
  SignatureVersion: '1.0',
  Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  Version: '2014-05-26',
  InstanceId: 'i-m5eihcqadjdav7u2cqq9'
}
if (ACTION === 'ResetInstancePassword') {
  params.Password = PASSWORD
} else if (ACTION === 'RebootInstance') {
  params.ForceStop = 'false'
} else {
  console.error('未知动作')
  process.exit(1)
}
// RPC 签名（方法无关，参数排序后计算）
const keys = Object.keys(params).sort()
const canonical = keys.map((k) => pe(k) + '=' + pe(params[k])).join('&')
const sts = 'POST&' + pe('/') + '&' + pe(canonical)
params.Signature = crypto.createHmac('sha1', SK + '&').update(sts, 'utf-8').digest('base64')
const body = Object.keys(params)
  .map((k) => pe(k) + '=' + pe(params[k]))
  .join('&')
const req = https.request(
  {
    hostname: 'ecs.cn-qingdao.aliyuncs.com',
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
      console.log(d)
    })
  }
)
req.on('error', (e) => console.error(e))
req.write(body)
req.end()
