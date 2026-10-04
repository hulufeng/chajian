import { useEffect, useState, useRef, useCallback } from 'react'

interface CommandInfo {
  plugin: string
  id: string
  title: string
  icon?: string
  kind: string
  view?: string
  placement?: string
  when?: string
  transport?: string
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onExecute: (cmd: CommandInfo) => void
}

function CommandPalette({ open, onClose, onExecute }: CommandPaletteProps): React.JSX.Element | null {
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      window.api.plugin.commands()
        .then((cmds) => setCommands(cmds as CommandInfo[]))
        .catch(() => setCommands([]))
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const filtered = commands.filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase()) ||
    c.id.toLowerCase().includes(query.toLowerCase()) ||
    c.plugin.toLowerCase().includes(query.toLowerCase())
  )

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selected]) {
        onExecute(filtered[selected])
        onClose()
      }
    }
  }, [filtered, selected, onClose, onExecute])

  if (!open) return null

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-input"
          placeholder="输入命令名搜索… (↑↓ 选择，Enter 执行，Esc 关闭)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
          onKeyDown={handleKeyDown}
        />
        <div className="command-list">
          {filtered.length === 0 && (
            <div className="command-empty">无匹配命令</div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`command-item ${i === selected ? 'active' : ''}`}
              onClick={() => { onExecute(cmd); onClose() }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="command-icon">{cmd.icon || '⌘'}</span>
              <span className="command-title">{cmd.title}</span>
              <span className="command-plugin">{cmd.plugin}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
