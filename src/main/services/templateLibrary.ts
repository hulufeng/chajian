/**
 * 示例/模板库（差异化功能 #2）
 *
 * 两层来源：
 *  1) 内置模板（本文件，针对 ESP32 Arduino core 3.x 的真实可用代码）；
 *  2) 打包内置示例：读 <app>/examples 目录下的 *.ino，直接作为「示例」模板（用户也能往里加）。
 * 推荐做法：新建工程时选模板 → 生成可直接编译的真实文件，不是占位注释。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface TemplateFile {
  path: string
  content: string
}

export interface TemplateItem {
  id: string
  name: string
  desc: string
  category: '入门' | '外设' | '网络' | '低功耗' | '示例'
  files: TemplateFile[]
}

const README = (title: string, lines: string[]): string =>
  ['# ' + title, '', ...lines, ''].join('\n')

// ── 内置模板 ────────────────────────────────────────────────
const INTERNAL_TEMPLATES: TemplateItem[] = [
  {
    id: 'blink',
    name: 'LED 闪烁（最小工程）',
    desc: '板载 LED 每 500ms 翻转，验证工具链可用性',
    category: '入门',
    files: [
      {
        path: 'Blink.ino',
        content:
          '// 板载 LED 闪烁 —— 最小可编译工程\n' +
          '// 引脚：LED_BUILTIN（ESP32 开发板多为 GPIO2，部分 S3 板卡为 GPIO48）\n' +
          'const int ledPin = LED_BUILTIN;\n' +
          '\n' +
          'void setup() {\n' +
          '  pinMode(ledPin, OUTPUT);\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  digitalWrite(ledPin, HIGH);\n' +
          '  delay(500);\n' +
          '  digitalWrite(ledPin, LOW);\n' +
          '  delay(500);\n' +
          '}\n'
      },
      {
        path: 'README.md',
        content: README('LED 闪烁', [
          '用板载 LED 做最简单的高低电平翻转，用来确认「编译 + 烧录 + 串口」整条链路通。',
          '',
          '- 主文件：`Blink.ino`',
          '- 关键 API：`pinMode` / `digitalWrite` / `delay`',
          '- 预期现象：板载 LED 1 秒一次明暗交替。',
          '- 烧录后若串口无输出属正常，本例没有打印。'
        ])
      }
    ]
  },
  {
    id: 'serial-echo',
    name: '串口回显（ prints + 命令解析）',
    desc: '串口打印与接收，带简单命令解析（HELP/ON/OFF/UP）',
    category: '入门',
    files: [
      {
        path: 'SerialEcho.ino',
        content:
          '// 串口回显 + 极简命令解析\n' +
          'const int ledPin = LED_BUILTIN;\n' +
          'String buf;\n' +
          '\n' +
          'void setup() {\n' +
          '  pinMode(ledPin, OUTPUT);\n' +
          '  Serial.begin(115200);\n' +
          '  delay(200);\n' +
          '  Serial.println(F("LabCode 串口就绪，输入 HELP 看命令")); // F() 宏把常量放进 flash，省 RAM\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  while (Serial.available()) {\n' +
          '    char c = Serial.read();\n' +
          '    if (c == \'\\n\' || c == \'\\r\') {\n' +
          '      if (buf.length() > 0) handleCmd(buf);\n' +
          '      buf = "";\n' +
          '    } else {\n' +
          '      buf += c;\n' +
          '    }\n' +
          '  }\n' +
          '}\n' +
          '\n' +
          'void handleCmd(String cmd) {\n' +
          '  cmd.trim();\n' +
          '  if (cmd == "HELP") {\n' +
          '    Serial.println(F("ON=点亮 OFF=熄灭 UP=亮50%  UP110=全亮"));\n' +
          '  } else if (cmd == "ON") {\n' +
          '    digitalWrite(ledPin, HIGH);\n' +
          '  } else if (cmd == "OFF") {\n' +
          '    digitalWrite(ledPin, LOW);\n' +
          '  } else if (cmd.startsWith("UP")) {\n' +
          '    int pct = cmd.substring(2).toInt();\n' +
          '    analogWrite(ledPin, map(constrain(pct, 0, 100), 0, 100, 0, 255)); // ESP32 上 analogWrite 内部走 LEDC\n' +
          '  } else {\n' +
          '    Serial.print(F("未知命令: "));\n' +
          '    Serial.println(cmd);\n' +
          '  }\n' +
          '}\n'
      }
    ]
  },
  {
    id: 'pwm-breathe',
    name: 'PWM 呼吸灯（LEDC 新 API）',
    desc: 'ledcAttach + ledcWrite 渐变，兼容 ESP32 Arduino core 3.x',
    category: '外设',
    files: [
      {
        path: 'PwmBreathe.ino',
        content:
          '// LEDC PWM 呼吸灯（core 3.x 新 API：ledcAttach(pin, freq, resolution) + ledcWrite(channel, duty)）\n' +
          'const int pwmPin = 2;\n' +
          'const int channel = 0;\n' +
          'const int freq = 5000;\n' +
          'const int resolution = 10; // 最大占空比 1023\n' +
          '\n' +
          'void setup() {\n' +
          '  ledcAttach(pwmPin, freq, resolution);\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  for (int duty = 0; duty <= 1023; duty += 8) {\n' +
          '    ledcWrite(channel, duty);\n' +
          '    delay(8);\n' +
          '  }\n' +
          '  for (int duty = 1023; duty >= 0; duty -= 8) {\n' +
          '    ledcWrite(channel, duty);\n' +
          '    delay(8);\n' +
          '  }\n' +
          '}\n'
      }
    ]
  },
  {
    id: 'adc-read',
    name: 'ADC 采样（电位器 → 串口）',
    desc: 'ADC 读数 + 简单滤波 + 电压换算',
    category: '外设',
    files: [
      {
        path: 'AdcRead.ino',
        content:
          '// ADC 采样：电位器中间脚接 GPIO4，两端接 3V3 / GND\n' +
          'const int adcPin = 4;\n' +
          'const float vref = 3.3f;\n' +
          'const int adcMax = 4095; // ESP32 ADC 12bit\n' +
          '\n' +
          'int rawAvg() {\n' +
          '  long sum = 0;\n' +
          '  for (int i = 0; i < 16; i++) {\n' +
          '    sum += analogRead(adcPin);\n' +
          '    delay(4);\n' +
          '  }\n' +
          '  return (int)(sum / 16);\n' +
          '}\n' +
          '\n' +
          'void setup() { Serial.begin(115200); }\n' +
          '\n' +
          'void loop() {\n' +
          '  int raw = rawAvg();\n' +
          '  float voltage = (float)raw / adcMax * vref;\n' +
          '  Serial.print("raw=");\n' +
          '  Serial.print(raw);\n' +
          '  Serial.print("  voltage=");\n' +
          '  Serial.print(voltage, 3);\n' +
          '  Serial.println(" V");\n' +
          '  delay(200);\n' +
          '}\n'
      }
    ]
  },
  {
    id: 'i2c-scan',
    name: 'I2C 地址扫描',
    desc: '扫出挂在 I2C 上的设备地址，排查接线/地址冲突',
    category: '外设',
    files: [
      {
        path: 'I2cScan.ino',
        content:
          '// I2C 扫描：SDA=GPIO21 SCL=GPIO22（ESP32 默认，多数开发板一致）\n' +
          'void setup() {\n' +
          '  Serial.begin(115200);\n' +
          '  Wire.begin(21, 22);\n' +
          '  Serial.println(F("I2C 扫描开始（SDA=21, SCL=22）"));\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  byte addr;\n' +
          '  int found = 0;\n' +
          '  for (addr = 1; addr < 127; addr++) {\n' +
          '    Wire.beginTransmission(addr);\n' +
          '    byte err = Wire.endTransmission();\n' +
          '    if (err == 0) {\n' +
          '      Serial.print(F("找到设备 0x"));\n' +
          '      if (addr < 16) Serial.print("0");\n' +
          '      Serial.println(addr, HEX);\n' +
          '      found++;\n' +
          '    } else if (err == 4) {\n' +
          '      Serial.print(F("地址 0x"));\n' +
          '      Serial.print(addr, HEX);\n' +
          '      Serial.println(F(" 不可知错误")); // 多半是地址越界\n' +
          '    }\n' +
          '  }\n' +
          '  Serial.print(F("扫描完成，共 "));\n' +
          '  Serial.print(found);\n' +
          '  Serial.println(F(" 个设备"));\n' +
          '  delay(5000);\n' +
          '}\n'
      }
    ]
  },
  {
    id: 'oled-ssd1306',
    name: 'OLED 显示（SSD1306 + U8g2 风格 Adafruit 库）',
    desc: '128x64 I2C OLED 显示文本与数值',
    category: '外设',
    files: [
      {
        path: 'OledHello.ino',
        content:
          '// 0.96" I2C OLED（SSD1306，128x64）\n' +
          '// 依赖库：Adafruit GFX + Adafruit SSD1306（库管理器里搜 SSD1306 安装）\n' +
          '// 接线：VCC→3V3，GND→GND，SDA→GPIO21，SCL→GPIO22\n' +
          '#include <Wire.h>\n' +
          '#include <Adafruit_GFX.h>\n' +
          '#include <Adafruit_SSD1306.h>\n' +
          '\n' +
          '#define SCREEN_W 128\n' +
          '#define SCREEN_H 64\n' +
          '#define OLED_ADDR 0x3C\n' +
          'Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1); // -1 = 不分频 OLED_RESET 脚\n' +
          '\n' +
          'void setup() {\n' +
          '  Serial.begin(115200);\n' +
          '  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) { // 初始化失败多为 I2C 地址/接线问题\n' +
          '    Serial.println(F("SSD1306 初始化失败，检查 0x3C 地址与 SDA/SCL 接线")); // 常见地址 0x3C / 0x3D\n' +
          '    for (;;) {}\n' +
          '  }\n' +
          '  display.clearDisplay();\n' +
          '  display.setTextSize(2);\n' +
          '  display.setTextColor(SSD1306_WHITE);\n' +
          '  display.setCursor(0, 20);\n' +
          '  display.println(F("LabCode")); // F() 省 RAM\n' +
          '  display.display();\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  display.clearDisplay();\n' +
          '  display.setCursor(0, 0);\n' +
          '  display.println(F("ADC:"));\n' +
          '  display.println(analogRead(4));\n' +
          '  display.display();\n' +
          '  delay(500);\n' +
          '}\n'
      }
    ]
  },
  {
    id: 'button-interrupt',
    name: '按键中断 + 消抖',
    desc: 'attachInterrupt 硬件消抖计数，串口打印',
    category: '外设',
    files: [
      {
        path: 'ButtonInterrupt.ino',
        content:
          '// 按键外部中断（GPIO0 带 boot 键，用它做演示最方便；也可用 GPIO4 等普通脚）\n' +
          'const int btnPin = 0; // 部分板卡此脚为 strapping/BOOT，接按键很常见\n' +
          'volatile unsigned long count = 0;\n' +
          'unsigned long lastPrint = 0;\n' +
          '\n' +
          'void IRAM_ATTR isr() { // 中断服务函数放 IRAM，避免 flash cache 未就绪时丢中断\n' +
          '  count++;\n' +
          '}\n' +
          '\n' +
          'void setup() {\n' +
          '  Serial.begin(115200);\n' +
          '  pinMode(btnPin, INPUT_PULLUP); // 按键另一端接地\n' +
          '  attachInterrupt(digitalPinToInterrupt(btnPin), isr, FALLING);\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  if (millis() - lastPrint > 500) { // 软件层面再消抖一次，避免抖动连击\n' +
          '    lastPrint = millis();\n' +
          '    Serial.print("count=");\n' +
          '    Serial.println(count);\n' +
          '  }\n' +
          '}\n'
      }
    ]
  },
  {
    id: 'wifi-sta',
    name: 'WiFi STA 连网',
    desc: '连接路由器 + 状态打印（把 ssid/pass 换成你自己的）',
    category: '网络',
    files: [
      {
        path: 'WifiSta.ino',
        content:
          '// WiFi  stations 模式连接路由器\n' +
          '#include <WiFi.h>\n' +
          '\n' +
          'const char* ssid = "YOUR_WIFI_SSID";   // ← 改这里\n' +
          'const char* password = "YOUR_WIFI_PASS"; // ← 改这里（WPA 至少 8 位）\n' +
          '\n' +
          'void setup() {\n' +
          '  Serial.begin(115200);\n' +
          '  WiFi.mode(WIFI_STA);\n' +
          '  WiFi.begin(ssid, password);\n' +
          '  Serial.print(F("连接 "));\n' +
          '  Serial.print(ssid);\n' +
          '  while (WiFi.status() != WL_CONNECTED) { // 最长等 20 秒\n' +
          '    delay(500);\n' +
          '    Serial.print(".");\n' +
          '    if (millis() > 20000) {\n' +
          '      Serial.println(F("\\n连接失败，检查 WiFi 名称/密码，或 2.4G 频段（ESP32 不支持 5G）"));\n' +
          '      break;\n' +
          '    }\n' +
          '  }\n' +
          '  if (WiFi.status() == WL_CONNECTED) {\n' +
          '    Serial.println();\n' +
          '    Serial.print(F("IP: "));\n' +
          '    Serial.println(WiFi.localIP());\n' +
          '  }\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  if (WiFi.status() == WL_CONNECTED) {\n' +
          '    Serial.print(F("RSSI="));\n' +
          '    Serial.println(WiFi.RSSI());\n' +
          '  }\n' +
          '  delay(5000);\n' +
          '}\n'
      }
    ]
  },
  {
    id: 'deep-sleep',
    name: '深度睡眠 + 定时唤醒',
    desc: 'esp_sleep 定时唤醒，记录唤醒次数（RTC memory 保持计数）',
    category: '低功耗',
    files: [
      {
        path: 'DeepSleep.ino',
        content:
          '// 深度睡眠：每 10 秒唤醒一次，用 RTC 内存记住唤醒次数（复位后也不丢）\n' +
          '#include <esp_sleep.h>\n' +
          '\n' +
          'RTC_DATA_ATTR uint32_t wakeCount = 0; // RTC_DATA_ATTR：睡眠期间保持\n' +
          '\n' +
          'void setup() {\n' +
          '  Serial.begin(115200);\n' +
          '  delay(100);\n' +
          '  wakeCount++;\n' +
          '  Serial.print(F("第 "));\n' +
          '  Serial.print(wakeCount);\n' +
          '  Serial.println(F(" 次唤醒，进入深睡 10 秒")); // RTC 计数在深睡后保留\n' +
          '  esp_sleep_enable_timer_wakeup(10 * 1000000); // 微秒\n' +
          '  esp_deep_sleep_start();\n' +
          '}\n' +
          '\n' +
          'void loop() {}\n'
      }
    ]
  },
  {
    id: 'motor-tb6612',
    name: 'TB6612 双路直流电机',
    desc: '两路 PWM 控速 + 方向，带停止/刹车',
    category: '外设',
    files: [
      {
        path: 'MotorTb6612.ino',
        content:
          '// TB6612 双路电机驱动（PWMA=A11, AIN1=A12, AIN2=A13；PWMB=B11, BIN1=B12, BIN2=B13）\n' +
          '// 按实际接线改下面 6 个引脚即可\n' +
          'const int PWMA = 25, AIN1 = 26, AIN2 = 27;\n' +
          'const int PWMB = 14, BIN1 = 12, BIN2 = 13;\n' +
          '\n' +
          'void motorA(int speed) { // speed: -255 ~ 255\n' +
          '  if (speed > 0)      { digitalWrite(AIN1, HIGH); digitalWrite(AIN2, LOW); }\n' +
          '  else if (speed < 0) { digitalWrite(AIN1, LOW);  digitalWrite(AIN2, HIGH); }\n' +
          '  else                { digitalWrite(AIN1, LOW);  digitalWrite(AIN2, LOW); } // 同时低电平=刹车\n' +
          '  ledcAttach(PWMA, 1000, 8);\n' +
          '  ledcWrite(0, abs(speed));\n' +
          '}\n' +
          '\n' +
          'void motorB(int speed) {\n' +
          '  if (speed > 0)      { digitalWrite(BIN1, HIGH); digitalWrite(BIN2, LOW); }\n' +
          '  else if (speed < 0) { digitalWrite(BIN1, LOW);  digitalWrite(BIN2, HIGH); }\n' +
          '  else                { digitalWrite(BIN1, LOW);  digitalWrite(BIN2, LOW); }\n' +
          '  ledcAttach(PWMB, 1000, 8);\n' +
          '  ledcWrite(1, abs(speed));\n' +
          '}\n' +
          '\n' +
          'void setup() {\n' +
          '  pinMode(AIN1, OUTPUT); pinMode(AIN2, OUTPUT);\n' +
          '  pinMode(BIN1, OUTPUT); pinMode(BIN2, OUTPUT);\n' +
          '  Serial.begin(115200);\n' +
          '}\n' +
          '\n' +
          'void loop() {\n' +
          '  motorA(200); motorB(200);\n' +
          '  delay(2000);\n' +
          '  motorA(-200); motorB(-200);\n' +
          '  delay(2000);\n' +
          '  motorA(0); motorB(0);\n' +
          '  delay(1000);\n' +
          '}\n'
      }
    ]
  }
]

// ── 打包内置示例目录 ────────────────────────────────────────
function examplesDir(): string {
  const dir = app.isPackaged ? path.join(process.resourcesPath || '', 'examples') : path.join(app.getAppPath(), 'examples')
  return fs.existsSync(dir) ? dir : path.join(app.getAppPath(), 'examples')
}

/** 把 examples/*.ino 读成「示例」模板（多文件内容只取同名 .ino）。 */
function loadExampleTemplates(): TemplateItem[] {
  const dir = examplesDir()
  if (!fs.existsSync(dir)) return []
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.ino'))
      .map((f) => ({
        id: `example:${f}`,
        name: `示例 · ${f.replace(/\.ino$/i, '')}`,
        desc: `内置示例 ${f}（来自 examples 目录，可直接复制改造）`,
        category: '示例' as const,
        files: [{ path: f, content: fs.readFileSync(path.join(dir, f), 'utf-8') }]
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** 列出全部模板（内置 + 打包示例），category 用于 UI 分组。 */
export function listTemplates(): TemplateItem[] {
  return [...INTERNAL_TEMPLATES, ...loadExampleTemplates()]
}

export function getTemplate(id: string): TemplateItem | null {
  return listTemplates().find((t) => t.id === id) || null
}

export interface MaterializeResult {
  files: string[]
  bytes: number
}

/** 把模板写入目标目录（先建目录，再逐个写文件）。 */
export function materializeTemplate(id: string, targetDir: string): MaterializeResult {
  const tpl = getTemplate(id)
  if (!tpl) throw new Error(`模板不存在：${id}（可用模板：${listTemplates().map((t) => t.id).join(', ')}）`)
  const root = path.resolve(targetDir)
  fs.mkdirSync(root, { recursive: true })
  const written: string[] = []
  let bytes = 0
  for (const f of tpl.files) {
    const dest = path.join(root, f.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, f.content, 'utf-8')
    written.push(path.relative(root, dest) || f.path)
    bytes += Buffer.byteLength(f.content, 'utf-8')
  }
  return { files: written, bytes }
}

/** 模板分组（给 UI 用）。 */
export function groupTemplates(): Array<{ category: string; items: TemplateItem[] }> {
  const map = new Map<string, TemplateItem[]>()
  for (const t of listTemplates()) {
    const list = map.get(t.category) || []
    list.push(t)
    map.set(t.category, list)
  }
  return [...map.entries()].map(([category, items]) => ({ category, items }))
}
