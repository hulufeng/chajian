/**
 * GitHub daemon（#12 对标 NeuralInverse gitHubDaemonService）。
 *
 * 安全红线（务必遵守）：
 *  - 默认不启动（enabled=false）；宿主不会自动 start()。
 *  - 默认 dryRun=true：即使启动，也只检测 mention、生成分析，**绝不向 GitHub 回帖**。
 *  - Token 只从环境变量 GITHUB_TOKEN 或设置项 githubToken 读取，绝不硬编码、绝不打印。
 *  - 回帖需显式 enableGitHubDaemon({ dryRun:false }) 且有 token；对外写操作风险高，默认关闭。
 *
 * 用全局 fetch 调 GitHub REST（无需引入 octokit 依赖）。
 */
export interface GitHubDaemonConfig {
  owner: string
  repo: string
  /** 检测的提及词，默认 ['@ni','@neuralinverse','@labcode'] */
  mentions?: string[]
  /** 轮询间隔 ms，默认 60000 */
  pollMs?: number
  /** true=只分析不回帖（默认 true，安全） */
  dryRun?: boolean
  /** 需显式开启；默认 false */
  enabled?: boolean
}

export interface MentionHit {
  type: 'issue' | 'pr' | 'comment'
  number: number
  commentId?: number
  url: string
  author: string
  matched: string[]
  snippet: string
}

/** 纯函数：在文本中找出命中的提及词（不区分大小写） */
export function detectMentions(text: string, mentions: string[]): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const hit: string[] = []
  for (const m of mentions) {
    const needle = m.toLowerCase()
    if (needle && lower.includes(needle)) hit.push(m)
  }
  return hit
}

/** 安全闸门：是否允许回帖。dryRun 默认 true（安全），必须显式 dryRun:false + enabled + token 才真回帖。 */
export function shouldPost(cfg: GitHubDaemonConfig, token: string): boolean {
  return Boolean(cfg.enabled) && cfg.dryRun === false && Boolean(token)
}

/** 把命中点整理成可读分析文本（结构化提取，不靠 LLM 编造） */
export function buildAnalysis(hit: MentionHit): string {
  return [
    `在 ${hit.type} #${hit.number}（${hit.url}）检测到提及：${hit.matched.join(', ')}`,
    `作者：${hit.author}`,
    `片段：${hit.snippet.slice(0, 280)}`
  ].join('\n')
}

interface GitHubIssue {
  number: number
  html_url: string
  user?: { login?: string }
  title?: string
  body?: string
  pull_request?: unknown
  comments_url?: string
}

const DEFAULT_MENTIONS = ['@ni', '@neuralinverse', '@labcode']

type Fetcher = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/** 单次轮询：拉取近期 issue/PR 及其评论，返回命中提及的项。fetcher 可注入（测试用）。 */
export async function pollOnce(
  cfg: GitHubDaemonConfig,
  token: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
): Promise<MentionHit[]> {
  const mentions = cfg.mentions && cfg.mentions.length ? cfg.mentions : DEFAULT_MENTIONS
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'LabCode-GitHubDaemon',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
  const hits: MentionHit[] = []
  const listUrl = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/issues?state=all&sort=updated&direction=desc&per_page=30`
  const listRes = await fetcher(listUrl, { headers: headers as unknown as RequestInit })
  if (!listRes.ok) throw new Error(`GitHub API ${listRes.status}`)
  const issues = (await listRes.json()) as GitHubIssue[]
  for (const it of issues) {
    const bodyHits = detectMentions(`${it.title || ''}\n${it.body || ''}`, mentions)
    if (bodyHits.length) {
      hits.push({
        type: it.pull_request ? 'pr' : 'issue',
        number: it.number,
        url: it.html_url,
        author: it.user?.login || 'unknown',
        matched: bodyHits,
        snippet: it.body || it.title || ''
      })
    }
    if (it.comments_url) {
      try {
        const cRes = await fetcher(it.comments_url, { headers: headers as unknown as RequestInit })
        if (cRes.ok) {
          const comments = (await cRes.json()) as Array<{ id: number; user?: { login?: string }; body?: string; html_url?: string }>
          for (const c of comments) {
            const ch = detectMentions(c.body || '', mentions)
            if (ch.length) {
              hits.push({
                type: 'comment',
                number: it.number,
                commentId: c.id,
                url: c.html_url || it.html_url,
                author: c.user?.login || 'unknown',
                matched: ch,
                snippet: c.body || ''
              })
            }
          }
        }
      } catch {
        /* 单条评论拉取失败不影响整体 */
      }
    }
  }
  return hits
}

let timer: ReturnType<typeof setInterval> | null = null

/** 读取 token：仅环境变量/设置，绝不硬编码、绝不打印 */
function readToken(): string {
  const env = process.env.GITHUB_TOKEN
  if (env) return env
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readSettings } = require('../settings')
    const s = readSettings() as Record<string, unknown>
    if (typeof s.githubToken === 'string' && s.githubToken) return s.githubToken
  } catch {
    /* 降级 */
  }
  return ''
}

function postComment(url: string, body: string, token: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher): Promise<unknown> {
  return fetcher(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'LabCode-GitHubDaemon',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    } as unknown as RequestInit,
    body: JSON.stringify({ body })
  } as unknown as RequestInit)
}

/**
 * 启动守护进程。默认（enabled=false / dryRun=true）什么都不做；只有显式配置才会轮询，
 * 且只有在 shouldPost 为真时才回帖。首次轮询后 resolve（便于日志/测试）。
 */
export async function startGitHubDaemon(
  cfg: GitHubDaemonConfig,
  onHit?: (h: MentionHit, analysis: string) => void
): Promise<void> {
  const token = readToken()
  if (!cfg.enabled) {
    console.log('[github-daemon] 未启用（enabled=false），不启动轮询')
    return
  }
  if (!token) {
    console.warn('[github-daemon] 未提供 GITHUB_TOKEN，仅能做公开仓库的只读检测，无法回帖')
  }
  const poll = async (): Promise<void> => {
    try {
      const hits = await pollOnce(cfg, token)
      for (const h of hits) {
        const analysis = buildAnalysis(h)
        onHit?.(h, analysis)
        if (shouldPost(cfg, token)) {
          const issueUrl = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/issues/${h.number}/comments`
          await postComment(issueUrl, `[LabCode] ${analysis}\n\n（本回复由 LabCode GitHub daemon 自动生成）`, token)
        }
      }
    } catch (e) {
      console.warn(`[github-daemon] 轮询失败：${(e as Error).message}`)
    }
  }
  await poll()
  const ms = cfg.pollMs && cfg.pollMs > 0 ? cfg.pollMs : 60000
  timer = setInterval(() => void poll(), ms)
}

export function stopGitHubDaemon(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function isDaemonRunning(): boolean {
  return timer !== null
}
