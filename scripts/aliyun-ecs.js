/**
 * 探测阿里云 ECS 实例信息（DescribeInstances）
 * 用法：node scripts/aliyun-ecs.js [regionId]
 * 环境变量：ALIYUN_AK / ALIYUN_SK
 */
const crypto = require('node:crypto')
const https = require('node:https')

const AK = process.env.ALIYUN_AK
const SK = process.env.ALIYUN_SK
if (!AK || !SK) {
  console.error('[ECS] 请设置 ALIYUN_AK / ALIYUN_SK')
  process.exit(1)
}

function pe(str) {
  return encodeURIComponent(str).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
}

function call(action, region, version, extra = {}) {
  const params = {
    AccessKeyId: AK,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    Version: version,
    ...extra
  }
  const keys = Object.keys(params).sort()
  const canonical = keys.map((k) => `${pe(k)}=${pe(params[k])}`).join('&')
  const stringToSign = `GET&${pe('/')}&${pe(canonical)}`
  const sig = crypto.createHmac('sha1', SK + '&').update(stringToSign, 'utf-8').digest('base64')
  params.Signature = sig
  const qs = Object.keys(params)
    .map((k) => `${pe(k)}=${pe(params[k])}`)
    .join('&')
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'ecs.aliyuncs.com', path: `/?${qs}`, method: 'GET' },
      (res) => {
        let data = ''
        res.on('data', (d) => (data += d))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  const region = process.argv[2] || 'cn-hangzhou'
  const res = await call('DescribeInstances', region, '2014-05-26', { RegionId: region, PageSize: '50' })
  console.log(`[ECS] HTTP ${res.status}`)
  try {
    const j = JSON.parse(res.body)
    if (j.Code) {
      console.log('[ECS] 错误:', j.Code, j.Message)
      process.exit(1)
    }
    const insts = (j.Instances && j.Instances.Instance) || []
    console.log(`[ECS] 实例数量: ${insts.length}（区域 ${region}）`)
    for (const it of insts) {
      console.log('----')
      console.log(`  实例ID    : ${it.InstanceId}`)
      console.log(`  实例名称  : ${it.InstanceName || '-'}`)
      console.log(`  状态      : ${it.Status}`)
      console.log(`  公网IP    : ${(it.PublicIpAddress && it.PublicIpAddress.IpAddress && it.PublicIpAddress.IpAddress.join(',')) || '-'}`)
      console.log(`  弹性IP    : ${(it.EipAddress && it.EipAddress.IpAddress) || '-'}`)
      console.log(`  内网IP    : ${(it.VpcAttributes && it.VpcAttributes.PrivateIpAddress && it.VpcAttributes.PrivateIpAddress.IpAddress && it.VpcAttributes.PrivateIpAddress.IpAddress.join(',')) || '-'}`)
      console.log(`  系统      : ${it.OSName || it.OSType || '-'}`)
      console.log(`  创建时间  : ${it.CreationTime || '-'}`)
    }
    if (insts.length === 0) {
      console.log(`[ECS] 该区域无实例，可尝试其他区域：node scripts/aliyun-ecs.js cn-beijing / cn-qingdao / cn-shanghai 等`)
    }
  } catch (e) {
    console.log('[ECS] 解析失败', res.body.slice(0, 500))
  }
}

main()
