/**
 * 阿里云 OSS 更新部署工具（通用签名实现，无第三方依赖）
 * 用法：
 *   node scripts/aliyun-oss.js list-buckets
 *   node scripts/aliyun-oss.js list-objects <bucket> [prefix]
 *   node scripts/aliyun-oss.js upload <bucket> <localFile> <key> [--public]
 *   node scripts/aliyun-oss.js create-bucket <bucket> [region]
 *
 * 环境变量：ALIYUN_AK / ALIYUN_SK
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

const AK = process.env.ALIYUN_AK
const SK = process.env.ALIYUN_SK
if (!AK || !SK) {
  console.error('[OSS] 请设置环境变量 ALIYUN_AK / ALIYUN_SK')
  process.exit(1)
}

const CENTER_ENDPOINT = 'oss.aliyuncs.com'

function gmtDate() {
  return new Date().toUTCString()
}

function hmacSha1(str) {
  return crypto.createHmac('sha1', SK).update(str, 'utf-8').digest('base64')
}

/**
 * OSS 签名。
 * headers: { date, [content-md5], [content-type], [x-oss-*] }
 * resource: canonicalizedResource（如 /bucket/key）
 */
function sign(method, headers, resource) {
  const md5 = headers['content-md5'] || ''
  const ct = headers['content-type'] || ''
  const date = headers.date || ''
  const ossHeaders = Object.keys(headers)
    .filter((k) => k.startsWith('x-oss-'))
    .sort()
    .map((k) => `${k}:${headers[k]}`)
    .join('\n')
  const stringToSign = `${method}\n${md5}\n${ct}\n${date}\n${ossHeaders}${ossHeaders ? '\n' : ''}${resource}`
  return `OSS ${AK}:${hmacSha1(stringToSign)}`
}

function request(opts, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 中心端点列出所有 bucket */
async function listBuckets() {
  const date = gmtDate()
  const auth = sign('GET', { date }, '/')
  const res = await request(
    {
      hostname: CENTER_ENDPOINT,
      path: '/',
      method: 'GET',
      headers: { Date: date, Authorization: auth }
    },
    null
  )
  if (res.status !== 200) {
    console.error('[OSS] ListBuckets 失败', res.status, res.body)
    process.exit(1)
  }
  const names = [...res.body.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1])
  const locations = [...res.body.matchAll(/<Location>([^<]+)<\/Location>/g)].map((m) => m[1])
  const rows = names.map((n, i) => ({ name: n, location: locations[i] || '' }))
  console.log('[OSS] Buckets:')
  for (const r of rows) console.log(`  ${r.name}  ${r.location}`)
  return rows
}

async function listObjects(bucket, prefix) {
  const date = gmtDate()
  const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
  const res = await request(
    {
      hostname: CENTER_ENDPOINT,
      path: `/${bucket}${q}`,
      method: 'GET',
      headers: { Date: date, Authorization: sign('GET', { date }, `/${bucket}/`) }
    },
    null
  )
  if (res.status !== 200) {
    console.error('[OSS] ListObjects 失败', res.status, res.body)
    process.exit(1)
  }
  const keys = [...res.body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])
  console.log(`[OSS] ${bucket}${prefix ? '/' + prefix : ''}:`)
  keys.forEach((k) => console.log(`  ${k}`))
  return keys
}

async function uploadObject(bucket, region, localFile, key, publicRead) {
  const data = fs.readFileSync(localFile)
  const contentType =
    key.endsWith('.yml') || key.endsWith('.yaml')
      ? 'application/octet-stream'
      : key.endsWith('.exe')
        ? 'application/octet-stream'
        : 'application/octet-stream'
  const date = gmtDate()
  const headers = { date, 'content-type': contentType }
  let resource = `/${bucket}/${key}`
  if (publicRead) {
    headers['x-oss-object-acl'] = 'public-read'
  }
  const auth = sign('PUT', headers, resource)
  const res = await request(
    {
      hostname: `${bucket}.${region}.aliyuncs.com`,
      path: `/${key}`,
      method: 'PUT',
      headers: {
        Date: date,
        'Content-Type': contentType,
        'Content-Length': data.length,
        'x-oss-object-acl': publicRead ? 'public-read' : 'private',
        Authorization: auth
      }
    },
    data
  )
  if (res.status !== 200) {
    console.error('[OSS] 上传失败', res.status, res.body)
    process.exit(1)
  }
  console.log(`[OSS] 已上传 ${key} (${(data.length / 1024 / 1024).toFixed(2)} MB) publicRead=${!!publicRead}`)
}

async function createBucket(bucket, region) {
  const date = gmtDate()
  // PutBucket 必须用区域端点（不带 bucket 前缀的虚拟主机），路径为 /<bucket>
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CreateBucketConfiguration><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`
  const res = await request(
    {
      hostname: `${region}.aliyuncs.com`,
      path: `/${bucket}`,
      method: 'PUT',
      headers: {
        Date: date,
        'Content-Type': 'application/xml',
        'Content-Length': Buffer.byteLength(xml),
        'x-oss-acl': 'private',
        Authorization: sign('PUT', { date, 'content-type': 'application/xml', 'x-oss-acl': 'private' }, `/${bucket}`)
      }
    },
    xml
  )
  if (res.status !== 200) {
    console.error('[OSS] 创建 bucket 失败', res.status, res.body)
    process.exit(1)
  }
  console.log(`[OSS] 已创建 bucket：${bucket} @ ${region}（ACL=private，对象可单独 public-read）`)
}

function main() {
  const [cmd, a, b, c] = process.argv.slice(2)
  if (cmd === 'list-buckets') return listBuckets()
  if (cmd === 'list-objects') return listObjects(a, b || '')
  if (cmd === 'create-bucket') return createBucket(a, b || 'oss-cn-hangzhou')
  if (cmd === 'upload') return uploadObject(a, process.env.OSS_REGION || 'oss-cn-hangzhou', b, c, process.argv.includes('--public'))
  console.error('用法：list-buckets | create-bucket <name> [region] | list-objects <bucket> [prefix] | upload <bucket> <file> <key> [--public]')
  process.exit(1)
}

main()
