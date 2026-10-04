import { spawn, execSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'

// ── 常量 ──────────────────────────────────────────────────────
const LLAMA_HOST = '127.0.0.1'
const LLAMA_PORT = 8080

// llama.cpp 引擎（CPU 版，MIT 许可可商用闭源；经 gh-proxy 镜像下载）
const LLAMA_CPP_TAG = 'b11146'
const LLAMA_CPP_URL = `https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_TAG}/llama-${LLAMA_CPP_TAG}-bin-win-cpu-x64.zip`
// GGUF 模型直链（hf-mirror 国内可达；Qwen2.5 系列 Apache-2.0 可商用）
const HF_MIRROR = 'https://hf-mirror.com'

// ── 引擎目录探测（CodeLab 移植）────────────────────────────────
function getEngineDir(): string {
  const candidates: string[] = [
    // 打包后：resources/llama
    path.join(process.resourcesPath || '', 'llama'),
    // 开发时：desktop-app/resources/llama
    path.join(app.getAppPath(), 'resources', 'llama'),
    path.join(process.cwd(), 'resources', 'llama'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'llama-server.exe'))) return c
    } catch { /* ignore */ }
  }
  return ''
}

function getModelsDir(): string {
  const dir = path.join(app.getPath('appData'), 'codelab-desktop', 'models')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── 引擎自动下载（无需安装 Ollama / llama.cpp）────────────────
function getEngineDirCandidates(): string[] {
  return [
    path.join(process.resourcesPath || '', 'llama'),
    path.join(app.getAppPath(), 'resources', 'llama'),
    path.join(process.cwd(), 'resources', 'llama'),
  ]
}

/** 引擎安装目录（第一个可用/可写的候选） */
function resolveEngineDir(): string {
  const candidates = getEngineDirCandidates()
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true })
      return c
    } catch { /* 只读则试下一个 */ }
  }
  return candidates[1]
}

