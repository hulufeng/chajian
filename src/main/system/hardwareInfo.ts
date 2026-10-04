import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import fs from 'node:fs'

const execFileAsync = promisify(execFile)

export interface CpuInfo {
  model: string
  cores: number
  threads: number
  architecture: string
  speedMHz: number
}

export interface GpuInfo {
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'unknown'
  vramMB: number
  driverVersion?: string
}

export interface DiskInfo {
  drive: string
  totalGB: number
  freeGB: number
}

export interface HardwareInfo {
  cpu: CpuInfo
  totalRAMGB: number
  gpus: GpuInfo[]
  disks: DiskInfo[]
  os: {
    platform: string
    release: string
    arch: string
  }
  /** 综合评分，用于模型推荐 */
  capability: {
    canRun7B: boolean
    canRun13B: boolean
    canRun34B: boolean
    hasGPU: boolean
    vramGB: number
  }
}

/** 获取 CPU 信息 */
function getCpuInfo(): CpuInfo {
  const cpus = os.cpus()
  const model = cpus[0]?.model || 'Unknown CPU'
  const threads = cpus.length
  // Windows 上物理核心数需要通过 WMI 获取，这里先用线程数估算
  const cores = Math.ceil(threads / 2)
  const speedMHz = cpus[0]?.speed || 0
  return {
    model: model.trim(),
    cores,
    threads,
    architecture: os.arch(),
    speedMHz,
  }
}

/** 通过 PowerShell 获取 GPU 信息（Windows） */
async function getGpuInfoWindows(): Promise<GpuInfo[]> {
  try {
    const psScript = `
      Get-CimInstance Win32_VideoController | ForEach-Object {
        $vram = if ($_.AdapterRAM) { [math]::Round($_.AdapterRAM / 1MB) } else { 0 }
        $vendor = 'unknown'
        if ($_.Name -match 'NVIDIA') { $vendor = 'nvidia' }
        elseif ($_.Name -match 'AMD|Radeon') { $vendor = 'amd' }
        elseif ($_.Name -match 'Intel') { $vendor = 'intel' }
        [PSCustomObject]@{
          Name = $_.Name
          Vendor = $vendor
          VRAM_MB = $vram
          Driver = $_.DriverVersion
        }
      } | ConvertTo-Json -Compress
    `
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command', psScript,
    ], { timeout: 10000 })
    const trimmed = stdout.trim()
    if (!trimmed) return []
    const data = JSON.parse(trimmed)
    const arr = Array.isArray(data) ? data : [data]
    return arr.map((g: { Name: string; Vendor: string; VRAM_MB: number; Driver?: string }) => ({
      name: g.Name,
      vendor: g.Vendor as GpuInfo['vendor'],
      vramMB: g.VRAM_MB || 0,
      driverVersion: g.Driver,
    }))
  } catch {
    return []
  }
}

/** 通过 nvidia-smi 获取 NVIDIA GPU 精确显存 */
async function getNvidiaSmiInfo(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 })
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, vramMB, driver] = line.split(',').map((s) => s.trim())
      return {
        name,
        vendor: 'nvidia' as const,
        vramMB: parseInt(vramMB, 10) || 0,
        driverVersion: driver,
      }
    })
  } catch {
    return []
  }
}

/** 获取磁盘信息 */
function getDiskInfo(): DiskInfo[] {
  const drives: DiskInfo[] = []
  // Windows 盘符从 C 到 Z
  for (let i = 67; i <= 90; i++) {
    const drive = `${String.fromCharCode(i)}:\\`
    try {
      const stats = fs.statSync(drive)
      if (typeof fs.statfsSync === 'function') {
        const info = fs.statfsSync(drive)
        const totalGB = (info.blocks * info.bsize) / (1024 ** 3)
        const freeGB = (info.bavail * info.bsize) / (1024 ** 3)
        drives.push({ drive, totalGB, freeGB })
      }
    } catch {
      // 盘符不存在，跳过
    }
  }
  return drives
}

/** 综合评估硬件能力 */
function evaluateCapability(hw: { totalRAMGB: number; gpus: GpuInfo[] }): HardwareInfo['capability'] {
  const maxVramMB = Math.max(...hw.gpus.map((g) => g.vramMB), 0)
  const vramGB = maxVramMB / 1024
  const hasGPU = hw.gpus.length > 0 && maxVramMB > 0

  // 模型运行内存估算：Q4 量化 7B≈5GB RAM，13B≈8GB，34B≈20GB
  // 有 GPU 时显存可分担
  const effectiveMemGB = hw.totalRAMGB + (hasGPU ? vramGB * 0.5 : 0)

  return {
    canRun7B: effectiveMemGB >= 6,
    canRun13B: effectiveMemGB >= 10,
    canRun34B: effectiveMemGB >= 24,
    hasGPU,
    vramGB,
  }
}

/** 获取完整硬件信息 */
export async function getHardwareInfo(): Promise<HardwareInfo> {
  const cpu = getCpuInfo()
  const totalRAMGB = os.totalmem() / (1024 ** 3)

  // 优先用 nvidia-smi 获取精确信息，回退到 WMI
  let gpus = await getNvidiaSmiInfo()
  if (gpus.length === 0) {
    gpus = await getGpuInfoWindows()
  }

  const disks = getDiskInfo()

  const hw = { totalRAMGB, gpus }
  const capability = evaluateCapability(hw)

  return {
    cpu,
    totalRAMGB: Math.round(totalRAMGB * 10) / 10,
    gpus,
    disks,
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    capability,
  }
}

/** 格式化硬件信息为可读字符串 */
export function formatHardwareInfo(info: HardwareInfo): string {
  const lines = [
    `CPU: ${info.cpu.model} (${info.cpu.cores}核/${info.cpu.threads}线程)`,
    `内存: ${info.totalRAMGB} GB`,
    `GPU: ${info.gpus.length > 0 ? info.gpus.map((g) => `${g.name} (${g.vramMB}MB)`).join(', ') : '无独立显卡'}`,
    `磁盘: ${info.disks.map((d) => `${d.drive} ${d.freeGB.toFixed(1)}GB可用`).join(', ')}`,
    `系统: ${info.os.platform} ${info.os.release} ${info.os.arch}`,
    `能力: 7B=${info.capability.canRun7B ? '✓' : '✗'} 13B=${info.capability.canRun13B ? '✓' : '✗'} 34B=${info.capability.canRun34B ? '✓' : '✗'}`,
  ]
  return lines.join('\n')
}
