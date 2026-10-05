// Git 服务：以参数数组方式调用 git（避免 shell 拼接注入），提供状态/diff/暂存/提交/初始化
import { execFile } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'

/**
 * 定位 git 可执行文件。
 * 不能只依赖 PATH：Windows 上 git 常常只是装了但没进 PATH（GitHub Desktop / 便携版 /
 * 公司机预装都可能不在），此时 UI 会表现为「所有 git 操作都没反应」，很难排查。
 */
let cachedGit: string | null | undefined

export function locateGit(): string | null {
  if (cachedGit !== undefined) return cachedGit
  const isWin = process.platform === 'win32'
  const names = isWin ? ['git.exe', 'git.cmd'] : ['git']
  const dirs = [
    join(homedir(), '.workbuddy', 'binaries', 'PortableGit'),
    'C:/Program Files/Git/cmd',
    'C:/Program Files/Git/bin',
    'C:/Program Files (x86)/Git/cmd',
    'C:/Program Files (x86)/Git/bin',
    join(homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd')
  ]
  // ① PATH 上的 git（最常见）
  for (const n of names) {
    try {
      const r = execFileSyncSafe(n, ['--version'])
      if (r) {
        cachedGit = n
        return cachedGit
      }
    } catch {
      /* 继续找 */
    }
  }
  // ② 常见安装位置（含 PortableGit 的版本目录）
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n)
      if (existsSync(p)) {
        cachedGit = p
        return cachedGit
      }
    }
    // PortableGit 是版本化目录：binaries/PortableGit/versions/*/mingw64/bin/git.exe
    if (d.includes('PortableGit') && existsSync(d)) {
      try {
        const { readdirSync } = require('node:fs') as typeof import('node:fs')
        const versions = readdirSync(join(d, 'versions')).sort().reverse()
        for (const v of versions) {
          for (const sub of ['mingw64/bin/git.exe', 'cmd/git.exe', 'bin/git.exe']) {
            const p = join(d, 'versions', v, sub)
            if (existsSync(p)) {
              cachedGit = p
              return cachedGit
            }
          }
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  cachedGit = null
  return cachedGit
}

/** 小工具：同步跑一次命令看是否可用（只用于探测 PATH 上的 git） */
function execFileSyncSafe(cmd: string, args: string[]): string | null {
  try {
    // 故意用同步 API 的最小封装：这里只在探测阶段调用，代价可忽略
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execFileSync(cmd, args, { encoding: 'utf-8', timeout: 8000, windowsHide: true })
    return typeof out === 'string' ? out : null
  } catch {
    return null
  }
}

export interface GitFileChange {
  path: string
  originalPath?: string // rename 时的旧路径
  // 聚合状态
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied'
  staged: boolean
  unstaged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  /** git 可执行文件找不到（未安装 / 不在 PATH）——与「不是仓库」是两回事，UI 必须分开提示 */
  unavailable?: boolean
  /** 实际定位到的 git 路径，便于用户确认装的是哪个 */
  gitPath?: string | null
}

function cleanGitError(stderr: string): string {
  // 过滤 warning:/hint: 行（如 embedded repo、CRLF 提示），保留真正的错误行
  const useful = stderr.split('\n').filter((l) => {
    const t = l.trim()
    if (!t) return false
    if (/^(warning|hint):/i.test(t)) return false
    if (/^fatal:/i.test(t)) return t.includes('embedded') ? false : true // embedded 相关 fatal 视为提示
    return true
  })
  return useful.join('\n').trim() || 'git 操作失败（详见输出）'
}

function git(args: string[], cwd: string, timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const bin = locateGit()
    if (!bin) {
      // 没有 git 就明确说清楚，不要让调用方拿到空字符串猜
      resolve({ code: 127, stdout: '', stderr: '未找到 git 可执行文件（PATH 与常见安装位置都没有）。请安装 Git 或把它加入 PATH。' })
      return
    }
    // core.quotePath=false：非 ASCII 路径原样输出（否则 git 输出 \345\212\237 等八进制转义）
    // advice.addEmbeddedRepo=false：抑制嵌入式仓库提示噪音
    execFile(bin, ['-c', 'core.quotePath=false', '-c', 'advice.addEmbeddedRepo=false', ...args], { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code: exitCode, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') })
    })
  })
}