/** 通用文件下载（支持进度回调 + 跟随重定向） */
function downloadFile(url: string, destPath: string, onProgress?: (downloadedMB: number, totalMB: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doGet = (u: string, redirectsLeft: number) => {
      const parsed = new URL(u)
      const client = parsed.protocol === 'https:' ? https : http
      client.get(u, (res) => {
        // 跟随 3xx 重定向（hf-mirror 会跳到 CDN）
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume()
          const next = new URL(res.headers.location, u).toString()
          doGet(next, redirectsLeft - 1)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${res.statusCode}`))
          return
        }
        const file = fs.createWriteStream(destPath)
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total > 0) onProgress?.(Math.round(downloaded / (1024 * 1024)), Math.round(total / (1024 * 1024)))
        })
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
        file.on('error', (e) => { res.destroy(); reject(e) })
      }).on('error', (e) => {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
        reject(e)
      })
    }
    doGet(url, 5)
  })
}

/** 解压 zip → 定位 llama-server.exe 所在目录并平铺到引擎根目录（Windows 自带 tar 支持 zip） */
async function extractEngineZip(zipPath: string, engineDir: string): Promise<void> {
  const tmp = path.join(path.dirname(zipPath), `llama-extract-${Date.now()}`)
  fs.mkdirSync(tmp, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xf', zipPath, '-C', tmp], { windowsHide: true })
    tar.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`解压失败: tar exit ${code}`)))
    tar.on('error', reject)
  })
  // 在解压树里找 llama-server.exe，把所在目录全部平铺到引擎根
  let srcRoot = tmp
  const walk = (dir: string): boolean => {
    if (fs.existsSync(path.join(dir, 'llama-server.exe'))) { srcRoot = dir; return true }
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory() && walk(path.join(dir, ent.name))) return true
    }
    return false
  }
  if (!walk(tmp)) throw new Error('压缩包内未找到 llama-server.exe')
  for (const ent of fs.readdirSync(srcRoot)) {
    fs.copyFileSync(path.join(srcRoot, ent), path.join(engineDir, ent))
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

/**
 * 确保 llama-server 引擎已安装（缺失时自动下载解压，约 18MB）
 */
export async function ensureEngine(onProgress?: (p: { status: string; percent: number }) => void): Promise<{ success: boolean; error?: string }> {
  if (getEngineDir()) return { success: true }
  const engineDir = resolveEngineDir()
  const zipPath = path.join(app.getPath('temp'), `llama-${LLAMA_CPP_TAG}-win-cpu-x64.zip`)
  try {
    onProgress?.({ status: 'downloading-engine', percent: 1 })
    await downloadFile(LLAMA_CPP_URL, zipPath, (d, t) => {
      onProgress?.({ status: 'downloading-engine', percent: Math.min(90, Math.round((d / t) * 100)) })
    })
    onProgress?.({ status: 'extracting-engine', percent: 95 })
    await extractEngineZip(zipPath, engineDir)
    fs.unlinkSync(zipPath)
    if (!getEngineDir()) return { success: false, error: '引擎解压后未找到 llama-server.exe' }
    onProgress?.({ status: 'engine-ready', percent: 100 })
    return { success: true }
  } catch (e) {
    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    return { success: false, error: `引擎下载失败: ${(e as Error).message}` }
  }
}

export interface EngineStatus {
  installed: boolean
  running: boolean
  version: string
  engineDir: string
}

export async function getEngineStatus(): Promise<EngineStatus> {
  const dir = getEngineDir()
  let version = ''
  if (dir) {
    try {
      const r = execSync(`"${path.join(dir, 'llama-server.exe')}" --version`, { encoding: 'utf-8', timeout: 5000 })
      version = (r || '').split('\n')[0].trim().slice(0, 60)
    } catch { /* ignore */ }
  }
  return { installed: !!dir, running: await isEngineRunning(), version, engineDir: dir }
}

// ── 内存档位（CodeLab 移植）───────────────────────────────────
function getTotalMemGB(): number {
  return os.totalmem() / (1024 ** 3)
}

function getGPUOffloadLayers(): number {
  const gb = getTotalMemGB()
  if (gb >= 8) return 99   // 全层 GPU
  return 0                  // 纯 CPU
}

function getContextSize(): number {
  const gb = getTotalMemGB()
  if (gb < 3) return 4096
  if (gb < 8) return 8192
  return 16384
}

// ── 引擎进程管理 ───────────────────────────────────────────────
let engineProcess: ChildProcess | null = null
let currentEngineModel = ''

async function isEngineRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${LLAMA_HOST}:${LLAMA_PORT}/health`, { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200)
      res.resume()
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function killEngine(): void {
  try { execSync('taskkill /IM llama-server.exe /F', { stdio: 'ignore' }) } catch { /* ignore */ }
  if (engineProcess) {
    try { engineProcess.kill() } catch { /* ignore */ }
    engineProcess = null
  }
  currentEngineModel = ''
}

/** 启动 llama-server 引擎，加载指定模型文件 */
export async function startLlamaEngine(modelFile?: string): Promise<{ success: boolean; error?: string; model?: string }> {
  if (await isEngineRunning() && currentEngineModel) {
    return { success: true, model: currentEngineModel }
  }

  killEngine()
  await new Promise((r) => setTimeout(r, 800))

  // 引擎缺失 → 自动下载 llama.cpp（无需用户安装 Ollama）
  if (!getEngineDir()) {
    const eng = await ensureEngine()
    if (!eng.success) return { success: false, error: eng.error || '引擎下载失败' }
  }

  const engineDir = getEngineDir()
  if (!engineDir) return { success: false, error: '引擎文件缺失: resources/llama/llama-server.exe' }
  const serverExe = path.join(engineDir, 'llama-server.exe')
  if (!fs.existsSync(serverExe)) return { success: false, error: 'llama-server.exe 不存在' }

  // 找模型文件
  const modelsDir = getModelsDir()
  let modelPath = ''
  if (modelFile) modelPath = path.join(modelsDir, modelFile)
  if (!fs.existsSync(modelPath)) {
    const models = scanGguufModels()
    if (models.length > 0) modelPath = path.join(modelsDir, models[0].file)
  }
  if (!fs.existsSync(modelPath)) {
    return { success: false, error: '未找到 .gguf 模型文件，请先在设置中下载模型' }
  }

  console.log(`[llama] 启动: ${serverExe} -m ${path.basename(modelPath)} -ngl ${getGPUOffloadLayers()} -c ${getContextSize()}`)

  engineProcess = spawn(serverExe, [
    '-m', modelPath,
    '--host', LLAMA_HOST,
    '--port', String(LLAMA_PORT),
    '-ngl', String(getGPUOffloadLayers()),
    '-c', String(getContextSize()),
    '--jinja',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  engineProcess.stdout?.on('data', (d) => {
    const s = String(d)
    if (s.includes('listening') || s.includes('HTTP')) console.log('[llama] 引擎已就绪')
  })
  engineProcess.stderr?.on('data', (d) => console.error('[llama]', String(d).slice(0, 300)))
  engineProcess.on('exit', () => { engineProcess = null; currentEngineModel = '' })

  // 轮询等待引擎就绪（最多 60 秒）
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await isEngineRunning()) {
      currentEngineModel = path.basename(modelPath)
      return { success: true, model: currentEngineModel }
    }
  }
  return { success: false, error: '引擎启动超时（模型加载慢或内存不足）' }
}

export function stopLlamaEngine(): void {
  killEngine()
}

export function getRunningModel(): string {
  return currentEngineModel
}

// ── 模型目录（GGUF 扫描）─────────────────────────────────────
export interface ModelInfo {
  id: string
  name: string
  sizeGB: number
  quantization: string
  parameters: string
  modifiedAt?: string
}

interface ScannedModel {
  file: string
  name: string
  sizeGB: number
}

function scanGguufModels(): ScannedModel[] {
  const dir = getModelsDir()
  const models: ScannedModel[] = []
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.toLowerCase().endsWith('.gguf')) {
          const full = path.join(dir, f)
          const stat = fs.statSync(full)
          models.push({
            file: f,
            name: friendlyName(f),
            sizeGB: Math.round((stat.size / (1024 ** 3)) * 10) / 10,
          })
        }
      }
    }
  } catch { /* ignore */ }
  return models
}

function friendlyName(f: string): string {
  const base = f.replace(/\.gguf$/i, '')
  const lower = base.toLowerCase()
  if (lower.includes('qwen2.5-coder-1.5b')) return 'Qwen2.5 Coder 1.5B'
  if (lower.includes('qwen2.5-coder-3b')) return 'Qwen2.5 Coder 3B'
  if (lower.includes('qwen2.5-coder-7b')) return 'Qwen2.5 Coder 7B'
  if (lower.includes('qwen2.5-1.5b')) return 'Qwen2.5 1.5B'
  if (lower.includes('minicpm5-1b')) return 'MiniCPM5 1B'
  if (lower.includes('minicpm5-2b')) return 'MiniCPM5 2B'
  if (lower.includes('qwen3.5-4b')) return 'Qwen3.5 4B'
  if (lower.includes('qwen3.5-9b')) return 'Qwen3.5 9B'
  return base
}

/** 列出本地已下载的 GGUF 模型 */
export async function listLocalModels(): Promise<ModelInfo[]> {
  return scanGguufModels().map((m) => ({
    id: m.file,
    name: m.name,
    sizeGB: m.sizeGB,
    quantization: 'Q4_K_M',
    parameters: m.name.match(/(\d+\.?\d*B)/)?.[1] || 'unknown',
  }))
}

// ── 模型目录（推荐用）─────────────────────────────────────────
export interface ModelDefinition {
  id: string
  name: string
  displayName: string
  description: string
  parameters: string
  quantization: string
  sizeGB: number
  minRAMGB: number
  minVRAMGB: number
  /** GGUF 下载 URL（hf-mirror 直链，国内可达） */
  ggufUrl: string
  /** 本地文件名（下载后） */
  ggufFile: string
  /** 兼容旧 UI：= id（原 Ollama tag 语义） */
  ollamaTag: string
  category: 'coding' | 'general' | 'chat' | 'vision'
  tier: 'S' | 'M' | 'L' | 'XL'
  recommended?: boolean
  icon: string
}

export const MODEL_CATALOG: ModelDefinition[] = [
  // S 档：<8GB 内存
  {
    id: 'qwen2.5-coder-1.5b',
    name: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    displayName: 'Qwen2.5 Coder 1.5B',
    description: '通义千问代码专用，15亿参数，1.1GB 体积，4GB 内存可跑，Apache 2.0 可商用',
    parameters: '1.5B',
    quantization: 'Q4_K_M',
    sizeGB: 1.1,
    minRAMGB: 4,
    minVRAMGB: 0,
    ggufUrl: `${HF_MIRROR}/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`,
    ggufFile: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    ollamaTag: 'qwen2.5-coder-1.5b',
    category: 'coding',
    tier: 'S',
    icon: '⚡',
  },
  {
    id: 'qwen2.5-1.5b',
    name: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    displayName: 'Qwen2.5 1.5B',
    description: '通义千问通用对话，15亿参数，1.1GB 体积，2GB 内存可跑，Apache 2.0 可商用',
    parameters: '1.5B',
    quantization: 'Q4_K_M',
    sizeGB: 1.1,
    minRAMGB: 2,
    minVRAMGB: 0,
    ggufUrl: `${HF_MIRROR}/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf`,
    ggufFile: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    ollamaTag: 'qwen2.5-1.5b',
    category: 'general',
    tier: 'S',
    icon: '🔹',
  },
  // M 档：8-16GB
  {
    id: 'qwen2.5-coder-3b',
    name: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    displayName: 'Qwen2.5 Coder 3B',
    description: '通义千问代码专用，30亿参数，2.1GB 体积，6GB 内存可跑，Apache 2.0 可商用',
    parameters: '3B',
    quantization: 'Q4_K_M',
    sizeGB: 2.1,
    minRAMGB: 6,
    minVRAMGB: 2,
    ggufUrl: `${HF_MIRROR}/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf`,
    ggufFile: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    ollamaTag: 'qwen2.5-coder-3b',
    category: 'coding',
    tier: 'M',
    icon: '🐍',
  },
]

// ── 模型下载（断点续传 + 重定向 + 完整性校验）────────────────
export function resumableDownload(
  url: string,
  destPath: string,
  onProgress?: (p: { status: string; percent: number; downloadedMB: number; totalMB: number }) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const MAX_ATTEMPTS = 3
    const attempt = (currentUrl: string, redirectsLeft: number, tryNo: number) => {
      const partial = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0
      const headers: Record<string, string> = partial > 0 ? { Range: `bytes=${partial}-` } : {}
      const u = new URL(currentUrl)
      const client = u.protocol === 'https:' ? https : http
      client.get(currentUrl, { headers }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume()
          const next = new URL(res.headers.location, currentUrl).toString()
          attempt(next, redirectsLeft - 1, tryNo)
          return
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          reject(new Error(`下载失败: HTTP ${res.statusCode}`))
          return
        }
        // content-range: bytes 203-1065/1066 → total 用斜杠后值
        let total = parseInt(res.headers['content-length'] || '0', 10)
        const cr = res.headers['content-range']
        if (typeof cr === 'string' && cr.includes('/')) {
          const t = parseInt(cr.split('/')[1], 10)
          if (!Number.isNaN(t)) total = t
        }
        const resumed = res.statusCode === 206
        if (resumed && partial > 0) total = Math.max(total, partial)
        const file = fs.createWriteStream(destPath, { flags: resumed ? 'a' : 'w' })
        let downloaded = resumed ? partial : 0
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total > 0) {
            onProgress?.({
              status: 'downloading',
              percent: Math.min(99, Math.round((downloaded / total) * 100)),
              downloadedMB: Math.round(downloaded / (1024 * 1024)),
              totalMB: Math.round(total / (1024 * 1024)),
            })
          }
        })
        res.pipe(file)
        let settled = false
        file.on('finish', () => {
          file.close()
          const size = fs.statSync(destPath).size
          if (total > 0 && size < total) {
            // 断流：保留部分文件，重试续传
            if (tryNo < MAX_ATTEMPTS) {
              setTimeout(() => attempt(url, 5, tryNo + 1), 800)
              return
            }
            settled = true
            reject(new Error(`下载中断: ${Math.round(size / (1024 * 1024))}/${Math.round(total / (1024 * 1024))}MB，可再次点击下载续传`))
            return
          }
          settled = true
          resolve()
        })
        res.on('error', () => {
          try { file.destroy() } catch { /* ignore */ }
          if (!settled && tryNo < MAX_ATTEMPTS) {
            setTimeout(() => attempt(url, 5, tryNo + 1), 800)
          } else if (!settled) {
            settled = true
            reject(new Error('下载连接中断'))
          }
        })
        file.on('error', (e) => {
          settled = true
          reject(e)
        })
      }).on('error', (e) => {
        if (tryNo < MAX_ATTEMPTS) setTimeout(() => attempt(url, 5, tryNo + 1), 800)
        else reject(e)
      })
    }
    attempt(url, 5, 1)
  })
}

