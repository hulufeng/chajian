import { app } from 'electron'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 用户数据目录下持久化的运行配置（设备上下文、附加板卡地址、MCP 服务器等） */
function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): Record<string, unknown> {
  try {
    const p = settingsPath()
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
  } catch {
    /* 忽略损坏配置 */
  }
  return {}
}

export function writeSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const cur = readSettings()
  const next = { ...cur, ...patch }
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    /* 忽略写失败 */
  }
  return next
}