function mapCode(code: string): GitFileChange['status'] {
  switch (code) {
    case 'M': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    default: return 'modified'
  }
}

export async function isRepo(root: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], root)
  return r.code === 0 && r.stdout.trim() === 'true'
}

export async function getStatus(root: string): Promise<GitStatus> {
  const gitPath = locateGit()
  const empty: GitStatus = {
    isRepo: false, branch: '', upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [],
    unavailable: !gitPath, gitPath
  }
  // 根本没装 git：直接标 unavailable，不要伪装成「不是仓库」把用户引去初始化仓库
  if (!gitPath) return empty
  if (!(await isRepo(root))) return empty

  const r = await git(['status', '--porcelain=v1', '-b', '--untracked-files=all'], root)
  if (r.code !== 0) return { ...empty, isRepo: true }

  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []
  const untracked: GitFileChange[] = []
  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0

  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('##')) {
      // ## main...origin/main [ahead 1, behind 2]  或 ## main (no upstream)
      // 首次提交前：## No commits yet on main；detached：## HEAD (no branch)
      const head = line.slice(3).trim()
      const noCommit = /^No commits yet on\s+(.+)$/.exec(head)
      if (noCommit) {
        branch = noCommit[1].trim()
        continue
      }
      const detached = /^HEAD(?:\s+\(no branch\))?/.test(head)
      if (detached) {
        branch = '(HEAD detached)'
        continue
      }
      const m = head.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/)
      if (m) {
        branch = m[1]
        if (m[2]) upstream = m[2]
        if (m[3]) {
          const a = /ahead (\d+)/.exec(m[3])
          const b = /behind (\d+)/.exec(m[3])
          if (a) ahead = parseInt(a[1], 10)
          if (b) behind = parseInt(b[1], 10)
        }
      } else {
        branch = head.split(/[\s.]+/)[0]
      }
      continue
    }

    const x = line[0]
    const y = line[1]
    let path = line.slice(3)
    let originalPath: string | undefined
    // rename: "R  old -> new"
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) {
      originalPath = path.slice(0, arrow).replace(/^"|"$/g, '')
      path = path.slice(arrow + 4).replace(/^"|"$/g, '')
    } else {
      path = path.replace(/^"|"$/g, '')
    }

    if (x === '?' && y === '?') {
      untracked.push({ path, status: 'untracked', staged: false, unstaged: true })
      continue
    }
    if (x !== ' ' && x !== '?') {
      staged.push({ path, originalPath, status: mapCode(x), staged: true, unstaged: y !== ' ' && y !== '?' })
    }
    if (y !== ' ' && y !== '?' && y !== undefined) {
      // 同一文件既 staged 又 unstaged（如 MM），unstaged 组也列一条
      unstaged.push({ path, originalPath, status: y === 'D' ? 'deleted' : 'modified', staged: x !== ' ' && x !== '?', unstaged: true })
    }
  }

  return { isRepo: true, branch, upstream, ahead, behind, staged, unstaged, untracked }
}

export async function getDiff(root: string, path: string, staged: boolean): Promise<string> {
  const args = staged ? ['diff', '--staged', '--', path] : ['diff', '--', path]
  const r = await git(args, root)
  if (r.code !== 0) return `# 无法获取 diff\n${r.stderr}`
  // 未跟踪文件没有 diff，直接展示其内容提示
  if (!r.stdout.trim()) {
    const show = await git(['diff', '--no-index', '--', '/dev/null', path], root)
    return show.stdout || `（${path} 是新文件，尚未跟踪；暂存后可查看差异）`
  }
  return r.stdout
}

