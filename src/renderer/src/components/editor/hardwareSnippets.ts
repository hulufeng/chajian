/**
 * 硬件代码片段库（#32）——不依赖 clangd，装没装语言服务器都能用。
 *
 * 为什么必须有它：嵌入式开发大量重复骨架（连 WiFi、PWM、ADC、I2C 扫描、深睡唤醒），
 * 靠语言服务器补全还得先有 compile_commands.json + clangd，本机往往没有。
 * 这里直接给出可直接编译的片段，作为 Monaco 的内置补全来源之一。
 *
 * 事实来源：Arduino 官方 API + arduino-esp32 core 3.x（本项目实测装的是 esp32:esp32 3.3.11）。
 * 注意 PWM：3.x 起用 ledcAttach(pin, freq, resolution) + ledcWrite(pin, duty)，
 * 老的 ledcSetup/ledcAttachPin 已弃用——片段按新 API 写，避免给出跑不通的旧代码。
 */
export interface HardwareSnippet {
  /** 触发标签（补全列表里显示的关键词） */
  label: string
  /** 一句话说明 */
  detail: string
  /** 片段正文，$1/$2 是光标停靠点，${1:默认} 带占位默认值 */
  body: string[]
  /** 适用架构：esp32 / stm32 / any */
  arch: 'esp32' | 'stm32' | 'any'
  /** 补全种类：15=Snippet（对齐 Monaco CompletionItemKind） */
  kind?: number
}

const SNIPPET: Record<string, number> = { key: 15 }

