const crypto = require('node:crypto')
const https = require('node:https')
const AK = process.env.ALIYUN_AK
const SK = process.env.ALIYUN_SK
function pe(s) {
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
}
const params = {
  AccessKeyId: AK,
  Action: 'DescribeInstances',
  Format: 'JSON',
  RegionId: 'cn-qingdao',
  SignatureMethod: 'HMAC-SHA1',
  SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
  SignatureVersion: '1.0',
  Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  Version: '2014-05-26',
  InstanceIds: '["i-m5eihcqadjdav7u2cqq9"]'
}
const keys = Object.keys(params).sort()
const canonical = keys.map((k) => pe(k) + '=' + pe(params[k])).join('&')
const sts = 'GET&' + pe('/') + '&' + pe(canonical)
params.Signature = crypto.createHmac('sha1', SK + '&').update(sts, 'utf-8').digest('base64')
const qs = Object.keys(params).map((k) => pe(k) + '=' + pe(params[k])).join('&')
https
  .get('https://ecs.aliyuncs.com/?' + qs, (r) => {
    let d = ''
    r.on('data', (c) => (d += c))
    r.on('end', () => {
      const j = JSON.parse(d)
      const it = (j.Instances && j.Instances.Instance && j.Instances.Instance[0]) || {}
      console.log('实例ID:', it.InstanceId)
      console.log('KeyPairName:', it.KeyPairName || '(无密钥对绑定)')
      console.log('InstanceChargeType:', it.InstanceChargeType)
      console.log('ExpiredTime:', it.ExpiredTime || '(无到期/按量)')
      console.log('SecurityGroupIds:', it.SecurityGroupIds ? it.SecurityGroupIds.SecurityGroupId.join(',') : '-')
      console.log('PublicIp:', it.PublicIpAddress ? it.PublicIpAddress.IpAddress.join(',') : '-')
    })
  })
  .on('error', (e) => console.error(e))