export async function stage(root: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  if (paths.length === 0) return { ok: true }
  const r = await git(['add', '--', ...paths], root)
  if (r.code === 0) return { ok: true }
  return { ok: false, error: cleanGitError(r.stderr) }
}

export async function stageAll(root: string): Promise<{ ok: boolean; error?: string; skipped?: string[] }> {
  const r = await git(['add', '-A'], root)
  if (r.code === 0) return { ok: true }
  // 嵌入式仓库（无 commit 的子仓库）会让 git add -A 整体失败：
  // 解析出这些路径，用 --ignore-errors 重试，跳过坏条目、暂存其余文件（部分成功）
  const skipped: string[] = []
  for (const line of r.stderr.split('\n')) {
    const m = /error: '([^']+)' does not have a commit checked out/.exec(line.trim())
    if (m) skipped.push(m[1])
  }
  if (skipped.length > 0) {
    const r2 = await git(['add', '--ignore-errors', '-A'], root)
    if (r2.code === 0 || r2.code === 1) return { ok: true, skipped }
  }
  // 其它失败：错误信息过滤掉 warning/hint 噪音
  return { ok: false, error: cleanGitError(r.stderr) }
}

export async function unstage(root: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  if (paths.length === 0) return { ok: true }
  // 优先用 restore --staged（git 2.23+），回退 reset HEAD
  let r = await git(['restore', '--staged', '--', ...paths], root)
  if (r.code !== 0) r = await git(['reset', '-q', 'HEAD', '--', ...paths], root)
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || '取消暂存失败' }
}

export async function commit(root: string, message: string): Promise<{ ok: boolean; error?: string; sha?: string }> {
  const msg = message.trim()
  if (!msg) return { ok: false, error: '提交信息不能为空' }
  const r = await git(['commit', '-m', msg], root)
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout || '提交失败' }
  const sha = await git(['rev-parse', '--short', 'HEAD'], root)
  return { ok: true, sha: sha.stdout.trim() }
}

export async function initRepo(root: string, defaultBranch = 'main'): Promise<{ ok: boolean; error?: string }> {
  let r = await git(['init', '-b', defaultBranch], root)
  if (r.code !== 0) {
    // 旧版 git 不支持 -b
    r = await git(['init'], root)
    if (r.code !== 0) return { ok: false, error: r.stderr || 'git init 失败' }
    await git(['checkout', '-b', defaultBranch], root)
  }
  return { ok: true }
}

export interface GitLogEntry {
  sha: string
  author: string
  date: string
  subject: string
}

export async function getLog(root: string, n = 30): Promise<GitLogEntry[]> {
  const r = await git(['log', `-${n}`, '--pretty=format:%h%x1f%an%x1f%ar%x1f%s'], root)
  if (r.code !== 0) return []
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, author, date, ...rest] = line.split('\x1f')
    return { sha, author, date, subject: rest.join('\x1f') }
  })
}

export async function pull(root: string): Promise<{ ok: boolean; text: string }> {
  const r = await git(['pull', '--ff-only'], root, 60000)
  return { ok: r.code === 0, text: r.stdout + r.stderr }
}

export async function push(root: string): Promise<{ ok: boolean; text: string }> {
  const r = await git(['push'], root, 60000)
  return { ok: r.code === 0, text: r.stdout + r.stderr }
}

/**
 * 应用一段 unified diff patch（用于 hunk 级暂存/丢弃）。
 * cached=true 暂存到索引（git apply --cached）；cached=false 应用到工作区。
 */
export async function applyPatch(root: string, patchContent: string, cached = true): Promise<{ ok: boolean; error?: string }> {
  const tmp = join(tmpdir(), `lc-patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`)
  try {
    writeFileSync(tmp, patchContent, 'utf8')
    const args = ['apply', '--whitespace=nowarn']
    if (cached) args.push('--cached')
    args.push(tmp)
    const r = await git(args, root)
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'git apply failed').trim() }
    return { ok: true }
  } finally {
    try { unlinkSync(tmp) } catch { }
  }
}

