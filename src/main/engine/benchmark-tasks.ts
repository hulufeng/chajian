/**
 * 标准任务实测集（商业化 P1 · 方向二 §5.1）
 * ---------------------------------------------------------------------------
 * 分级：L1 基础 / L2 组合 / L3 系统 / L4 调试（注入错误，验证自修复）。
 * 目标规模 20~30 条；本文件先落地 L1×10 + L2×2 + L4×2 作为骨架，
 * 后续按同结构追加即可（每条只改数据，不改运行器）。
 *
 * 每条任务由运行器（benchmark.ts）驱动 AgentRunner 在独立临时工程里跑，
 * 跑完按 verify 客观判定是否通过（编译 / 文件 / 片段 / 禁含）。
 */

export type BenchFramework = 'arduino' | 'espidf'
export type Scaffold = 'empty' | 'blink' | 'broken' | { copyFrom: string }

export interface BenchmarkTask {
  id: string
  level: 1 | 2 | 3 | 4
  title: string
  /** 发给 Agent 的任务描述（自然语言，模拟真实用户） */
  prompt: string
  framework: BenchFramework
  /** Arduino 编译用 FQBN；缺省 esp32:esp32:esp32dev */
  fqbn?: string
  scaffold?: Scaffold
  verify: {
    compile?: boolean
    expectFiles?: string[]
    expectContains?: Array<{ file: string; text: string }>
    forbidPatterns?: string[]
  }
}

const ESP32 = 'esp32:esp32:esp32dev'

export const defaultBenchmarkTasks: BenchmarkTask[] = [
  // ───────────────────────── L1 基础 ─────────────────────────
  {
    id: 'L1-01-blink', level: 1, title: '板载 LED 1Hz 闪烁', framework: 'arduino', fqbn: ESP32,
    prompt: '用 ESP32 写一个程序，让板载 LED 以 1Hz 频率闪烁（亮 500ms 灭 500ms）。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'digitalWrite' }] }
  },
  {
    id: 'L1-02-pwm-fade', level: 1, title: 'LED 呼吸灯(PWM)', framework: 'arduino', fqbn: ESP32,
    prompt: '用 ESP32 的 PWM 做一个 LED 呼吸灯效果（亮度从 0 渐变到最大再渐变回来，循环）。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'ledc' }] }
  },
  {
    id: 'L1-03-button-toggle', level: 1, title: '按键切换 LED', framework: 'arduino', fqbn: ESP32,
    prompt: 'ESP32 接一个按键（上拉）和一个 LED，按下按键切换 LED 的亮灭状态（带软件消抖）。',
    scaffold: 'empty',
    verify: { compile: true }
  },
  {
    id: 'L1-04-serial-hello', level: 1, title: '串口定时打印', framework: 'arduino', fqbn: ESP32,
    prompt: 'ESP32 上电后每秒通过串口打印一次 "Hello ESP32" 和当前运行秒数（波特率 115200）。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'Serial.println' }] }
  },
  {
    id: 'L1-05-read-dht11', level: 1, title: 'DHT11 温湿度', framework: 'arduino', fqbn: ESP32,
    prompt: '用 ESP32 读取 DHT11 温湿度传感器，每秒通过串口打印温度和湿度。如果缺少库请先安装 DHT 库。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'DHT' }] }
  },
  {
    id: 'L1-06-read-bh1750', level: 1, title: 'BH1750 光照(I2C)', framework: 'arduino', fqbn: ESP32,
    prompt: '用 ESP32 通过 I2C 读取 BH1750 光照强度传感器，串口打印 lux 值。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'Wire' }] }
  },
  {
    id: 'L1-07-read-bme280', level: 1, title: 'BME280 温湿压(I2C)', framework: 'arduino', fqbn: ESP32,
    prompt: '用 ESP32 通过 I2C 读取 BME280 的温度、湿度和气压，串口打印。',
    scaffold: 'empty',
    verify: { compile: true }
  },
  {
    id: 'L1-08-hcsr04', level: 1, title: 'HC-SR04 超声波测距', framework: 'arduino', fqbn: ESP32,
    prompt: '用 ESP32 接 HC-SR04 超声波模块测量距离，串口每 500ms 打印一次距离（厘米）。',
    scaffold: 'empty',
    verify: { compile: true }
  },
  {
    id: 'L1-09-adc-pot', level: 1, title: '电位器 ADC 读电压', framework: 'arduino', fqbn: ESP32,
    prompt: 'ESP32 接一个电位器到 ADC 引脚，读取模拟值并换算成电压（0~3.3V），串口打印。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'analogRead' }] }
  },
  {
    id: 'L1-10-wifi-scan', level: 1, title: 'WiFi 扫描', framework: 'arduino', fqbn: ESP32,
    prompt: 'ESP32 启动后扫描附近 WiFi 网络，串口打印每个网络的 SSID 与信号强度（RSSI）。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'WiFi.scanNetworks' }] }
  },

  // ───────────────────────── L2 组合 ─────────────────────────
  {
    id: 'L2-01-wifi-mqtt', level: 2, title: 'WiFi+MQTT 上报', framework: 'arduino', fqbn: ESP32,
    prompt: 'ESP32 连接 WiFi 后，每 5 秒通过 MQTT 上报一次随机温度到主题 labcode/telemetry（ broker 用 test.mosquitto.org，端口 1883）。只需编译通过即可，无需真实 broker。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'PubSubClient' }] }
  },
  {
    id: 'L2-02-web-server', level: 2, title: 'Web 控制面板', framework: 'arduino', fqbn: ESP32,
    prompt: 'ESP32 连 WiFi 后启动一个 Web 服务器，访问根路径返回一个页面，上面有两个按钮可开关板载 LED。只需编译通过。',
    scaffold: 'empty',
    verify: { compile: true, expectContains: [{ file: 'sketch.ino', text: 'WiFiServer' }] }
  },

  // ───────────────────────── L4 调试（注入错误，验自修复）─────────────────────────
  {
    id: 'L4-01-fix-missing-semicolon', level: 4, title: '修复缺失分号', framework: 'arduino', fqbn: ESP32,
    prompt: '这个工程编译报错，请找出并修复编译错误，让它编译通过。',
    scaffold: 'broken',
    verify: { compile: true }
  },
  {
    id: 'L4-02-fix-undeclared-symbol', level: 4, title: '修复未声明符号', framework: 'arduino', fqbn: ESP32,
    prompt: '这个工程编译报错（有未定义的符号），请修复让它编译通过。',
    scaffold: 'broken',
    verify: { compile: true }
  }
]
