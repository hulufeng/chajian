import { promises as fsp } from 'node:fs'
import { join, basename, extname, dirname } from 'node:path'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.cache', '.pio', '.vscode', '__pycache__', '.idea'])

const TEXT_EXTS = new Set([
  '.ino', '.cpp', '.c', '.h', '.hpp', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt',
  '.html', '.css', '.scss', '.py', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.csv', '.xml',
  '.sh', '.bat', '.ps1', '.env', '.vue', '.sql', '.java', '.go', '.rs', '.proto', '.prj', '.sln'
])

function isTextFile(name: string): boolean {
  const ext = extname(name).toLowerCase()
  if (ext && TEXT_EXTS.has(ext)) return true
  return ['.gitignore', '.env', 'Dockerfile', 'Makefile', 'CMakeLists.txt', 'platformio.ini', 'README.md'].includes(name)
}

const MAX_DEPTH = 6

async function walk(dir: string, node: TreeNode, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      const child: TreeNode = { name: e.name, path: full, type: 'dir', children: [] }
      node.children!.push(child)
      await walk(full, child, depth + 1)
    } else if (e.isFile() && isTextFile(e.name)) {
      node.children!.push({ name: e.name, path: full, type: 'file' })
    }
  }
  // 空目录不保留 children 数组
  if (node.children && node.children.length === 0) delete node.children
}

export async function listProjectTree(root: string): Promise<TreeNode> {
  const rootNode: TreeNode = { name: basename(root) || root, path: root, type: 'dir', children: [] }
  await walk(root, rootNode, 0)
  if (rootNode.children && rootNode.children.length === 0) delete rootNode.children
  return rootNode
}

export async function readTextFile(path: string): Promise<string> {
  const buf = await fsp.readFile(path)
  // 尝试 UTF-8；含 BOM 则去掉
  let text = buf.toString('utf-8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  await fsp.writeFile(path, content, 'utf-8')
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

export function isImageFile(name: string): boolean {
  return extname(name).toLowerCase() in IMAGE_MIME
}

/** 读图片文件为 dataURL，供编辑器实时预览（限制 25MB） */
export async function readImageAsDataUrl(path: string): Promise<string> {
  const buf = await fsp.readFile(path)
  if (buf.length > 25 * 1024 * 1024) throw new Error('image exceeds 25MB')
  const mime = IMAGE_MIME[extname(path).toLowerCase()] || 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}
