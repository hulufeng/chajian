/**
 * 校验阿里云 AccessKey 是否有效（STS GetCallerIdentity）
 * 用法：node scripts/aliyun-whoami.js
 * 环境变量：ALIYUN_AK / ALIYUN_SK
 */
const crypto = require('node:crypto')
const https = require('node:https')

const AK = process.env.ALIYUN_AK
const SK = process.env.ALIYUN_SK
if (!AK || !SK) {
  console.error('[STS] 请设置 ALIYUN_AK / ALIYUN_SK')
  process.exit(1)
}

function pe(str) {
  return encodeURIComponent(str).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
}

function main() {
  const params = {
    AccessKeyId: AK,
    Action: 'GetCallerIdentity',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    Version: '2015-04-01'
  }
  const keys = Object.keys(params).sort()
  const canonical = keys.map((k) => `${pe(k)}=${pe(params[k])}`).join('&')
  const stringToSign = `GET&${pe('/')}&${pe(canonical)}`
  const sig = crypto.createHmac('sha1', SK + '&').update(stringToSign, 'utf-8').digest('base64')
  params.Signature = sig

  const qs = Object.keys(params)
    .map((k) => `${pe(k)}=${pe(params[k])}`)
    .join('&')

  const req = https.request(
    {
      hostname: 'sts.aliyuncs.com',
      path: `/?${qs}`,
      method: 'GET'
    },
    (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => {
        console.log(`[STS] HTTP ${res.statusCode}`)
        try {
          const j = JSON.parse(data)
          if (j.AccountId) {
            console.log('[STS] AccessKey 有效 ✅')
            console.log(`[STS] AccountId : ${j.AccountId}`)
            console.log(`[STS] Arn       : ${j.Arn}`)
            console.log(`[STS] 用户类型   : ${j.Arn.includes(':ram::') ? 'RAM 用户' : j.Arn.includes('root') ? '主账号' : '未知/角色'}`)
          } else {
            console.log('[STS] AccessKey 无效 ❌')
            console.log(data)
          }
        } catch {
          console.log(data)
        }
      })
    }
  )
  req.on('error', (e) => console.error('[STS] 请求失败', e.message))
  req.end()
}

main()
