/**
 * 硬件符号悬停知识库（#33）——补语言服务器之所短。
 *
 * 即使 clangd 装好了，它也**不知道**「Serial.begin 的波特率常用多少」
 * 「analogRead 在 WiFi 开着时哪些脚不能读」「esp32 core 3.x 的 PWM 换了 API」这类
 * 只有做硬件的人才清楚的坑。这里把这些工程经验做成悬停文档，和 LSP 的悬停结果合并展示。
 *
 * 事实来源：Arduino 官方 API 文档 + arduino-esp32 core 3.x API（本机实测 3.3.11）
 * + STM32duino HAL 公开 API。只写有把握的签名，拿不准的一律不给，避免误导。
 */

export interface HoverDoc {
  title: string
  signature?: string
  body: string
}

interface FuncDoc {
  signature: string
  desc: string
  /** 只有部分架构适用时标注 */
  arch?: 'esp32' | 'stm32'
  /** 使用注意 / 坑 */
  note?: string
}

const ESP_ARCH_FUNCS: Record<string, FuncDoc> = {
  // ── PWM：3.x 起变了，最容易踩 ──
  ledcAttach: {
    signature: 'bool ledcAttach(uint8_t pin, uint32_t freq, uint8_t resolution)',
    desc: '把引脚挂到 LEDC 通道并配置频率与分辨率（arduino-esp32 **3.x** 起的新 API）。',
    arch: 'esp32',
    note: '替代旧的 `ledcSetup() + ledcAttachPin()` 两步式写法（3.x 里已废弃）。resolution 常用 8~12 位。'
  },
  ledcWrite: {
    signature: 'bool ledcWrite(uint8_t pin, uint32_t duty)',
    desc: '输出 PWM 占空比。duty 上限 = 2^resolution - 1。',
    arch: 'esp32',
    note: '必须先 `ledcAttach()`。8 位分辨率时范围 0~255。'
  },
  ledcDetach: {
    signature: 'bool ledcDetach(uint8_t pin)',
    desc: '释放引脚占用的 LEDC 通道。',
    arch: 'esp32'
  },
  dacWrite: {
    signature: 'void dacWrite(uint8_t pin, uint8_t value)',
    desc: 'DAC 输出 0~255（仅 ESP32 经典款的 GPIO25 / GPIO26 支持）。',
    arch: 'esp32',
    note: 'ESP32-S2/S3/C3 没有 DAC。'
  },
  touchRead: {
    signature: 'uint16_t touchRead(uint8_t pin)',
    desc: '读电容触摸引脚，数值越小说明越接近被触摸。',
    arch: 'esp32'
  },
  analogReadResolution: {
    signature: 'void analogReadResolution(uint8_t bits)',
    desc: '设置 ADC 分辨率（通常为 9~12 位）。',
    arch: 'esp32'
  },
  esp_sleep_enable_timer_wakeup: {
    signature: 'esp_err_t esp_sleep_enable_timer_wakeup(uint64_t time_in_us)',
    desc: '配置定时唤醒源（微秒单位）。需再调用 esp_deep_sleep_start() 才真正睡下去。',
    arch: 'esp32',
    note: '深睡后程序从 setup() 重新跑，SRAM 里的变量全部丢失，需要持久化的走 Preferences/NVS。'
  },
  esp_deep_sleep_start: {
    signature: 'void esp_deep_sleep_start()',
    desc: '进入深度睡眠（不返回）。醒来从 setup() 重新开始执行。',
    arch: 'esp32'
  }
}

