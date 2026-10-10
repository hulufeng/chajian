import * as fs from 'fs'
import * as path from 'path'

export interface KNode {
  kind: 'menu' | 'config' | 'menuconfig' | 'choice' | 'comment'
  name?: string
  prompt?: string
  type?: string
  help?: string
  depends?: string
  defaults?: string[]
  ranges?: string[]
  select?: string[]
  visibleIf?: string
  children?: KNode[]
  file?: string
}

/**
 * 轻量 Kconfig 解析器：构建菜单树，并捕获每个符号的 prompt / type / help /
 * depends on / default / range / select。支持 menu / menuconfig / config /
 * choice / comment / if，以及 source 包含（按 $(IDF_PATH)/$(COMPONENT_PATH) 等
 * 环境变量解析）。依赖表达式原样保留，供前端计算「可见性」提示。
 *
 * 说明：不求值 Kconfig 预处理宏（$(...)）与条件可见性，仅做静态结构解析。
 */
export function parseKconfig(
  projectPath: string,
  env: Record<string, string>,
  extraSources: string[] = []
): { tree: KNode[] } {
  const roots: KNode[] = []
  const visited = new Set<string>()

  const resolveEnv = (s: string): string =>
    s.replace(/\$\(([^)]+)\)/g, (_, k: string) => env[k] ?? env[k.toLowerCase()] ?? '')

  const propagate = (nodes: KNode[]): void => {
    for (const n of nodes) {
      if (n.children) {
        for (const c of n.children) {
          if (n.depends) c.depends = [c.depends, n.depends].filter(Boolean).join(' && ')
        }
        propagate(n.children)
      }
    }
  }

  const parseFile = (file: string, parent: KNode[]): void => {
    const abs = path.resolve(file)
    if (visited.has(abs) || !fs.existsSync(abs)) return
    visited.add(abs)
    const lines = fs.readFileSync(abs, 'utf-8').split('\n')

    // 合并行尾 '\' 续行
    const joined: string[] = []
    for (const l of lines) {
      if (joined.length && joined[joined.length - 1].endsWith('\\')) {
        joined[joined.length - 1] = joined[joined.length - 1].slice(0, -1) + ' ' + l
      } else {
        joined.push(l)
      }
    }

    interface Scope {
      children: KNode[]
      kind: 'menuconfig' | 'block'
      indent: number
    }
    const stack: Scope[] = [{ children: parent, kind: 'block', indent: -1 }]
    const cur = (): Scope => stack[stack.length - 1]

    let i = 0
    while (i < joined.length) {
      const raw = joined[i]
      const indent = raw.length - raw.trimStart().length
      const trimmed = raw.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        i++
        continue
      }

      // help 块：body 缩进必须严格大于 help 关键字缩进
      if (/^(help|---help---)\s*$/.test(trimmed)) {
        const helpIndent = indent
        let help = ''
        i++
        while (i < joined.length) {
          const hl = joined[i]
          if (hl.trim() === '') {
            help += '\n'
            i++
            continue
          }
          if (hl.length - hl.trimStart().length > helpIndent) {
            help += hl.trim() + '\n'
            i++
          } else {
            break
          }
        }
        const last = cur().children[cur().children.length - 1]
        if (last) last.help = (last.help ? last.help + '\n' : '') + help.trim()
        continue
      }

      const m = trimmed.match(/^(\w+)\s*(.*)$/)
      if (!m) {
        i++
        continue
      }
      const kw = m[1].toLowerCase()
      const rest = m[2]

      // 进入新的块级条目前，按缩进关闭 menuconfig 作用域
      if (['menu', 'menuconfig', 'choice', 'comment', 'config', 'if', 'source', 'rsource', 'osource', 'orsource'].includes(kw)) {
        while (stack.length > 1 && stack[stack.length - 1].kind === 'menuconfig' && indent <= stack[stack.length - 1].indent) {
          stack.pop()
        }
      }

      const unquote = (s: string): string => s.replace(/^"|"$/g, '')

      switch (kw) {
        case 'menu': {
          const node: KNode = { kind: 'menu', prompt: unquote(rest), children: [] }
          cur().children.push(node)
          stack.push({ children: node.children!, kind: 'block', indent })
          i++
          break
        }
        case 'endmenu':
          if (stack.length > 1) stack.pop()
          i++
          break
        case 'menuconfig': {
          const sym = rest.split(/\s+/)[0]
          const node: KNode = { kind: 'menuconfig', name: sym, children: [] }
          const pm = rest.match(/"([^"]+)"/)
          if (pm) node.prompt = pm[1]
          cur().children.push(node)
          stack.push({ children: node.children!, kind: 'menuconfig', indent })
          i++
          break
        }
        case 'config': {
          const sym = rest.split(/\s+/)[0]
          const node: KNode = { kind: 'config', name: sym }
          const pm = rest.match(/"([^"]+)"/)
          if (pm) node.prompt = pm[1]
          cur().children.push(node)
          i++
          break
        }
        case 'choice': {
          const node: KNode = { kind: 'choice', name: rest.split(/\s+/)[0] || undefined, children: [] }
          const pm = rest.match(/"([^"]+)"/)
          if (pm) node.prompt = pm[1]
          cur().children.push(node)
          stack.push({ children: node.children!, kind: 'block', indent })
          i++
          break
        }
        case 'endchoice':
          if (stack.length > 1) stack.pop()
          i++
          break
        case 'if': {
          const node: KNode = { kind: 'menu', prompt: `if ${rest}`, depends: rest.trim() }
          cur().children.push(node)
          stack.push({ children: node.children!, kind: 'block', indent })
          i++
          break
        }
        case 'endif':
          if (stack.length > 1) stack.pop()
          i++
          break
        case 'source':
        case 'rsource':
        case 'osource':
        case 'orsource': {
          const p = resolveEnv(unquote(rest))
          const resolved = path.isAbsolute(p) ? p : path.resolve(path.dirname(abs), p)
          parseFile(resolved, cur().children)
          i++
          break
        }
        case 'comment':
          cur().children.push({ kind: 'comment', prompt: unquote(rest) })
          i++
          break
        case 'bool':
        case 'tristate':
        case 'int':
        case 'hex':
        case 'string': {
          const last = cur().children[cur().children.length - 1]
          if (last && (last.kind === 'config' || last.kind === 'menuconfig' || last.kind === 'choice')) {
            last.type = kw
            const pm = rest.match(/"([^"]+)"/)
            if (pm && !last.prompt) last.prompt = pm[1]
          }
          i++
          break
        }
        case 'prompt': {
          const last = cur().children[cur().children.length - 1]
          if (last) {
            const pm = rest.match(/"([^"]+)"/)
            if (pm) last.prompt = pm[1]
          }
          i++
          break
        }
        case 'default':
        case 'def_bool':
        case 'def_tristate': {
          const last = cur().children[cur().children.length - 1]
          if (last) (last.defaults ||= []).push(rest.trim())
          i++
          break
        }
        case 'range': {
          const last = cur().children[cur().children.length - 1]
          if (last) (last.ranges ||= []).push(rest.trim())
          i++
          break
        }
        case 'select':
        case 'imply': {
          const last = cur().children[cur().children.length - 1]
          if (last) (last.select ||= []).push(rest.trim())
          i++
          break
        }
        case 'depends': {
          const expr = rest.replace(/^on\s+/i, '').trim()
          const last = cur().children[cur().children.length - 1]
          if (last) last.depends = [last.depends, expr].filter(Boolean).join(' && ')
          i++
          break
        }
        case 'visible': {
          const last = cur().children[cur().children.length - 1]
          if (last) last.visibleIf = rest.replace(/^if\s+/i, '').trim()
          i++
          break
        }
        default:
          i++
          break
      }
    }
  }

  parseFile(path.join(projectPath, 'Kconfig'), roots)
  // T3-a：额外源（构建系统生成的聚合 Kconfig / 各组件 Kconfig）走同一 visited 去重，
  // 不会与 project/Kconfig 已 source 的部分重复，但能补全未被工程 Kconfig 直接 source 的符号。
  for (const s of extraSources) {
    if (fs.existsSync(s)) parseFile(s, roots)
  }
  propagate(roots)
  return { tree: roots }
}
