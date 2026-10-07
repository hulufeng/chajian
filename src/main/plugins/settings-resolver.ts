// {settings.*} 占位符注入：manifest / 工具绑定里的 `{settings.key}` 在加载时替换为用户设置值。
// 密钥不硬编码、不随包分发；仓库只写占位符，运行时由宿主注入。
import { readSettings } from '../settings'

const SETTINGS_RE = /\{settings\.([a-zA-Z0-9_.\-]+)\}/g

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * 递归把 value 里所有 `{settings.key}` 替换为 readSettings() 中对应值。
 * 找不到的占位符替换为空串（不抛、不保留原占位符，避免密钥名泄漏到日志）。
 */
export function resolvePlaceholders<T>(value: T, settings?: Record<string, unknown>): T {
  const s = settings ?? readSettings()
  if (typeof value === 'string') {
    if (!value.includes('{settings.')) return value
    return value.replace(SETTINGS_RE, (_m, key: string) => {
      const v = getPath(s, key)
      return v === undefined || v === null ? '' : String(v)
    }) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((x) => resolvePlaceholders(x, s)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolvePlaceholders(v, s)
    }
    return out as unknown as T
  }
  return value
}