const ARDUINO_FUNCS: Record<string, FuncDoc> = {
  pinMode: {
    signature: 'void pinMode(uint8_t pin, uint8_t mode)',
    desc: '设置引脚方向：OUTPUT / INPUT / INPUT_PULLUP / INPUT_PULLDOWN。'
  },
  digitalWrite: {
    signature: 'void digitalWrite(uint8_t pin, uint8_t val)',
    desc: '输出高低电平（HIGH / LOW）。',
    note: 'ESP32 建议避开启动时有固定电平要求的 strapping 脚（常见 GPIO0/2/5/12/15），否则可能卡在下载模式。'
  },
  digitalRead: {
    signature: 'int digitalRead(uint8_t pin)',
    desc: '读引脚电平，返回 HIGH 或 LOW。'
  },
  analogRead: {
    signature: 'int analogRead(uint8_t pin)',
    desc: '读 ADC，返回 0 ~ 2^分辨率-1 的原始值。',
    note: 'ESP32 上 ADC2 的引脚在 WiFi 启用期间不可用，优先用 ADC1 引脚。'
  },
  attachInterrupt: {
    signature: 'void attachInterrupt(uint8_t interruptNum, void (*fn)(void), int mode)',
    desc: '绑定引脚中断。interruptNum 用 digitalPinToInterrupt(pin) 转换。',
    note: '中断服务函数要尽量短、加 `volatile` 修饰共享变量；ESP32 上可用 `IRAM_ATTR`。'
  },
  digitalPinToInterrupt: {
    signature: 'int digitalPinToInterrupt(uint8_t pin)',
    desc: '把引脚号转成中断号，配合 attachInterrupt 使用。'
  },
  delay: {
    signature: 'void delay(uint32_t ms)',
    desc: '毫秒级阻塞延时。',
    note: 'loop 里大量用 delay 会阻塞网络/串口处理；定时任务优先用 millis 非阻塞写法。'
  },
  millis: {
    signature: 'unsigned long millis()',
    desc: '返回上电以来的毫秒数（约 49 天翻滚一次）。',
    note: '比较时间用 `now - last >= period` 的减法写法，天然处理翻滚。'
  },
  'Serial.begin': {
    signature: 'void Serial.begin(unsigned long baud)',
    desc: '初始化串口，常用波特率 9600 / 115200。'
  },
  'Serial.printf': {
    signature: 'int Serial.printf(const char* fmt, ...)',
    desc: '格式化输出（ESP32 支持，语法与 C printf 一致）。'
  },
  'Serial.println': {
    signature: 'size_t Serial.println(val)',
    desc: '输出一行并换行。'
  },
  'Serial.available': {
    signature: 'int Serial.available()',
    desc: '返回接收缓冲区里可读的字节数。'
  },
  'Serial.readStringUntil': {
    signature: 'String Serial.readStringUntil(char terminator)',
    desc: '读到指定终止符（常用于读一行命令）。'
  },
  'Wire.begin': {
    signature: 'bool Wire.begin(int sda = -1, int scl = -1)',
    desc: '初始化 I2C。ESP32 通常需要显式指定 SDA / SCL 引脚。'
  },
  'Wire.beginTransmission': {
    signature: 'void Wire.beginTransmission(uint8_t address)',
    desc: '开始向目标地址传输。'
  },
  'Wire.endTransmission': {
    signature: 'uint8_t Wire.endTransmission()',
    desc: '结束传输。返回 0 表示成功（有设备应答）。'
  },
  'Wire.requestFrom': {
    signature: 'uint8_t Wire.requestFrom(uint8_t address, uint8_t quantity)',
    desc: '向从设备请求若干字节。'
  },
  'SPI.begin': {
    signature: 'void SPI.begin(int8_t sck, int8_t miso, int8_t mosi, int8_t ss)',
    desc: '初始化 SPI 总线并指定引脚（ESP32 用法；Uno 等通常为无参版本）。'
  },
  'SPI.transfer': {
    signature: 'uint8_t SPI.transfer(uint8_t data)',
    desc: '发送一个字节并同时读回一个字节（SPI 全双工）。'
  },
  'SPI.beginTransaction': {
    signature: 'void SPI.beginTransaction(SPISettings settings)',
    desc: '按指定时钟/位序/模式开始一次事务，用完要 endTransaction()。'
  },
  'WiFi.begin': {
    signature: 'wl_status_t WiFi.begin(const char* ssid, const char* passphrase)',
    desc: '连接 WiFi 热点。需配合 `while (WiFi.status() != WL_CONNECTED)` 等待或超时处理。',
    note: '死循环等待会卡死；务必加超时或最大重试次数。'
  },
  'WiFi.softAP': {
    signature: 'bool WiFi.softAP(const char* ssid, const char* passphrase = NULL)',
    desc: '开启 AP 热点（配网常用）。密码少于 8 位会被拒绝。'
  },
  'prefs.begin': {
    signature: 'bool Preferences::begin(const char* name, bool readOnly = false)',
    desc: '打开命名空间下的键值存储（基于 NVS，掉电不丢）。'
  }
}

