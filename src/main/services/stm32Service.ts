import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface Stm32Status {
  available: boolean
  version: string
  programmer: string | null
  armGcc: string | null
}

const WIN = process.platform === 'win32'

function stm32ProgrammerCandidates(): string[] {
  return [
    'STM32_Programmer_CLI',
    join('C:', 'Program Files', 'STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin', WIN ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI'),
    join('C:', 'Program Files', 'STMicroelectronics', 'STM32CubeProgrammer', 'bin', WIN ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI'),
    join('C:', 'Program Files (x86)', 'STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin', WIN ? 'STM32_Programmer_CLI.exe' : 'STM32_Programmer_CLI')
  ]
}

function armGccCandidates(): string[] {
  return [
    'arm-none-eabi-gcc',
    join('C:', 'ST', 'STM32CubeCLT', 'GNU-tools-for-STM32', 'bin', WIN ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc'),
    join('C:', 'Program Files', 'GNU Arm Embedded Toolchain', 'bin', WIN ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc'),
    join('C:', 'Program Files (x86)', 'Arm', 'GNU Toolchain arm-none-eabi', 'bin', WIN ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc')
  ]
}

function probe(candidates: string[], versionArgs: string[]): string | null {
  for (const cand of candidates) {
    if (cand.includes('/') || cand.includes('\\')) {
      if (!existsSync(cand)) continue
      try {
        const r = spawnSync(cand, versionArgs, { encoding: 'utf-8', timeout: 4000 })
        if (r.status === 0) return cand
      } catch {
        /* 继续 */
      }
    } else {
      try {
        const r = spawnSync(cand, versionArgs, { encoding: 'utf-8', timeout: 4000 })
        if (r.status === 0) return cand
      } catch {
        /* 继续 */
      }
    }
  }
  return null
}

export async function detectStm32(): Promise<Stm32Status> {
  const programmer = probe(stm32ProgrammerCandidates(), ['--version'])
  const armGcc = probe(armGccCandidates(), ['--version'])
  const available = !!programmer || !!armGcc
  let version = ''
  if (programmer) {
    try {
      const r = spawnSync(programmer, ['--version'], { encoding: 'utf-8', timeout: 5000 })
      version = (r.stdout || r.stderr || '').toString().trim().split('\n')[0] || ''
    } catch {
      /* 忽略 */
    }
  } else if (armGcc) {
    try {
      const r = spawnSync(armGcc, ['--version'], { encoding: 'utf-8', timeout: 5000 })
      version = (r.stdout || r.stderr || '').toString().split('\n')[0] || ''
    } catch {
      /* 忽略 */
    }
  }
  return { available, version, programmer, armGcc }
}

/** STM32CubeProgrammer 烧录（SWD 接口） */
export function stm32Flash(
  opts: { programmer: string; binary: string; device?: string },
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ReturnType<typeof spawn> {
  const args = ['-c', `port=${opts.device || 'SWD'}`, '-w', opts.binary, '-v']
  const cp = spawn(opts.programmer, args)
  cp.stdout.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[STM32 错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}

/** CMake 构建（STM32CubeMX 生成的工程） */
export function stm32Build(
  opts: { project: string; buildDir?: string; cmake?: string },
  onData: (chunk: string) => void,
  onExit: (code: number) => void
): ReturnType<typeof spawn> {
  const buildDir = opts.buildDir || join(opts.project, 'build')
  const cmake = opts.cmake || 'cmake'
  const cp = spawn(cmake, ['--build', buildDir, '--parallel'], { cwd: opts.project })
  cp.stdout.on('data', (d: Buffer) => onData(d.toString()))
  cp.stderr.on('data', (d: Buffer) => onData(d.toString()))
  cp.on('error', (err) => onData(`[CMake 错误] ${err.message}\n`))
  cp.on('close', (code) => onExit(code ?? -1))
  return cp
}