export function downloadModel(
  modelId: string,
  onProgress?: (p: { status: string; percent: number; downloadedMB: number; totalMB: number }) => void,
): Promise<void> {
  const def = MODEL_CATALOG.find((m) => m.id === modelId)
  if (!def) return Promise.reject(new Error(`未知模型: ${modelId}`))
  if (!def.ggufUrl) return Promise.reject(new Error('模型下载地址未配置'))
  return resumableDownload(def.ggufUrl, path.join(getModelsDir(), def.ggufFile), onProgress)
}

/** 删除本地模型 */
export async function deleteModel(fileName: string): Promise<boolean> {
  try {
    const p = path.join(getModelsDir(), fileName)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      return true
    }
  } catch { /* ignore */ }
  return false
}

// ── OpenAI 兼容聊天（llama-server /v1/chat/completions）──────
function safeParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

export interface LocalStreamChunk {
  type: 'content' | 'tool_call_start' | 'tool_call_args'
  text?: string
  id?: string
  name?: string
}

export function chatWithLocalModelStream(
  model: string,
  messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }>,
  onChunk: (chunk: LocalStreamChunk) => void,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  return new Promise(async (resolve, reject) => {
    // 确保引擎在跑
    const engine = await startLlamaEngine(model)
    if (!engine.success) {
      reject(new Error(engine.error || '引擎启动失败'))
      return
    }

    const body = JSON.stringify({
      model: 'local-model',
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
      max_tokens: 16384,
      temperature: 0.3,
    })

    const req = http.request({
      host: LLAMA_HOST,
      port: LLAMA_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let fullText = ''
      let buf = ''
      let usage: { inputTokens: number; outputTokens: number } | null = null
      const activeToolCalls = new Map<string, { name: string; args: string }>()

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            resolve({ text: fullText, usage: usage || { inputTokens: 0, outputTokens: 0 } })
            return
          }
          try {
            const msg = JSON.parse(data)
            // token 用量：优先 OpenAI 兼容 usage；llama-server 流式不带 usage，用 timings(prompt_n/predicted_n)
            if (msg.usage && (msg.usage.prompt_tokens !== undefined || msg.usage.completion_tokens !== undefined)) {
              usage = { inputTokens: Number(msg.usage.prompt_tokens) || 0, outputTokens: Number(msg.usage.completion_tokens) || 0 }
            } else if (msg.timings && msg.timings.prompt_n !== undefined) {
              usage = { inputTokens: Number(msg.timings.prompt_n) || 0, outputTokens: Number(msg.timings.predicted_n) || 0 }
            }
            const delta = msg.choices?.[0]?.delta
            if (delta?.content) {
              fullText += delta.content
              onChunk({ type: 'content', text: delta.content })
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const tcId = tc.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                const name = tc.function?.name
                const args = tc.function?.arguments
                if (name && !activeToolCalls.has(tcId)) {
                  activeToolCalls.set(tcId, { name, args: '' })
                  onChunk({ type: 'tool_call_start', id: tcId, name })
                }
                if (args) {
                  const argsStr = typeof args === 'string' ? args : JSON.stringify(args)
                  const entry = activeToolCalls.get(tcId)
                  if (entry) {
                    entry.args += argsStr
                    onChunk({ type: 'tool_call_args', id: tcId, text: argsStr })
                  }
                }
              }
            }
          } catch { /* ignore partial JSON */ }
        }
      })
      res.on('end', () => resolve({ text: fullText, usage: usage || { inputTokens: 0, outputTokens: 0 } }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** 兼容旧 IPC：简单聊天（非流式） */
export function chatWithLocalModel(
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk?: (text: string) => void,
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const engine = await startLlamaEngine(model)
    if (!engine.success) { reject(new Error(engine.error || '引擎启动失败')); return }

    const body = JSON.stringify({
      model: 'local-model',
      messages,
      stream: !!onChunk,
      max_tokens: 4096,
      temperature: 0.3,
    })

    const req = http.request({
      host: LLAMA_HOST, port: LLAMA_PORT,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let fullText = ''
      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const d = t.slice(5).trim()
          if (d === '[DONE]') { resolve(fullText); return }
          try {
            const msg = JSON.parse(d)
            const c = msg.choices?.[0]?.delta?.content || msg.choices?.[0]?.message?.content
            if (c) { fullText += c; onChunk?.(c) }
          } catch { /* ignore */ }
        }
      })
      res.on('end', () => resolve(fullText))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** 兼容性保留（旧接口） */
export async function isOllamaInstalled(): Promise<boolean> {
  return !!getEngineDir()
}
export async function isOllamaRunning(): Promise<boolean> {
  return isEngineRunning()
}
export function startOllama(): ChildProcess | null {
  return null // 内置引擎自动管理
}
export function pullModel(tag: string, onProgress?: (p: { status: string; percent: number; downloadedMB: number; totalMB: number }) => void): Promise<void> {
  return downloadModel(tag, onProgress)
}

// ── 硬件档位 ──────────────────────────────────────────────────
export function detectHardwareTier(capability: { totalRAMGB: number; hasGPU: boolean; vramGB: number }): 'S' | 'M' | 'L' | 'XL' {
  const { totalRAMGB, hasGPU, vramGB } = capability
  if (hasGPU && totalRAMGB >= 24 && vramGB >= 8) return 'XL'
  if (totalRAMGB >= 16) return 'L'
  if (totalRAMGB >= 8) return 'M'
  return 'S'
}

export function recommendModels(capability: { totalRAMGB: number; hasGPU: boolean; vramGB: number }): ModelDefinition[] {
  const tier = detectHardwareTier(capability)
  return MODEL_CATALOG.map((m) => ({ ...m, recommended: m.tier === tier }))
}