export const HARDWARE_SNIPPETS: HardwareSnippet[] = [
  // ── 骨架 ──
  {
    label: 'sketch',
    detail: 'Arduino 工程骨架（setup + loop）',
    body: ['void setup() {', '  $0', '}', '', 'void loop() {', '}', ''],
    arch: 'any'
  },
  // ── GPIO ──
  {
    label: 'digitalwrite',
    detail: 'GPIO 输出：点亮/熄灭（含 LED_BUILTIN）',
    body: ['const uint8_t PIN = ${1:2};', '', 'void setup() {', '  pinMode(PIN, OUTPUT);', '}', '', 'void loop() {', '  digitalWrite(PIN, HIGH);', '  delay(${2:500});', '  digitalWrite(PIN, LOW);', '  delay(${2:500});', '}', ''],
    arch: 'any'
  },
  {
    label: 'digitalread',
    detail: 'GPIO 输入：读按键/电平（上拉）',
    body: ['const uint8_t PIN = ${1:4};', '', 'void setup() {', '  Serial.begin(${2:115200});', '  pinMode(PIN, INPUT_PULLUP);', '}', '', 'void loop() {', '  int v = digitalRead(PIN);', '  Serial.println(v);', '  delay(200);', '}', ''],
    arch: 'any'
  },
  {
    label: 'attachinterrupt',
    detail: '外部中断：引脚变化触发回调',
    body: ['const uint8_t PIN = ${1:4};', 'volatile uint32_t hits = 0;', '', 'void IRAM_ATTR onEdge() {', '  hits++;', '}', '', 'void setup() {', '  Serial.begin(115200);', '  pinMode(PIN, INPUT_PULLUP);', '  attachInterrupt(digitalPinToInterrupt(PIN), onEdge, ${2:FALLING});', '}', '', 'void loop() {', '  Serial.println(hits);', '  delay(1000);', '}', ''],
    arch: 'any'
  },
  // ── 串口 ──
  {
    label: 'serialbegin',
    detail: '串口初始化 + 打印',
    body: ['void setup() {', '  Serial.begin(${1:115200});', '  while (!Serial) delay(10);', '  Serial.println("ready");', '}', ''],
    arch: 'any'
  },
  // ── PWM（arduino-esp32 3.x 新 API）──
  {
    label: 'ledcpwm',
    detail: 'PWM 输出（esp32 core 3.x：ledcAttach + ledcWrite）',
    body: [
      'const uint8_t PIN = ${1:2};', 'const uint32_t FREQ = ${2:5000};',
      'const uint8_t RES = ${3:8}; // 分辨率位数：8 位 => duty 0..255',
      'const uint32_t MAX_DUTY = (1u << RES) - 1;', '', 'void setup() {',
      '  ledcAttach(PIN, FREQ, RES);', '}', '', 'void loop() {',
      '  for (uint32_t d = 0; d <= MAX_DUTY; d += MAX_DUTY / 16) {',
      '    ledcWrite(PIN, d);', '    delay(30);', '  }', '}', ''
    ],
    arch: 'esp32'
  },
  // ── ADC ──
  {
    label: 'analogread',
    detail: 'ADC 采样（ESP32 仅 ADC1 引脚可用 WiFi 时不受限）',
    body: [
      'const uint8_t PIN = ${1:34};', 'void setup() {', '  Serial.begin(${2:115200});',
      '  analogReadResolution(${3:12}); // 9~12 位', '}', '', 'void loop() {',
      '  int raw = analogRead(PIN);', '  float volts = raw * 3.3f / (1 << ${3:12});',
      '  Serial.printf("raw=%d  %.2fV\\n", raw, volts);', '  delay(500);', '}', ''
    ],
    arch: 'esp32'
  },
  // ── I2C ──
  {
    label: 'i2cscan',
    detail: 'I2C 扫描：找总线上设备地址',
    body: [
      '#include <Wire.h>', '', 'void setup() {', '  Serial.begin(${2:115200});',
      '  Wire.begin(${1:21, 22}); // ESP32 需显式给 SDA, SCL', '}', '', 'void loop() {',
      '  uint8_t n = 0;', '  for (uint8_t a = 1; a < 127; a++) {',
      '    Wire.beginTransmission(a);', '    if (Wire.endTransmission() == 0) {',
      '      Serial.printf("found 0x%02X\\n", a);', '      n++;', '    }', '  }',
      '  Serial.printf("total %d\\n", n);', '  delay(3000);', '}', ''
    ],
    arch: 'any'
  },
  {
    label: 'wirebegin',
    detail: 'I2C 主机初始化（Wire.begin(SDA, SCL)）',
    body: ['#include <Wire.h>', '', 'void setup() {', '  Wire.begin(${1:21}, ${2:22});', '}', ''],
    arch: 'any'
  },
  // ── SPI ──
  {
    label: 'spibegin',
    detail: 'SPI 主机初始化 + 单字节传输模板',
    body: [
      '#include <SPI.h>', '', 'const uint8_t SS_PIN = ${1:5};', '', 'void setup() {',
      '  Serial.begin(115200);', '  pinMode(SS_PIN, OUTPUT);', '  digitalWrite(SS_PIN, HIGH);',
      '  SPI.begin(${2:18}, ${3:19}, ${4:23}, SS_PIN); // SCK, MISO, MOSI, SS',
      '  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));',
      '  digitalWrite(SS_PIN, LOW);', '  SPI.transfer(0x00);', '  digitalWrite(SS_PIN, HIGH);',
      '  SPI.endTransaction();', '}', '', 'void loop() {}', ''
    ],
    arch: 'esp32'
  },
  // ── WiFi（ESP32 专属）──
  {
    label: 'wifista',
    detail: 'WiFi 连热点（带超时与重试，避免死等）',
    body: [
      '#include <WiFi.h>', '', 'const char* SSID = "${1:YOUR_SSID}";', 'const char* PWD = "${2:YOUR_PASS}";',
      '', 'void setup() {', '  Serial.begin(115200);', '  WiFi.mode(WIFI_STA);',
      '  WiFi.begin(SSID, PWD);', '  uint8_t tries = 0;',
      '  while (WiFi.status() != WL_CONNECTED && tries++ < 40) {', '    delay(500);',
      '    Serial.print(".");', '  }', '  Serial.println();',
      '  if (WiFi.status() == WL_CONNECTED) Serial.println(WiFi.localIP());',
      '  else Serial.println("connect failed");', '}', '', 'void loop() {}', ''
    ],
    arch: 'esp32'
  },
  {
    label: 'wifiap',
    detail: '开 AP 热点（配网用）',
    body: [
      '#include <WiFi.h>', '', 'void setup() {', '  Serial.begin(115200);',
      '  WiFi.softAP("${1:LabCode-AP}", "${2:12345678}");',
      '  Serial.println(WiFi.softAPIP());', '}', '', 'void loop() {}', ''
    ],
    arch: 'esp32'
  },
  // ── 深睡 ──
  {
    label: 'deepsleep',
    detail: '深度睡眠 + 定时唤醒（省电）',
    body: [
      'const uint64_t SLEEP_US = ${1:10} * 1000000ULL;', '', 'void setup() {',
      '  Serial.begin(115200);', '  Serial.println("going to sleep");',
      '  esp_sleep_enable_timer_wakeup(SLEEP_US);', '  esp_deep_sleep_start();', '}',
      '', 'void loop() {}', ''
    ],
    arch: 'esp32'
  },
  // ── 非阻塞延时 ──
  {
    label: 'millisblink',
    detail: '非阻塞定时（不用 delay，millis 翻滚安全写法）',
    body: [
      'const uint8_t PIN = ${1:2};', 'const uint32_t PERIOD = ${2:500};',
      'uint32_t lastMs = 0;', 'bool level = false;', '', 'void setup() { pinMode(PIN, OUTPUT); }',
      '', 'void loop() {', '  uint32_t now = millis();',
      '  if (now - lastMs >= PERIOD) { // 减法写法天然处理 49 天翻滚',
      '    lastMs = now;', '    level = !level;', '    digitalWrite(PIN, level);', '  }', '}', ''
    ],
    arch: 'any'
  },
  // ── NVS 持久化 ──
  {
    label: 'preferences',
    detail: 'Preferences：掉电不丢的键值存储（NVS）',
    body: [
      '#include <Preferences.h>', '', 'Preferences prefs;', '', 'void setup() {',
      '  Serial.begin(115200);', '  prefs.begin("${1:app}", false);',
      '  uint32_t boots = prefs.getUInt("boots", 0) + 1;', '  prefs.putUInt("boots", boots);',
      '  Serial.printf("boot #%u\\n", boots);', '  prefs.end();', '}', '', 'void loop() {}', ''
    ],
    arch: 'esp32'
  },
  // ── STM32 专属 ──
  {
    label: 'stm32hal_gpio',
    detail: 'STM32 HAL：GPIO 翻转模板',
    body: [
      '// STM32duino 环境同时支持 Arduino API 与 HAL 调用',
      'void setup() {', '  HAL_Delay(100);', '}',
      '', 'void loop() {', '  HAL_GPIO_TogglePin(${1:GPIOA}, ${2:GPIO_PIN_5});',
      '  HAL_Delay(${3:500});', '}', ''
    ],
    arch: 'stm32'
  },
  {
    label: 'stm32pwm',
    detail: 'STM32 PWM（analogWrite + 分辨率设置）',
    body: [
      'const uint8_t PIN = ${1:PA8};', '', 'void setup() {',
      '  analogWriteResolution(${2:10}); // 默认 8 位，可调到 10/12',
      '  analogWriteFrequency(${3:1000});', '}', '', 'void loop() {',
      '  analogWrite(PIN, ${4:512});', '}', ''
    ],
    arch: 'stm32'
  }
]

/** 按架构过滤（arch=any 的通用片段始终给） */
export function snippetsForArch(arch: 'esp32' | 'stm32' | 'any'): HardwareSnippet[] {
  if (arch === 'any') return HARDWARE_SNIPPETS
  return HARDWARE_SNIPPETS.filter((s) => s.arch === arch || s.arch === 'any')
}

/** 按已输入前缀筛选（大小写不敏感），供 provider 过滤 */
export function matchSnippets(prefix: string, arch: 'esp32' | 'stm32' | 'any'): HardwareSnippet[] {
  const p = String(prefix || '').toLowerCase()
  if (!p) return []
  return snippetsForArch(arch).filter((s) => s.label.toLowerCase().startsWith(p))
}

/** 片段 -> Monaco suggestions（转成 Monaco 需要的形状） */
export function toSuggestions(list: HardwareSnippet[], range: unknown): Array<Record<string, unknown>> {
  return list.map((s) => ({
    label: s.label,
    kind: s.kind ?? SNIPPET.key,
    detail: s.detail,
    documentation: s.body.join('\n'),
    insertText: s.body.join('\n'),
    insertTextRules: 4, // InsertAsSnippet
    range
  }))
}
