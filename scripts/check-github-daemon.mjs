/**
 * #12 GitHub daemon 自检（esbuild 打包后 node 直跑真单测）。
 * 盯的是：mention 检测纯函数、安全闸门（dryRun/无 token 默认不回帖）、pollOnce 用注入 fetcher 检出 issue/comment 提及。
 * 回帖动作本身由 shouldPost 闸门保护，默认 false，绝不对外写。
 * 用法：node scripts/check-github-daemon.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'gd-'))
buildSync({ entryPoints: ['src/main/services/githubDaemon.ts'], bundle: true, format: 'esm', platform: 'node', outdir: out })
const m = await import('file://' + join(out, 'githubDaemon.js').replace(/\\/g, '/'))
rmSync(out, { recursive: true, force: true })

const { detectMentions, shouldPost, buildAnalysis, pollOnce } = m

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── 纯函数：mention 检测 ──
check('detectMentions 命中', JSON.stringify(detectMentions('hey @ni please look', ['@ni', '@neuralinverse'])) === JSON.stringify(['@ni']))
check('detectMentions 不区分大小写', detectMentions('@NEURALINVERSE', ['@neuralinverse']).length === 1)
check('detectMentions 空文本', detectMentions('', ['@ni']).length === 0)

// ── 安全闸门：默认不回帖 ──
check('dryRun 默认(true) 不应回帖', shouldPost({ enabled: true }, 'tok') === false)
check('enabled=false 不应回帖', shouldPost({ enabled: false, dryRun: false }, 'tok') === false)
check('无 token 不应回帖', shouldPost({ enabled: true, dryRun: false }, '') === false)
check('仅 enabled+dryRun:false+token 才回帖', shouldPost({ enabled: true, dryRun: false }, 'tok') === true)

// ── buildAnalysis ──
const a = buildAnalysis({ type: 'issue', number: 5, url: 'u', author: 'bob', matched: ['@ni'], snippet: 'please fix' })
check('buildAnalysis 含编号/作者/片段', a.includes('#5') && a.includes('bob') && a.includes('please fix'))

// ── pollOnce（mock fetch，验证检测逻辑） ──
const fakeIssue = { number: 1, html_url: 'https://x/1', user: { login: 'a' }, title: 't', body: 'call @ni', comments_url: 'https://x/1/comments', pull_request: undefined }
const fakeComments = [{ id: 10, user: { login: 'b' }, body: 'also @neuralinverse here' }]
const fetcher = async (url, _init) => {
  if (String(url).endsWith('/comments')) return { ok: true, status: 200, json: async () => fakeComments }
  return { ok: true, status: 200, json: async () => [fakeIssue] }
}
const hits = await pollOnce({ owner: 'o', repo: 'r' }, '', fetcher)
check('pollOnce 检出 issue 提及', hits.some((h) => h.type === 'issue' && h.number === 1 && h.matched.includes('@ni')))
check('pollOnce 检出 comment 提及', hits.some((h) => h.type === 'comment' && h.commentId === 10 && h.matched.includes('@neuralinverse')))

console.log(`[github-daemon] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[github-daemon] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[github-daemon] ✓ 全部通过')
