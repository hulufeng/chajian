import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { btnPrimary, btnStyle, codeBlock, footerBar, headerBar, input, modalPanel, overlay, toneColor } from './modalStyles'

interface KNode {
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
}

interface Props {
  projectRoot: string
  onClose: () => void
}

/** 本弹窗比通用宽度略宽一点，其余外观全部复用 modalStyles */
const panel: CSSProperties = { ...modalPanel, width: 'min(960px, 94vw)' }

// ---------- 依赖表达式求值（best-effort） ----------
function truthy(v: string | undefined): boolean {
  if (v === undefined) return false
  if (v === 'y' || v === 'm') return true
  if (v === 'n') return false
  return true
}
function symResolve(name: string, vals: Map<string, string>): string | undefined {
  return vals.has(name) ? vals.get(name) : vals.get('CONFIG_' + name)
}
function tokenize(s: string): string[] {
  const out: string[] = []
  const re = /"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*|\d+|\|\||&&|!=|<=|>=|=|<|>|!|\(|\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[0])
  return out
}
function numOf(s: string | undefined): number | null {
  if (s === undefined) return null
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16)
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  return null
}
/** 返回 true/false（可见/隐藏），或 null（含宏，需构建期判定） */
export function evalDepends(expr: string, vals: Map<string, string>): boolean | null {
  if (!expr || !expr.trim()) return true
  if (/\$\(/.test(expr)) return null
  const tokens = tokenize(expr)
  let pos = 0
  const peek = (): string | undefined => tokens[pos]
  const eat = (): string | undefined => tokens[pos++]
  const parseOr = (): boolean => {
    let l = parseAnd()
    while (peek() === '||') {
      eat()
      l = l || parseAnd()
    }
    return l
  }
  const parseAnd = (): boolean => {
    let l = parseNot()
    while (peek() === '&&') {
      eat()
      l = l && parseNot()
    }
    return l
  }
  const parseNot = (): boolean => {
    if (peek() === '!') {
      eat()
      return !parseNot()
    }
    if (peek() === '(') {
      eat()
      const v = parseOr()
      if (peek() === ')') eat()
      return v
    }
    return parseAtom()
  }
  const parseAtom = (): boolean => {
    const t = eat()
    if (t === undefined) return false
    const op = peek()
    if (op === '=' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      eat()
      const right = eat() as string
      const leftVal = symResolve(t, vals)
      const ln = numOf(t) ?? (leftVal !== undefined ? numOf(leftVal) : null)
      const rn = numOf(right)
      if (ln !== null && rn !== null) {
        if (op === '<') return ln < rn
        if (op === '>') return ln > rn
        if (op === '<=') return ln <= rn
        if (op === '>=') return ln >= rn
      }
      const ls = leftVal ?? ''
      const rs = right.replace(/^"|"$/g, '')
      if (op === '=') return ls === rs
      if (op === '!=') return ls !== rs
      return false
    }
    return truthy(symResolve(t, vals))
  }
  try {
    return parseOr()
  } catch {
    return null
  }
}
function referencedSymbols(expr: string | undefined): string[] {
  if (!expr) return []
  const toks = tokenize(expr).filter((t) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(t))
  return Array.from(new Set(toks))
}

/**
 * T3-b：综合「依赖可见性」。优先用后端 kconfiglib 运行时求值结果（visMap，最精确），
 * 否则回退到静态 best-effort 求值（depends on + visible if 都需满足；含宏则视为可见）。
 */
function nodeVisible(
  node: KNode,
  vals: Map<string, string>,
  visMap: Record<string, { visible: boolean; default?: string }>
): boolean {
  if (node.name && visMap[node.name] !== undefined) return visMap[node.name].visible
  const d = evalDepends(node.depends ?? '', vals)
  const v = evalDepends(node.visibleIf ?? '', vals)
  const dOk = d === null ? true : d
  const vOk = v === null ? true : v
  return dOk && vOk
}

function filterTree(nodes: KNode[], q: string): KNode[] {
  if (!q.trim()) return nodes
  const lower = q.toLowerCase()
  const walk = (ns: KNode[]): KNode[] => {
    const out: KNode[] = []
    for (const n of ns) {
      const selfMatch = (n.prompt || n.name || '').toLowerCase().includes(lower)
      const kids = n.children ? walk(n.children) : []
      if (selfMatch || kids.length) out.push({ ...n, children: kids.length ? kids : n.children })
    }
    return out
  }
  return walk(nodes)
}

function findByName(nodes: KNode[], name: string): KNode | null {
  for (const n of nodes) {
    if (n.name === name) return n
    if (n.children) {
      const r = findByName(n.children, name)
      if (r) return r
    }
  }
  return null
}

const ICON: Record<string, string> = { menu: '▸', config: '•', menuconfig: '▾', choice: '◈', comment: '#' }

function TreeNode(props: {
  node: KNode
  depth: number
  pathKey: string
  expanded: Set<string>
  forceOpen: boolean
  selectedKey?: string
  hidden?: Set<string>
  onToggle: (k: string) => void
  onSelect: (n: KNode) => void
}) {
  const { node, depth, pathKey, expanded, forceOpen, selectedKey, hidden, onToggle, onSelect } = props
  const hasChildren = !!node.children && node.children.length > 0
  const open = forceOpen || expanded.has(pathKey)
  const selectable = node.kind === 'config' || node.kind === 'menuconfig' || node.kind === 'choice'
  const label = node.prompt || node.name || ''
  const dimmed = !!hidden && !!node.name && hidden.has(node.name)
  const onClick = (): void => {
    if (hasChildren) onToggle(pathKey)
    if (selectable) onSelect(node)
  }
  return (
    <div>
      <div
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          paddingLeft: 8 + depth * 14,
          cursor: dimmed ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          opacity: dimmed ? 0.4 : 1,
          textDecoration: dimmed ? 'line-through' : 'none',
          color: selectedKey && node.name === selectedKey ? 'var(--success)' : node.kind === 'comment' ? 'var(--text-3)' : 'var(--text)',
          background: selectedKey && node.name === selectedKey ? 'var(--success-soft)' : 'transparent'
        }}
        title={dimmed ? `${node.name || label}（依赖未满足，已被隐藏）` : node.name || label}
      >
        <span style={{ width: 12, color: 'var(--text-3)', flex: '0 0 12px' }}>{hasChildren ? (open ? '▾' : '▸') : ICON[node.kind]}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {node.type && <span style={{ color: 'var(--file-code)', fontSize: 10, flex: '0 0 auto' }}>({node.type})</span>}
      </div>
      {open && hasChildren && (
        <div>
          {node.children!.map((c, j) => (
            <TreeNode
              key={j}
              node={c}
              depth={depth + 1}
              pathKey={`${pathKey}/${j}`}
              expanded={expanded}
              forceOpen={forceOpen}
              selectedKey={selectedKey}
              hidden={hidden}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function KconfigEditor({ projectRoot, onClose }: Props) {
  const [tree, setTree] = useState<KNode[]>([])
  const [items, setItems] = useState<Array<{ key: string; value: string }>>([])
  const [path, setPath] = useState('')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<KNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // T3-b：kconfiglib 运行时求值的（符号 → 可见性/生效默认值）映射；缺失时回退静态求值
  const [visibility, setVisibility] = useState<Record<string, { visible: boolean; default?: string }>>({})

  const values = useMemo(() => new Map(items.map((i) => [i.key, i.value])), [items])

  useEffect(() => {
    Promise.all([
      window.api.espIdf.readSdkconfig(projectRoot),
      window.api.espIdf.kconfigSchema(projectRoot),
      window.api.espIdf.kconfigVisibility(projectRoot).catch(
        () => ({ ok: false } as { ok: boolean; map?: Record<string, { visible: boolean; default?: string }> })
      )
    ])
      .then(([sdk, schema, vis]) => {
        if (sdk.ok && sdk.items) {
          setItems(sdk.items)
          setPath(sdk.path || '')
        } else if (sdk.error) {
          setError(sdk.error)
        }
        if (schema.ok && schema.tree) {
          setTree((schema.tree ?? []) as unknown as KNode[])
        } else if (schema.error && !error) {
          setError(schema.error)
        }
        // T3-b：kconfiglib 运行时可见性（不可用时静默回退静态求值）
        if (vis.ok && vis.map) setVisibility(vis.map)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }, [projectRoot])

  const setItemValue = (key: string, value: string): void => {
    setItems((it) => {
      const idx = it.findIndex((x) => x.key === key)
      if (idx >= 0) {
        const copy = it.slice()
        copy[idx] = { key, value }
        return copy
      }
      return [...it, { key, value }]
    })
  }

  const toggle = (k: string): void => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }

  const filtered = useMemo(() => filterTree(tree, filter), [tree, filter])
  // T3-b：被隐藏（依赖 / visible if 不满足）的可配置节点集合，用于菜单树灰显
  const hidden = useMemo(() => {
    const set = new Set<string>()
    const walk = (ns: KNode[]): void => {
      for (const n of ns) {
        if (n.name && (n.kind === 'config' || n.kind === 'menuconfig' || n.kind === 'choice' || n.kind === 'menu')) {
          if (!nodeVisible(n, values, visibility)) set.add(n.name)
        }
        if (n.children) walk(n.children)
      }
    }
    walk(tree)
    return set
  }, [tree, values, visibility])
  const visible = selected ? nodeVisible(selected, values, visibility) : null

  const save = (): void => {
    window.api.espIdf
      .writeSdkconfig(path, items)
      .then((r) => {
        if (r.ok) onClose()
        else setError(r.error || '保存失败')
      })
      .catch((e) => setError(String(e)))
  }

  const selKey = selected?.name
  const selItem = selected?.name ? items.find((i) => i.key === 'CONFIG_' + selected.name) : undefined
  const selValue = selItem?.value ?? (selected?.type === 'bool' || selected?.type === 'tristate' ? 'n' : '')

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={headerBar}>
          <strong style={{ flex: '0 0 auto' }}>Kconfig 配置（菜单树 + 依赖提示）</strong>
          <input
            style={{ ...input, flex: 1, minWidth: 0 }}
            placeholder="过滤菜单/符号…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button style={btnStyle} onClick={onClose}>✕</button>
        </div>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 340, borderRight: '1px solid var(--border)', overflow: 'auto', padding: '6px 0' }}>
            {loading && <div style={{ padding: 12 }}>加载 schema 与 sdkconfig…</div>}
            {error && !tree.length && <div style={{ padding: 12, color: 'var(--error)' }}>{error}</div>}
            {!loading &&
              filtered.map((n, i) => (
                <TreeNode
                  key={i}
                  node={n}
                  depth={0}
                  pathKey={String(i)}
                  expanded={expanded}
                  forceOpen={!!filter.trim()}
                  selectedKey={selKey}
                  hidden={hidden}
                  onToggle={toggle}
                  onSelect={setSelected}
                />
              ))}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
            {loading && <div>读取中…</div>}
            {error && !tree.length && <div style={{ color: 'var(--error)' }}>{error}</div>}
            {!loading && !selected && tree.length > 0 && (
              <div style={{ color: 'var(--text-3)' }}>从左侧菜单树选择一个配置项进行查看 / 编辑。</div>
            )}
            {selected && (
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{selected.prompt || selected.name}</div>
                {selected.name && <code style={{ color: 'var(--accent)', fontSize: 12 }}>CONFIG_{selected.name}</code>}
                {selected.type && <span style={{ marginLeft: 8, color: 'var(--file-code)', fontSize: 12 }}>类型：{selected.type}</span>}
                {selected.kind === 'comment' && <p style={{ color: 'var(--text-2)' }}>{selected.prompt}</p>}

                {(selected.kind === 'config' || selected.kind === 'menuconfig' || selected.kind === 'choice') && selected.name && (
                  <div style={{ margin: '10px 0' }}>
                    <div style={{ color: 'var(--accent)', marginBottom: 4 }}>当前值</div>
                    {selected.type === 'bool' ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={selValue === 'y'} onChange={(e) => setItemValue('CONFIG_' + selected.name!, e.target.checked ? 'y' : 'n')} />
                        <span>{selValue === 'y' ? 'y（启用）' : 'n（禁用）'}</span>
                      </label>
                    ) : selected.type === 'tristate' ? (
                      <select value={selValue} onChange={(e) => setItemValue('CONFIG_' + selected.name!, e.target.value)} style={input}>
                        <option value="y">y（编译进内核）</option>
                        <option value="m">m（编译为模块）</option>
                        <option value="n">n（禁用）</option>
                      </select>
                    ) : (
                      <input style={input} value={selValue} onChange={(e) => setItemValue('CONFIG_' + selected.name!, e.target.value)} placeholder="值" />
                    )}
                    {!selItem && <div style={{ color: 'var(--warning)', fontSize: 11, marginTop: 4 }}>该符号尚未写入 sdkconfig，保存时将新增。</div>}
                  </div>
                )}

                {selected.help && (
                  <div style={{ margin: '10px 0' }}>
                    <div style={{ color: 'var(--accent)', marginBottom: 4 }}>帮助</div>
                    <pre style={codeBlock}>{selected.help}</pre>
                  </div>
                )}

                {selected.name && visibility[selected.name]?.default !== undefined && (
                  <div style={{ margin: '10px 0' }}>
                    <div style={{ color: 'var(--accent)', marginBottom: 4 }}>生效默认值（kconfiglib 运行时求值）</div>
                    <div style={{ fontSize: 12 }}><code>{visibility[selected.name]!.default || '(空)'}</code></div>
                  </div>
                )}

                {selected.depends && (
                  <div style={{ margin: '10px 0' }}>
                    <div style={{ color: 'var(--accent)', marginBottom: 4 }}>依赖（depends on）</div>
                    <code style={{ fontSize: 12 }}>{selected.depends}</code>
                    <div style={{ marginTop: 6 }}>
                      {visible === null ? (
                        <span style={{ color: 'var(--warning)', fontSize: 12 }}>⚑ 含构建期宏，无法静态判定可见性</span>
                      ) : visible ? (
                        <span style={{ color: toneColor('ok'), fontSize: 12 }}>✓ 当前依赖满足，符号可见</span>
                      ) : (
                        <span style={{ color: toneColor('err'), fontSize: 12 }}>⚠ 依赖未满足，在 menuconfig 中会被隐藏</span>
                      )}
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {referencedSymbols(selected.depends ?? '').map((s) => (
                        <span
                          key={s}
                          onClick={() => {
                            const n = findByName(tree, s)
                            if (n) setSelected(n)
                          }}
                          style={{ fontSize: 11, background: 'var(--surface-3)', color: 'var(--accent)', padding: '1px 6px', borderRadius: 'var(--radius-2xs)', cursor: 'pointer' }}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {selected.defaults && selected.defaults.length > 0 && (
                  <div style={{ margin: '10px 0' }}>
                    <div style={{ color: 'var(--accent)', marginBottom: 4 }}>默认值</div>
                    {selected.defaults.map((d, i) => (
                      <div key={i} style={{ fontSize: 12 }}><code>{d}</code></div>
                    ))}
                  </div>
                )}
                {selected.ranges && selected.ranges.length > 0 && (
                  <div style={{ margin: '10px 0' }}>
                    <div style={{ color: 'var(--accent)', marginBottom: 4 }}>取值范围</div>
                    {selected.ranges.map((r, i) => (
                      <div key={i} style={{ fontSize: 12 }}><code>{r}</code></div>
                    ))}
                  </div>
                )}
                {selected.select && selected.select.length > 0 && (
                  <div style={{ margin: '10px 0' }}>
                    <div style={{ color: 'var(--accent)', marginBottom: 4 }}>反向选择（select）</div>
                    {selected.select.map((s, i) => (
                      <div key={i} style={{ fontSize: 12 }}><code>{s}</code></div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div style={footerBar}>
          <button style={btnStyle} onClick={onClose}>取消</button>
          <button style={btnPrimary} onClick={save}>保存配置</button>
        </div>
      </div>
    </div>
  )
}
