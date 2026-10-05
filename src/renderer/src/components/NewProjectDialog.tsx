import { useEffect, useMemo, useState } from 'react'

export interface ProjectTypeItem {
  id: string
  name: string
  icon: string
  desc: string
  scaffold?: Array<{ file: string; content: string }>
}

const BUILTIN_TYPES: ProjectTypeItem[] = [
  { id: 'arduino', name: 'Arduino', icon: '🔌', desc: '.ino 草图 + LED 闪烁示例' },
  { id: 'python', name: 'Python', icon: '🐍', desc: 'main.py + requirements.txt' },
  { id: 'node', name: 'Node.js', icon: '🟢', desc: 'index.js + package.json' },
  { id: 'cpp', name: 'C/C++', icon: '⚙️', desc: 'main.cpp + CMakeLists.txt' },
  { id: 'rust', name: 'Rust', icon: '🦀', desc: 'main.rs + Cargo.toml' },
  { id: 'generic', name: '通用项目', icon: '📁', desc: 'README + 空目录' },
]

const TYPE_FILES: Record<string, string[]> = {
  arduino: ['{name}.ino', 'README.md'],
  python: ['main.py', 'requirements.txt', 'README.md'],
  node: ['index.js', 'package.json', 'README.md'],
  cpp: ['main.cpp', 'CMakeLists.txt', 'README.md'],
  rust: ['main.rs', 'Cargo.toml', 'README.md'],
  generic: ['README.md', 'main.txt'],
}

interface TemplateItemLike {
  id: string
  name: string
  desc: string
  category: string
}

interface NewProjectDialogProps {
  pluginTypes: ProjectTypeItem[]
  onClose: () => void
  onCreate: (type: string, name: string, scaffold?: Array<{ file: string; content: string }>) => Promise<void>
}

