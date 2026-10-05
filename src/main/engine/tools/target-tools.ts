// 硬件目标工具（第四批②）：让 Agent 能查板卡能力、选构建路径、生成 platformio.ini
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ToolDefinition, ToolResult } from '../types'
import {
  BOARD_TARGETS,
  listTargets,
  findTarget,
  targetForFqbn,
  targetForPioBoard,
  targetForUsbId,
  buildPlatformioIni,
  primaryBuild
} from '../../services/boardRegistry'
import { familyOf } from '../../services/debugService'

const LINK_LABEL: Record<string, string> = {
  'builtin-usb-jtag': '板载 USB-JTAG',
  'onboard-stlink': '板载 ST-Link',
  'external-stlink': '外接 ST-Link',
  'cmsis-dap': 'CMSIS-DAP'
}
const UPLOAD_LABEL: Record<string, string> = {
  serial: '串口',
  'usb-jtag': 'USB-JTAG',
  stlink: 'ST-Link',
  dfu: 'DFU'
}

function fmt(t: (typeof BOARD_TARGETS)[number]): string {
  const b = primaryBuild(t)
  return (
    `- ${t.name}（${t.id}）\n` +
    `    芯片 ${t.chip} · ${t.mcu} · ${t.flash}\n` +
    `    构建 ${b.path === 'platformio' ? `PlatformIO ${t.pioPlatform}/${t.pioBoard}` : `arduino-cli ${t.fqbn}`}` +
    `${t.build.length > 1 ? `（备选：${t.build.slice(1).map((x) => x.path).join(', ')}）` : ''}\n` +
    `    烧录 ${UPLOAD_LABEL[t.upload.kind]} · 调试 ${LINK_LABEL[t.debug.link]} → openocd -f ${t.debug.cfg.join(' -f ')}\n` +
    `    SVD ${t.svdChip ? `espressif/svd:${t.svdChip}` : '需导入本地 .svd'}`
  )
}

const hardwareTarget: ToolDefinition = {
  name: 'hardware_target',
  description:
    '查询/选择硬件目标板卡（ESP32 与 STM32 统一视图）。给出每块板的可构建路径（arduino-cli FQBN / PlatformIO board id）、' +
    '烧录通道、调试器链路与 openocd 配置、SVD 可用性。**换板子、选构建方式、接外部探针前先查这里，不要凭记忆写 FQBN 或 board id。**' +
    'action：list=列全部；get=查某块板（name/id）；detect=按 FQBN / pio board id / USB VID:PID 反查；ini=生成 platformio.ini 片段。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '操作类型', enum: ['list', 'get', 'detect', 'ini'] },
      family: { type: 'string', description: 'list 用：esp32 / stm32', enum: ['esp32', 'stm32'] },
      board: { type: 'string', description: 'get 用：板卡 id 或名称（esp32-s3-devkitc-1 / NUCLEO-F767ZI）' },
      fqbn: { type: 'string', description: 'detect 用：arduino-cli FQBN，如 esp32:esp32:esp32s3' },
      pioBoard: { type: 'string', description: 'detect 用：PlatformIO board id，如 nucleo_f767zi' },
      usbId: { type: 'string', description: 'detect 用：USB VID:PID，如 0x0483:0x374b（ST-Link）' },
      project: { type: 'string', description: 'ini 用：工程根目录（只读生成，不落盘）' },
      env: { type: 'string', description: 'ini 用：env 名，默认用板卡 id' }
    },
    required: ['action']
  },
  category: 'query',
  execute: async (args): Promise<ToolResult> => {
    const action = String(args.action || '')
    try {
      if (action === 'list') {
        const fam = args.family ? String(args.family) : undefined
        const list = listTargets(fam as 'esp32' | 'stm32' | undefined)
        const groups: Record<string, typeof list> = { esp32: [], stm32: [] }
        for (const t of list) groups[t.family].push(t)
        const parts = Object.entries(groups)
          .filter(([, arr]) => arr.length > 0)
          .map(([f, arr]) => `【${f === 'esp32' ? 'ESP32' : 'STM32'}】\n${arr.map(fmt).join('\n')}`)
        return { ok: true, content: `${parts.join('\n\n')}\n\n共 ${list.length} 块板。` }
      }

      if (action === 'get') {
        const t = findTarget(String(args.board || ''))
        if (!t) {
          return {
            ok: false,
            content: `没找到板卡「${args.board}」。可用 id：${BOARD_TARGETS.map((x) => x.id).join(', ')}`
          }
        }
        return {
          ok: true,
          content:
            `${fmt(t)}\n    家族 ${familyOf(t.chip)}\n` +
            `    构建路径全量：\n${t.build.map((b) => `      - ${b.path}：${b.detail}`).join('\n')}\n` +
            `    下载口 ${t.upload.note}\n    调试说明 ${t.debug.note}\n    备注 ${t.notes}`
        }
      }

      if (action === 'detect') {
        if (args.fqbn) {
          const t = targetForFqbn(String(args.fqbn))
          return { ok: !!t, content: t ? `FQBN ${args.fqbn} → ${t.name}（${t.id}）` : `FQBN ${args.fqbn} 不在板卡库里` }
        }
        if (args.pioBoard) {
          const t = targetForPioBoard(String(args.pioBoard))
          return { ok: !!t, content: t ? `board ${args.pioBoard} → ${t.name}（${t.id}）` : `board ${args.pioBoard} 不在板卡库里` }
        }
        if (args.usbId) {
          const t = targetForUsbId(String(args.usbId))
          return { ok: !!t, content: t ? `USB ${args.usbId} → ${t.name}（${t.id}）` : `USB ${args.usbId} 未登记（可能是别的设备）` }
        }
        return { ok: false, content: 'detect 需要 fqbn / pioBoard / usbId 之一' }
      }

      if (action === 'ini') {
        const t = findTarget(String(args.board || '')) || (args.fqbn ? targetForFqbn(String(args.fqbn)) : undefined)
        if (!t) return { ok: false, content: '需要 board 或 fqbn 指定板卡' }
        const env = args.env ? String(args.env) : undefined
        const body = buildPlatformioIni(t, { env })
        const root = args.project ? resolve(String(args.project)) : ''
        const exists = root ? existsSync(join(root, 'platformio.ini')) : false
        return {
          ok: true,
          content:
            `以下内容可写入 ${root || '<工程根>'}/platformio.ini${exists ? '（注意：该文件已存在，需手工合并，不要覆盖）' : ''}：\n\n${body}`
        }
      }

      return { ok: false, content: `未知 action：${action}` }
    } catch (e) {
      return { ok: false, content: `执行失败：${(e as Error).message}` }
    }
  }
}

export const targetTools: ToolDefinition[] = [hardwareTarget]
