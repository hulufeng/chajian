/**
 * 芯片勘误表（errata）查询（NeuralInverse #10 对标：写外设配置前先查，避免踩已记录硅错）。
 *
 * ⚠️ 数据纪律：本库为**种子**，只收录确有把握、且标了 verified + 来源的条目。
 *    扩充时必须逐条对照厂商官方 errata sheet，禁止凭记忆写入 workaround —— 写错 workaround 比没有更危险。
 *    调用方（agent / 用户）看到命中条目时，应提示向厂商 errata sheet 二次核对。
 */
export type ErrataSeverity = 'errata' | 'caution' | 'limitation'

export interface ErrataEntry {
  id: string
  /** 适用芯片家族/型号关键词（小写匹配，包含即命中） */
  chipFamily: string[]
  title: string
  description: string
  workaround?: string
  fixedIn?: string
  severity: ErrataSeverity
  source: string
  /** 本条是否经厂商资料核对（未核对的不得在 agent 输出里当结论） */
  verified: boolean
}

export const ERRATA_DB: ErrataEntry[] = [
  {
    id: 'esp32-adc2-wifi',
    chipFamily: ['esp32', 'esp32s2', 'esp32s3', 'esp32c3'],
    title: 'ADC2 与 Wi-Fi 共享 SAR ADC 硬件，启用 Wi-Fi 时不可用',
    description: 'ESP32 的 ADC2 与 Wi-Fi 共用同一 SAR ADC 硬件；一旦启用 Wi-Fi，对任意 ADC2 通道的读取会失败（通常返回 0 或 -1）。ADC1 不受影响。',
    workaround: '需要模拟采集且要用 Wi-Fi 时，改用 ADC1 通道；或暂关 Wi-Fi 再读 ADC2。',
    severity: 'limitation',
    source: 'ESP-IDF 编程指南 / ADC 章节',
    verified: true,
  },
  {
    id: 'esp32-gpio12-mtdi-strapping',
    chipFamily: ['esp32'],
    title: 'GPIO12(MTDI) 是 strapping 脚，复位时决定 flash/PSRAM 电压',
    description: '复位瞬间 GPIO12 经 MTDI 采样，用于选择 flash/PSRAM 供电电压（高电平=1.8V，低电平=3.3V）。若外部把它上拉到高、而板载 flash 是 3.3V，可能启动失败或读写错误。',
    workaround: 'ESP32 板载 flash 多为 3.3V，确保 GPIO12 复位时为低电平（不要外接上拉）；用模组时注意 MTDI 处理。',
    severity: 'caution',
    source: 'ESP32 技术参考手册 / 芯片启动与 strapping 引脚',
    verified: true,
  },
]

/** 按芯片家族 + 可选关键词过滤 errata。返回空数组表示库里未收录（不等于"无 errata"）。 */
export function queryErrata(chip: string, keyword?: string): ErrataEntry[] {
  const c = (chip || '').toLowerCase()
  const kw = (keyword || '').toLowerCase()
  return ERRATA_DB.filter((e) => {
    const famMatch = e.chipFamily.some((f) => {
      const f2 = f.toLowerCase()
      return c.includes(f2) || f2.includes(c)
    })
    if (!famMatch) return false
    if (kw && !(e.title + e.description + (e.workaround || '')).toLowerCase().includes(kw)) return false
    return true
  })
}