function NewProjectDialog({ pluginTypes, onClose, onCreate }: NewProjectDialogProps): React.JSX.Element {
  const allTypes = useMemo(() => [...BUILTIN_TYPES, ...pluginTypes], [pluginTypes])
  const [type, setType] = useState(allTypes[0]?.id ?? 'python')
  const [name, setName] = useState('my-project')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // 模板 / 示例库（差异化功能 #2）
  const [mode, setMode] = useState<'type' | 'template'>('type')
  const [groups, setGroups] = useState<Array<{ category: string; items: TemplateItemLike[] }>>([])
  const [tplKeyword, setTplKeyword] = useState('')
  const [tplId, setTplId] = useState('')
  const [tplDetail, setTplDetail] = useState<{ files: Array<{ path: string; content: string }> } | null>(null)

  useEffect(() => {
    void window.api.template.groups().then((g) => setGroups(g)).catch(() => setGroups([]))
  }, [])

  const allTemplates = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const filteredTemplates = useMemo(() => {
    const k = tplKeyword.trim().toLowerCase()
    const list = k ? allTemplates.filter((t) => t.name.toLowerCase().includes(k) || t.desc.toLowerCase().includes(k)) : allTemplates
    return list
  }, [allTemplates, tplKeyword])

  useEffect(() => {
    if (tplId && mode === 'template') {
      void window.api.template.get(tplId).then(setTplDetail).catch(() => setTplDetail(null))
    } else {
      setTplDetail(null)
    }
  }, [tplId, mode])

  const selectedTemplate = allTemplates.find((t) => t.id === tplId) || null

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return allTypes
    return allTypes.filter((t) => t.name.toLowerCase().includes(k) || t.id.toLowerCase().includes(k) || t.desc.toLowerCase().includes(k))
  }, [allTypes, keyword])

  const selected = allTypes.find((t) => t.id === type) ?? allTypes[0]
  const previewFiles =
    mode === 'template'
      ? (tplDetail?.files ?? []).map((f) => f.path)
      : selected?.scaffold
        ? selected.scaffold.map((f) => f.file)
        : TYPE_FILES[selected?.id ?? ''] ?? ['README.md']

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setErr('请输入工程名称')
      return
    }
    setBusy(true)
    setErr('')
    try {
      if (mode === 'template' && selectedTemplate) {
        // 模板文件直接作为 scaffold 内容生成，不是占位注释
        const scaffold = (tplDetail?.files ?? []).map((f) => ({ file: f.path, content: f.content }))
        await onCreate('arduino', name.trim(), scaffold)
      } else {
        await onCreate(type, name.trim(), selected?.scaffold)
      }
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">新建工程</div>
        <div className="modal-body">
          <div className="np-tabs">
            <div className={`np-tab ${mode === 'type' ? 'active' : ''}`} onClick={() => setMode('type')}>工程类型</div>
            <div className={`np-tab ${mode === 'template' ? 'active' : ''}`} onClick={() => setMode('template')}>模板 / 示例（{allTemplates.length}）</div>
          </div>
          <div className="np-layout">
            {/* 左侧：搜索 + 类型列表 */}
            <div className="np-left">
              {mode === 'type' && (
                <input
                  className="form-input np-search"
                  placeholder="搜索工程类型…"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              )}
              {mode === 'template' && (
                <input
                  className="form-input np-search"
                  placeholder="搜索模板…（LED / PWM / OLED / WiFi / ADC …）"
                  value={tplKeyword}
                  onChange={(e) => setTplKeyword(e.target.value)}
                />
              )}
              <div className="np-type-list">
                {filtered.map((t) => (
                  <div
                    key={t.id}
                    className={`np-type-item ${type === t.id ? 'active' : ''}`}
                    onClick={() => setType(t.id)}
                  >
                    <span className="np-type-icon">{t.icon}</span>
                    <div className="np-type-info">
                      <div className="np-type-name">{t.name}</div>
                      <div className="np-type-desc">{t.desc}</div>
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && <div className="np-empty">无匹配类型</div>}
              </div>

              {/* 模板列表（按分类分组） */}
              {mode === 'template' && (
                <div className="np-type-list">
                  {filteredTemplates.map((t) => (
                    <div
                      key={t.id}
                      className={`np-type-item ${mode === 'template' && tplId === t.id ? 'active' : ''}`}
                      onClick={() => setTplId(t.id)}
                    >
                      <span className="np-type-icon">🧩</span>
                      <div className="np-type-info">
                        <div className="np-type-name">{t.name}</div>
                        <div className="np-type-desc">{t.desc}</div>
                      </div>
                    </div>
                  ))}
                  {filteredTemplates.length === 0 && <div className="np-empty">无匹配模板</div>}
                </div>
              )}
            </div>

            {/* 右侧：详情预览 + 表单 */}
            <div className="np-right">
              <div className="np-preview">
                <div className="np-preview-title">
                  {selected?.icon} {selected?.name}
                </div>
                <div className="np-preview-desc">
                  {mode === 'template' ? selectedTemplate?.desc ?? '选择左侧模板查看生成内容' : selected?.desc}
                </div>
                <div className="np-preview-files">
                  <div className="np-preview-label">将生成以下文件：</div>
                  {previewFiles.map((f) => (
                    <div key={f} className="np-file-item">📄 {f.replace(/\{name\}/g, name || 'my-project')}</div>
                  ))}
                </div>
                {mode === 'template' && tplDetail?.files && tplDetail.files.length > 0 && (
                  <div className="np-preview-code">
                    {tplDetail.files[0].content.split('\n').slice(0, 14).join('\n')}
                    {tplDetail.files[0].content.split('\n').length > 14 ? '\n…（共 ' + tplDetail.files[0].content.split('\n').length + ' 行）' : ''}
                  </div>
                )}
              </div>

              <div className="form-row">
                <label>工程名称</label>
                <input
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-project"
                  onKeyDown={(e) => e.key === 'Enter' && void submit()}
                />
              </div>
              <div className="form-row">
                <label>创建位置</label>
                <div className="np-location">点击「创建工程」后选择存放目录</div>
              </div>

              {err && <div className="ai-err">{err}</div>}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '创建中…' : mode === 'template' ? '用模板创建' : '创建工程'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default NewProjectDialog