// ============================================================
//  分支与远端（第四批③）
// ============================================================

export interface GitBranchInfo {
  name: string
  current: boolean
  /** 远端跟踪分支名（如 origin/main），无则 null */
  upstream: string | null
  ahead: number
  behind: number
  lastCommit: string
  lastTime: string
  lastSubject: string
}

export interface GitBranchView {
  current: string
  detached: boolean
  branches: GitBranchInfo[]
  remotes: Array<{ name: string; url: string; fetchUrl: string }>
}

/** 分支列表的字段分隔符：用 ASCII unit separator（0x1F），ref 元数据里不会出现，
 *  比 % 或 | 可靠（提交标题里完全可能含 100% 或竖线，用它们当分隔符会错位）。 */
const FIELD_SEP = '\x1f'

/** 解析 `%(upstream:track)` 的输出：`[ahead 1, behind 2]` / `[ahead 1]` / `[behind 2]` / 空 */
function parseTrack(track: string): { ahead: number; behind: number } {
  if (!track) return { ahead: 0, behind: 0 }
  const a = track.match(/ahead (\d+)/)
  const b = track.match(/behind (\d+)/)
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0 }
}

/**
 * 解析 `git for-each-ref` 的分支行（纯函数，便于单测）。
 * 字段顺序：name / upstream / track / sha / time / subject
 */
export function parseBranchRefLines(stdout: string, current: string): GitBranchInfo[] {
  return stdout
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [name, upstream, track, sha, time, subject = ''] = line.split(FIELD_SEP)
      const { ahead, behind } = parseTrack(track || '')
      return {
        name: (name || '').trim(),
        current: name === current,
        upstream: (upstream || '').trim() || null,
        ahead,
        behind,
        lastCommit: (sha || '').trim(),
        lastTime: (time || '').trim(),
        lastSubject: subject.trim()
      }
    })
    .filter((b) => b.name.length > 0)
}

/** 列出本地分支（含 ahead/behind 与最后提交摘要） */
export async function listBranches(root: string): Promise<GitBranchView> {
  const empty: GitBranchView = { current: '', detached: false, branches: [], remotes: [] }
  if (!(await isRepo(root))) return empty

  // for-each-ref：一次拿全，避免逐个分支 spawn
  // 注意：ahead/behind 没有 %(ahead) 字段，必须用 %(upstream:track)
  const fmt = [
    '%(refname:short)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(objectname:short)',
    '%(committerdate:iso8601-strict)',
    '%(contents:subject)'
  ].join(FIELD_SEP)
  const br = await git(['for-each-ref', '--format=' + fmt, 'refs/heads'], root)
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
  const current = head.code === 0 ? head.stdout.trim() : ''
  const branches = parseBranchRefLines(br.stdout, current)

  // detached HEAD：symbolic-ref 非 0 说明处于游离状态
  const detached = head.code !== 0

  const rem = await git(['remote', '-v'], root)
  const remotes: GitBranchView['remotes'] = []
  for (const line of rem.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (!m) continue
    const [, name, url, kind] = m
    const hit = remotes.find((r) => r.name === name)
    if (hit) {
      if (kind === 'fetch') hit.fetchUrl = url
      else hit.url = url
    } else {
      remotes.push({ name, url: kind === 'push' ? url : '', fetchUrl: kind === 'fetch' ? url : '' })
    }
  }
  return { current, detached, branches, remotes }
}

