// Git 服务：以参数数组方式调用 git（避免 shell 拼接注入），提供状态/diff/暂存/提交/初始化
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'

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
    // core.quotePath=false：非 ASCII 路径原样输出（否则 git 输出 \345\212\237 等八进制转义）
    // advice.addEmbeddedRepo=false：抑制嵌入式仓库提示噪音
    execFile('git', ['-c', 'core.quotePath=false', '-c', 'advice.addEmbeddedRepo=false', ...args], { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
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
  const empty: GitStatus = {
    isRepo: false, branch: '', upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: []
  }
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