const STM32_FUNCS: Record<string, FuncDoc> = {
  HAL_GPIO_WritePin: {
    signature: 'void HAL_GPIO_WritePin(GPIO_TypeDef* GPIOx, uint16_t GPIO_Pin, GPIO_PinState PinState)',
    desc: 'HAL 写 GPIO：GPIO_PIN_SET / GPIO_PIN_RESET。',
    arch: 'stm32'
  },
  HAL_GPIO_TogglePin: {
    signature: 'void HAL_GPIO_TogglePin(GPIO_TypeDef* GPIOx, uint16_t GPIO_Pin)',
    desc: '翻转 GPIO 电平。',
    arch: 'stm32'
  },
  HAL_GPIO_ReadPin: {
    signature: 'GPIO_PinState HAL_GPIO_ReadPin(GPIO_TypeDef* GPIOx, uint16_t GPIO_Pin)',
    desc: '读 GPIO 输入电平。',
    arch: 'stm32'
  },
  HAL_Delay: {
    signature: 'void HAL_Delay(uint32_t Delay)',
    desc: 'HAL 毫秒延时（依赖 SysTick）。',
    arch: 'stm32'
  },
  analogWriteFrequency: {
    signature: 'void analogWriteFrequency(uint32_t freq)',
    desc: '设置 PWM 频率（STM32duino 扩展）。',
    arch: 'stm32'
  },
  analogWriteResolution: {
    signature: 'void analogWriteResolution(uint8_t bits)',
    desc: '设置 PWM/ADC 分辨率位数（STM32duino 扩展）。',
    arch: 'stm32'
  }
}

const ALL_DOCS: Record<string, FuncDoc> = { ...ARDUINO_FUNCS, ...ESP_ARCH_FUNCS, ...STM32_FUNCS }

/** GPIO_NUM_xx 这类宏的模式匹配 */
const GPIO_MACRO = /^(GPIO_NUM_|GPIO)(\d{1,2})$/i

/** 把函数说明转成悬停用的 Markdown */
function markdown(d: FuncDoc): string {
  const lines: string[] = []
  lines.push(`**${d.signature}**`)
  lines.push('')
  lines.push(d.desc)
  if (d.note) {
    lines.push('')
    lines.push(`> ⚠ ${d.note}`)
  }
  if (d.arch) {
    lines.push('')
    lines.push(`_适用：${d.arch === 'esp32' ? 'ESP32 系列' : 'STM32 系列'}_`)
  }
  return lines.join('\n')
}

/** 引脚宏的悬停说明（不认识的词返回 null） */
export function pinDoc(word: string): HoverDoc | null {
  const m = GPIO_MACRO.exec(String(word || '').trim())
  if (!m) return null
  const num = m[2]
  return {
    title: `GPIO${num}`,
    signature: `宏：${word}`,
    body: [
      `GPIO 编号宏 —— 用于 \`pinMode\` / \`digitalWrite\` / \`analogRead\` 等函数。`,
      '',
      '**注意**',
      '',
      '- ESP32 上部分引脚有特殊用途：`GPIO0`（进入下载模式 / BOOT 键）、`GPIO35~39` 只能输入无上拉下拉、',
      '  `GPIO34~39` 无输出能力；strapping 脚（`0/2/5/12/15`）上电电平会影响启动。',
      '- ADC2 引脚在 WiFi 启用期间不可用，做模拟采样优先 ADC1。',
      '',
      '_这块是按 ESP32 通用事实给的提示；具体到某块板的可用引脚，以「硬件目标」面板里的板卡定义为准。_'
    ].join('\n')
  }
}

/** 函数/方法的悬停说明 */
export function funcDoc(word: string): HoverDoc | null {
  const key = String(word || '').trim()
  const d = ALL_DOCS[key]
  if (!d) return null
  return { title: key, signature: d.signature, body: markdown(d) }
}

/** 统一入口：先看函数，再看引脚宏 */
export function hoverFor(word: string): HoverDoc | null {
  return funcDoc(word) ?? pinDoc(word)
}

/** 把悬停文档 + LSP 结果合成一段 Markdown（都为空时返回 null，让 Monaco 不弹窗） */
export function mergeHover(existing: string | null, extra: HoverDoc | null): string | null {
  if (!existing && !extra) return null
  const parts: string[] = []
  if (existing) parts.push(existing)
  if (extra) parts.push([`**${extra.title}**`, extra.signature ? `\n\n\`${extra.signature}\`` : '', '\n\n', extra.body].join(''))
  return parts.join('\n\n---\n\n')
}