/** 新建分支（可同时切换） */
export async function createBranch(root: string, name: string, checkout = true): Promise<{ ok: boolean; error?: string }> {
  const n = String(name || '').trim()
  if (!n) return { ok: false, error: '分支名不能为空' }
  if (!/^[A-Za-z0-9._/-]+$/.test(n)) return { ok: false, error: '分支名含非法字符（只允许字母数字 . _ / -）' }
  if (n.includes('..') || n.endsWith('/') || n.startsWith('-')) {
    return { ok: false, error: '分支名不合法（不能含 ..、不能以 - 或 / 开头结尾）' }
  }
  const r = await git(checkout ? ['checkout', '-b', n] : ['branch', n], root)
  return r.code === 0 ? { ok: true } : { ok: false, error: cleanGitError(r.stderr || r.stdout) }
}

/** 切换到已有分支 */
export async function checkoutBranch(root: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const n = String(name || '').trim()
  if (!n) return { ok: false, error: '分支名不能为空' }
  const r = await git(['checkout', n], root)
  if (r.code === 0) return { ok: true }
  return { ok: false, error: cleanGitError(r.stderr || r.stdout) }
}

/** 删除分支（默认拒绝删当前分支） */
export async function deleteBranch(root: string, name: string, force = false): Promise<{ ok: boolean; error?: string }> {
  const n = String(name || '').trim()
  if (!n) return { ok: false, error: '分支名不能为空' }
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
  if (head.code === 0 && head.stdout.trim() === n) {
    return { ok: false, error: '不能删除当前所在分支，请先切换到别的分支' }
  }
  const r = await git(['branch', force ? '-D' : '-d', n], root)
  return r.code === 0 ? { ok: true } : { ok: false, error: cleanGitError(r.stderr || r.stdout) }
}

/** 合并分支到当前分支 */
export async function mergeBranch(root: string, name: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const n = String(name || '').trim()
  if (!n) return { ok: false, text: '', error: '分支名不能为空' }
  const r = await git(['merge', '--no-edit', n], root, 60000)
  const text = `${r.stdout}${r.stderr}`.trim()
  return r.code === 0 ? { ok: true, text } : { ok: false, text, error: cleanGitError(r.stderr || r.stdout) }
}

/** 拉取远端元信息（不合并工作区） */
export async function fetchRemote(root: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const rem = await git(['remote'], root)
  if (!rem.stdout.trim()) return { ok: false, text: '', error: '没有配置远端（先添加 remote）' }
  const r = await git(['fetch', '--all', '--prune'], root, 90000)
  const text = `${r.stdout}${r.stderr}`.trim()
  return r.code === 0 ? { ok: true, text } : { ok: false, text, error: cleanGitError(r.stderr || r.stdout) }
}

/** 添加远端 */
export async function addRemote(root: string, name: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const n = String(name || '').trim()
  const u = String(url || '').trim()
  if (!n || !u) return { ok: false, error: '远端名与地址都要填' }
  if (!/^https?:\/\/|^git@|^ssh:\/\//i.test(u)) {
    return { ok: false, error: '地址需以 http(s):// 、git@ 或 ssh:// 开头' }
  }
  const exist = await git(['remote', 'get-url', n], root)
  const r = exist.code === 0
    ? await git(['remote', 'set-url', n, u], root)
    : await git(['remote', 'add', n, u], root)
  return r.code === 0 ? { ok: true } : { ok: false, error: cleanGitError(r.stderr || r.stdout) }
}

/** 丢弃工作区改动（unstaged → checkout --） */
export async function discardChanges(root: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  const list = (paths || []).filter(Boolean)
  if (list.length === 0) return { ok: false, error: '没有选中文件' }
  const r = await git(['checkout', '--', ...list], root)
  return r.code === 0 ? { ok: true } : { ok: false, error: cleanGitError(r.stderr || r.stdout) }
}

/** 暂存单个文件（含未跟踪文件新增到暂存区） */
export async function stageOne(root: string, path: string): Promise<{ ok: boolean; error?: string }> {
  if (!path) return { ok: false, error: '路径为空' }
  const r = await git(['add', '--', path], root)
  return r.code === 0 ? { ok: true } : { ok: false, error: cleanGitError(r.stderr || r.stdout) }
}