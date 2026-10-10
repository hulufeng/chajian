/**
 * 分享卡片（差异化功能 #5）
 *
 * 产出一张自包含的 HTML 卡片（内联 CSS、零外部依赖、可直接微信/浏览器打开），
 * 写到用户目录并用系统默认浏览器打开。用途：把一次编译/烧录/调测结果分享出去。
 * 不联网、不上传：文件只落在本地 %APPDATA%/codelab-desktop/share。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'

export interface ShareMetric {
  label: string
  value: string
  /** 取值语义色：ok / warn / err / 无 */
  tone?: 'ok' | 'warn' | 'err'
  hint?: string
}

export interface ShareCardInput {
  title: string
  subtitle?: string
  chip?: string
  metrics?: ShareMetric[]
  code?: string
  footer?: string
  accent?: string
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderCard(input: ShareCardInput): string {
  const accent = input.accent || '#3b82f6'
  const ts = new Date()
  const stamp = ts.toLocaleString('zh-CN', { hour12: false })
  const metrics = (input.metrics || [])
    .map(
      (m) =>
        `<div class="metric ${m.tone ? 'tone-' + m.tone : ''}">` +
        `<div class="m-label">${esc(m.label)}</div>` +
        `<div class="m-value">${esc(m.value)}</div>` +
        (m.hint ? `<div class="m-hint">${esc(m.hint)}</div>` : '') +
        '</div>'
    )
    .join('')
  const code = input.code
    ? `<pre class="code">${esc(input.code.slice(0, 1200))}</pre>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(input.title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;
       font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8eaed;padding:24px}
  .card{width:520px;max-width:100%;background:linear-gradient(160deg,#171a21 0%,#101318 100%);
        border:1px solid #262b34;border-radius: var(--radius-lg);overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45)}
  .bar{height:6px;background:${accent}}
  .body{padding:22px 24px 20px}
  h1{margin:0 0 6px;font-size:22px;letter-spacing:.3px}
  .sub{color:#9aa3b2;font-size: var(--text-md);margin-bottom:16px}
  .chip{display:inline-block;font-size: var(--text-xs);font-family:ui-monospace,Menlo,Consolas,monospace;
        color:${accent};border:1px solid ${accent}55;border-radius:999px;padding:3px 9px;margin-bottom:14px}
  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:6px 0 14px}
  .metric{background:#14171d;border:1px solid #22262e;border-radius: var(--radius-md);padding:10px 12px}
  .m-label{font-size: var(--text-xs);color:#8b939f}
  .m-value{font-size:17px;font-weight:600;margin-top:3px;word-break:break-all}
  .tone-ok .m-value{color:#4ade80}.tone-warn .m-value{color:#fbbf24}.tone-err .m-value{color:#f87171}
  .m-hint{font-size: var(--text-xs);color:#6f7783;margin-top:2px}
  .code{background:#0c0e12;border:1px solid #22262e;border-radius: var(--radius-md);padding:12px;font-size:11.5px;
        line-height:1.55;white-space:pre-wrap;color:#b6bec9;max-height:220px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace}
  .foot{margin-top:14px;font-size: var(--text-xs);color:#6f7783;display:flex;justify-content:space-between}
</style></head>
<body><div class="card"><div class="bar"></div><div class="body">
  ${input.chip ? `<div class="chip">${esc(input.chip)}</div>` : ''}
  <h1>${esc(input.title)}</h1>
  ${input.subtitle ? `<div class="sub">${esc(input.subtitle)}</div>` : ''}
  ${metrics ? `<div class="metrics">${metrics}</div>` : ''}
  ${code}
  <div class="foot"><span>${esc(input.footer || 'LabCode · 本地生成')}</span><span>${esc(stamp)}</span></div>
</div></div></body></html>`
}

export interface ShareCardResult {
  path: string
  bytes: number
  opened: boolean
}

/** 生成分享卡片 HTML 文件（返回路径，可用系统浏览器打开）。 */
export function buildShareCard(input: ShareCardInput): ShareCardResult {
  const dir = path.join(app.getPath('appData'), 'codelab-desktop', 'share')
  fs.mkdirSync(dir, { recursive: true })
  const slug = (input.title || 'card').replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'card'
  const name = `${Date.now()}-${slug}.html`
  const p = path.join(dir, name)
  const html = renderCard(input)
  fs.writeFileSync(p, html, 'utf-8')
  return { path: p, bytes: Buffer.byteLength(html, 'utf-8'), opened: false }
}

/** 生成并调用系统默认浏览器打开。 */
export async function buildAndOpenShareCard(input: ShareCardInput): Promise<ShareCardResult & { error?: string }> {
  const res = buildShareCard(input)
  try {
    await shell.openPath(res.path)
    return { ...res, opened: true }
  } catch (e) {
    return { ...res, opened: false, error: (e as Error).message }
  }
}

export function listShareCards(limit = 30): Array<{ path: string; name: string; bytes: number; ts: number }> {
  const dir = path.join(app.getPath('appData'), 'codelab-desktop', 'share')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f))
      return { path: path.join(dir, f), name: f, bytes: st.size, ts: st.mtimeMs }
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}
