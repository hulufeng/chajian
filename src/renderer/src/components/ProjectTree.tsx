import { useState } from 'react'
import { hint } from '../featureHints'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

interface Props {
  root: string | null
  tree: TreeNode | null
  activePath: string | null
  onOpenFile: (path: string, name: string) => void
  onOpenProject: () => void
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--warning)', flexShrink: 0 }}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
      {open && <path d="M2 10h20"/>}
    </svg>
  )
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  let color = 'var(--file-default)'
  if (ext === 'ino' || ext === 'cpp' || ext === 'c') color = 'var(--file-ts)'
  else if (ext === 'md' || ext === 'txt') color = 'var(--file-code)'
  else if (ext === 'json' || ext === 'xml') color = 'var(--file-string)'
  else if (ext === 'py') color = 'var(--file-func)'
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
      <polyline points="14,2 14,8 20,8"/>
    </svg>
  )
}

function DirNode({
  node,
  depth,
  onOpenFile,
  activePath,
}: {
  node: TreeNode
  depth: number
  onOpenFile: (p: string, n: string) => void
  activePath: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(depth === 0)
  const indent = { paddingLeft: depth * 14 + 8 }

  if (node.type === 'dir') {
    return (
      <div>
        <div
          className="tree-item"
          style={indent}
          onClick={() => setOpen(!open)}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5, transform: open ? 'rotate(90deg)' : '', transition: 'transform 0.15s' }}><path d="m9 18 6-6-6-6"/></svg>
          <FolderIcon open={open} />
          <span className="tree-label">{node.name}</span>
        </div>
        {open &&
          node.children
            ?.sort((a, b) => {
              if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((c) => (
              <DirNode key={c.path} node={c} depth={depth + 1} onOpenFile={onOpenFile} activePath={activePath} />
            ))}
      </div>
    )
  }

  return (
    <div
      className={`tree-item file${node.path === activePath ? ' active' : ''}`}
      style={indent}
      onClick={() => onOpenFile(node.path, node.name)}
      title={node.path}
    >
      <span style={{ width: 10, flexShrink: 0 }} />
      <FileIcon name={node.name} />
      <span className="tree-label">{node.name}</span>
    </div>
  )
}

function ProjectTree({ root, tree, activePath, onOpenFile, onOpenProject }: Props): React.JSX.Element {
  return (
    <section className="project-section">
      <div className="section-title">
        <span {...hint('projectTree')}>项目</span>
        <button className="btn small" {...hint('openProject')} onClick={onOpenProject}>
          打开
        </button>
      </div>
      <div className="tree-body">
        {!root && <div className="tree-empty">尚未打开项目<br />点击「打开」选择文件夹</div>}
        {tree && (
          <DirNode node={tree} depth={0} onOpenFile={onOpenFile} activePath={activePath} />
        )}
      </div>
    </section>
  )
}

export default ProjectTree
