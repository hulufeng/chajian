// SVD 寄存器精确查询工具（P1-7）
// 让 Agent 从官方 CMSIS-SVD（espressif/svd）查寄存器/位域/绝对地址，替掉"凭记忆写寄存器"的幻觉来源。
import type { ToolDefinition, ToolResult } from '../types'
import {
  KNOWN_SVD_CHIPS,
  listInstalledChips,
  installSvd,
  importLocalSvd,
  removeSvd,
  loadSvd,
  listPeripherals,
  listPeripheral,
  findRegister,
  formatRegister,
  getSvdDir,
  hex
} from '../../services/debug/svdService'

const svdQuery: ToolDefinition = {
  name: 'svd_query',
  description:
    '查询芯片寄存器的精确信息（地址、偏移、位宽、位域、复位值来源）——数据来自乐鑫官方 CMSIS-SVD（espressif/svd，Apache-2.0），与官方逐字一致。' +
    '**写裸寄存器/改外设配置前必须用本工具核对，禁止凭记忆写寄存器地址或位域。**' +
    'action：list=看已安装芯片；peripherals=列某芯片外设；reg=按寄存器名查（含位域/绝对地址）；peripheral=列某外设的全部寄存器；install=下载安装某芯片 SVD；import=导入本地 .svd；remove=删除。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型',
        enum: ['list', 'peripherals', 'reg', 'peripheral', 'install', 'import', 'remove']
      },
      chip: { type: 'string', description: '芯片型号，如 esp32s3 / esp32c3 / esp32（默认 esp32s3）' },
      name: { type: 'string', description: 'reg 用：寄存器名（如 GPIO_OUT / UART_CLKDIV，支持模糊）；peripheral 用：外设名（如 GPIO / UART0）' },
      peripheral: { type: 'string', description: 'reg 用：限定外设（如 GPIO），避免同名寄存器跨外设歧义' },
      exact: { type: 'boolean', description: 'reg 用：是否精确匹配寄存器名，默认 false（模糊）' },
      path: { type: 'string', description: 'import 用：本地 .svd 文件绝对路径' },
      force: { type: 'boolean', description: 'install 用：已安装时是否强制重新下载，默认 false' }
    },
    required: ['action']
  },
  category: 'read',
  execute: async (args): Promise<ToolResult> => {
    const action = String(args.action || '')
    const chip = String(args.chip || 'esp32s3')
    try {
      if (action === 'list') {
        const installed = listInstalledChips()
        return {
          ok: true,
          content:
            `已安装 SVD 的芯片（${installed.length}）：\n` +
            (installed.length
              ? installed.map((c) => `  - ${c.chip}  ${(c.bytes / 1024 / 1024).toFixed(2)}MB  ${new Date(c.mtime).toISOString().slice(0, 10)}`).join('\n')
              : '  （无）') +
            `\n缓存目录: ${getSvdDir()}` +
            `\n可安装（官方仓库）: ${KNOWN_SVD_CHIPS.join(', ')}` +
            `\n提示：未安装的芯片用 action:"install" 下载；数据不进安装包，按需拉取。`
        }
      }

      if (action === 'install') {
        const r = await installSvd(chip, { force: args.force === true || args.force === 'true' })
        return {
          ok: true,
          content: `已安装 ${r.chip} 的 SVD：${r.path}（${(r.bytes / 1024).toFixed(0)}KB）\n来源: ${r.url}\n现在可用 svd_query({action:"reg", chip:"${r.chip}", name:"..."}) 查询寄存器。`
        }
      }

      if (action === 'import') {
        if (!args.path) return { ok: false, content: '', error: 'import 需要 path 参数（本地 .svd 文件绝对路径）' }
        const r = importLocalSvd(chip, String(args.path))
        return { ok: true, content: `已导入本地 SVD 为 ${r.chip}：${r.path}（${(r.bytes / 1024).toFixed(0)}KB）\n来源: ${r.url}` }
      }

      if (action === 'remove') {
        const ok = removeSvd(chip)
        return { ok: true, content: ok ? `已删除 ${chip} 的本地 SVD 缓存。` : `${chip} 本地没有 SVD 缓存，无需删除。` }
      }

      if (action === 'peripherals') {
        const list = listPeripherals(chip)
        const lines = list.map((p) => `  - ${p.name}  基址 ${hex(p.baseAddress)}  ${p.registers.length} 个寄存器  ${p.description.slice(0, 60)}`)
        return {
          ok: true,
          content: `${loadSvd(chip).deviceName} 外设（${list.length}）：\n${lines.join('\n')}\n\n用 action:"peripheral" name:"GPIO" 看某外设的全部寄存器。`
        }
      }

      if (action === 'peripheral') {
        const name = String(args.name || '')
        if (!name) return { ok: false, content: '', error: 'peripheral 需要 name 参数（外设名，如 GPIO）' }
        const r = listPeripheral(chip, name)
        if (!r) {
          const names = listPeripherals(chip).map((p) => p.name).join(', ')
          return { ok: false, content: '', error: `未找到外设 ${name}。该芯片外设：${names}` }
        }
        const lines = r.peripheral.registers.map((reg) => {
          const dim = reg.dim && reg.dimIncrement ? ` [${reg.dim}x]` : ''
          return `  ${reg.name}${dim}  偏移 ${hex(reg.addressOffset, 4)}  绝对 ${hex(reg.address)}  ${reg.fields.length} 位域  ${reg.description.slice(0, 50)}`
        })
        return {
          ok: true,
          content:
            `外设 ${r.peripheral.name}（基址 ${hex(r.peripheral.baseAddress)}，${r.total} 个寄存器）\n` +
            `${r.peripheral.description}\n\n${lines.join('\n')}\n\n` +
            `要看某寄存器的位域：action:"reg" name:"<寄存器名>" peripheral:"${r.peripheral.name}"`
        }
      }

      if (action === 'reg') {
        const name = String(args.name || '')
        if (!name) return { ok: false, content: '', error: 'reg 需要 name 参数（寄存器名，如 GPIO_OUT）' }
        const hits = findRegister(chip, name, {
          peripheral: args.peripheral ? String(args.peripheral) : undefined,
          exact: args.exact === true || args.exact === 'true'
        })
        if (hits.length === 0) {
          return {
            ok: false,
            content: '',
            error: `在 ${chip} 的官方 SVD 中未找到寄存器 "${name}"${args.peripheral ? `（外设 ${args.peripheral}）` : ''}。\n` +
              `注意：官方 SVD 用的是**短寄存器名**（如 GPIO 下是 OUT/ENABLE_W1TS，UART0 下是 CLKDIV），本工具已能自动把 GPIO_OUT_REG 这类前缀名拆解成 GPIO.OUT。\n` +
              `请确认：① 芯片型号（已装：${listInstalledChips().map((c) => c.chip).join(', ') || '无'}）；② 先用 action:"peripheral" name:"GPIO" 列出该外设的真实寄存器名；③ 不要凭记忆猜寄存器名。`
          }
        }
        const shown = hits.slice(0, 5).map(formatRegister).join('\n\n---\n\n')
        const more = hits.length > 5 ? `\n\n（共命中 ${hits.length} 处，仅显示前 5；可用 peripheral 参数限定）` : ''
        return { ok: true, content: shown + more, data: { count: hits.length } }
      }

      return { ok: false, content: '', error: `未知 action: ${action}` }
    } catch (e) {
      return { ok: false, content: '', error: (e as Error).message }
    }
  }
}

export const svdTools: ToolDefinition[] = [svdQuery]
