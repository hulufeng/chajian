import { useState, useEffect } from 'react'

interface Lesson {
  id: number
  title: string
  topic: string
  wokwi: string
  ref?: string
  refLabel?: string
  example?: string
}

const CURRICULUM: Lesson[] = [
  { id: 1,  title: 'ESP32 选型与开发板', topic: '环境', wokwi: '', ref: 'https://docs.espressif.com/projects/esp-idf/zh_CN/stable/esp32/index.html', refLabel: '乐鑫官方文档' },
  { id: 2,  title: 'Arduino IDE 环境搭建', topic: '环境', wokwi: '', ref: 'https://github.com/espressif/arduino-esp32', refLabel: 'Arduino Core' },
  { id: 3,  title: '第一个程序 Blink', topic: 'GPIO', wokwi: 'https://wokwi.com/projects/new/esp32', example: '01-blink.ino', ref: 'https://github.com/espressif/arduino-esp32/tree/master/libraries/ESP32/examples/Blink', refLabel: '示例代码' },
  { id: 4,  title: '串口日志调试', topic: '调试', wokwi: 'https://wokwi.com/projects/new/esp32', example: '02-serial.ino', ref: 'https://github.com/espressif/arduino-esp32/tree/master/libraries/ESP32/examples/Serial', refLabel: '示例代码' },
  { id: 5,  title: 'GPIO 输出 - LED 控制', topic: 'GPIO', wokwi: 'https://wokwi.com/projects/new/esp32', example: '03-gpio-output.ino', ref: 'https://randomnerdtutorials.com/esp32-digital-output-blinking-led/', refLabel: '教程' },
  { id: 6,  title: 'GPIO 输入 - 按键读取', topic: 'GPIO', wokwi: 'https://wokwi.com/projects/new/esp32', example: '04-gpio-input.ino', ref: 'https://randomnerdtutorials.com/esp32-pwm-arduino-ide/', refLabel: '教程' },
  { id: 7,  title: '按键消抖', topic: 'GPIO', wokwi: 'https://wokwi.com/projects/new/esp32', example: '05-button-debounce.ino', ref: 'https://github.com/espressif/arduino-esp32/blob/master/libraries/ESP32/examples/InputDebounce/InputDebounce.ino', refLabel: '示例代码' },
  { id: 8,  title: '外部中断', topic: 'GPIO', wokwi: 'https://wokwi.com/projects/new/esp32', example: '06-interrupt.ino', ref: 'https://randomnerdtutorials.com/esp32-pinout-reference-gpios/', refLabel: '教程' },
  { id: 9,  title: '定时器', topic: '定时器', wokwi: 'https://wokwi.com/projects/new/esp32', example: '07-timer.ino', ref: 'https://github.com/espressif/arduino-esp32/tree/master/libraries/ESP32/examples/Timer', refLabel: '示例代码' },
  { id: 10, title: 'PWM - LED 呼吸灯', topic: 'PWM', wokwi: 'https://wokwi.com/projects/new/esp32', example: '08-pwm-breathe.ino', ref: 'https://randomnerdtutorials.com/esp32-pwm-arduino-ide/', refLabel: '教程' },
  { id: 11, title: 'ADC - 电位器读取', topic: 'ADC', wokwi: 'https://wokwi.com/projects/new/esp32', example: '09-adc.ino', ref: 'https://randomnerdtutorials.com/esp32-adc-analog-read-arduino-ide/', refLabel: '教程' },
  { id: 12, title: 'I2C 总线基础', topic: 'I2C', wokwi: 'https://wokwi.com/projects/new/esp32', ref: 'https://randomnerdtutorials.com/esp32-i2c-communication-arduino-ide/', refLabel: '教程' },
  { id: 13, title: 'I2C 温湿度传感器 SHT30', topic: 'I2C', wokwi: 'https://wokwi.com/projects/new/esp32', ref: 'https://randomnerdtutorials.com/esp32-sht30-arduino-ide/', refLabel: '教程' },
  { id: 14, title: 'SPI 总线与 OLED 屏', topic: 'SPI', wokwi: 'https://wokwi.com/projects/new/esp32', ref: 'https://randomnerdtutorials.com/esp32-ssd1306-oled-display-arduino-ide/', refLabel: '教程' },
  { id: 15, title: 'WiFi STA 连接', topic: 'WiFi', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-useful-wi-fi-functions-arduino/', refLabel: '教程' },
  { id: 16, title: 'HTTP 请求温湿度 API', topic: '网络', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-http-get-post-arduino/', refLabel: '教程' },
  { id: 17, title: 'JSON 数据解析', topic: '数据', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-json-arduino/', refLabel: '教程' },
  { id: 18, title: 'NTP 网络时间同步', topic: '网络', wokwi: '', ref: 'https://github.com/espressif/arduino-esp32/tree/master/libraries/ESP32/examples/NTPClient', refLabel: '示例代码' },
  { id: 19, title: 'MQTT 基础与 Mosquitto', topic: 'MQTT', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-mqtt-publisher-subscriber-arduino/', refLabel: '教程' },
  { id: 20, title: 'MQTT 上报温湿度', topic: 'MQTT', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-mqtt-temperature-monitoring/', refLabel: '教程' },
  { id: 21, title: 'WiFi AP 模式与 Web 配网', topic: 'WiFi', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-access-point-ap-web-server/', refLabel: '教程' },
  { id: 22, title: 'Web 服务器控制 LED', topic: 'Web', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-web-server-arduino-ide/', refLabel: '教程' },
  { id: 23, title: '蓝牙 BLE 基础', topic: 'BLE', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-bluetooth-low-energy-ble-arduino-ide/', refLabel: '教程' },
  { id: 24, title: '低功耗 Deep-sleep', topic: '低功耗', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-deep-sleep-arduino-ide-wake-up-sources/', refLabel: '教程' },
  { id: 25, title: 'OTA 空中升级', topic: 'OTA', wokwi: '', ref: 'https://github.com/espressif/arduino-esp32/tree/master/libraries/ESP32/examples/ArduinoOTA', refLabel: '示例代码' },
  { id: 26, title: '项目：环境监测节点（上）', topic: '项目', wokwi: '', ref: 'https://github.com/yohanes-erwin/arduinoml/tree/master/esp32_examples', refLabel: '项目源码' },
  { id: 27, title: '项目：环境监测节点（下）', topic: '项目', wokwi: '', ref: 'https://github.com/yohanes-erwin/arduinoml/tree/master/esp32_examples', refLabel: '项目源码' },
  { id: 28, title: '项目：手机蓝牙遥控灯', topic: '项目', wokwi: '', ref: 'https://gitee.com/lan2003/esp32s3-ai-chat', refLabel: '参考项目' },
  { id: 29, title: '项目：Web 温控风扇', topic: '项目', wokwi: '', ref: 'https://randomnerdtutorials.com/esp32-web-server-temperature-sensor-ds18b20/', refLabel: '教程' },
  { id: 30, title: '毕业：温湿度 MQTT 节点', topic: '项目', wokwi: '', ref: 'https://github.com/espressif/esp-jumpstart', refLabel: '官方教程' },
]

const STORAGE_KEY = 'codelab-curriculum-progress'

function loadProgress(): Record<number, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

interface CurriculumPanelProps {
  onOpenExample?: (fileName: string) => void
  onOpenWokwi?: (exampleFile: string) => void
  onSelectLesson?: (id: number) => void
  selectedLessonId?: number | null
}

function CurriculumPanel({ onOpenExample, onOpenWokwi, onSelectLesson, selectedLessonId }: CurriculumPanelProps): React.JSX.Element {
  const [progress, setProgress] = useState<Record<number, boolean>>({})

  useEffect(() => {
    setProgress(loadProgress())
  }, [])

  const doneCount = Object.values(progress).filter(Boolean).length
  const percent = Math.round((doneCount / CURRICULUM.length) * 100)

  const toggleDone = (id: number) => {
    const p = { ...progress, [id]: !progress[id] }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    setProgress(p)
  }

  const openUrl = (url: string) => {
    if (!url) return
    window.open(url, '_blank')
  }

  const openWokwi = (lesson: Lesson) => {
    if (onOpenWokwi && lesson.example) {
      onOpenWokwi(lesson.example)
    }
  }

  const handleClick = (lesson: Lesson) => {
    if (onSelectLesson) onSelectLesson(lesson.id)
  }

  return (
    <div className="curriculum-panel">
      <div className="curriculum-header">
        <h3>ESP32 30天入门</h3>
        <div className="curriculum-progress-info">{doneCount} / {CURRICULUM.length} 天完成</div>
        <div className="curriculum-progress-bar">
          <div className="curriculum-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="curriculum-list">
        {CURRICULUM.map((lesson) => {
          const done = !!progress[lesson.id]
          return (
            <div
              key={lesson.id}
              className={`curriculum-item ${done ? 'done' : ''} ${selectedLessonId === lesson.id ? 'selected' : ''}`}
              onClick={() => handleClick(lesson)}
            >
              <div className="curriculum-check">
                {done ? '✓' : lesson.id}
              </div>
              <div className="curriculum-title">{lesson.title}</div>
              <div className="curriculum-topic">{lesson.topic}</div>
              {lesson.example && (
                <button
                  className="curriculum-wokwi-btn"
                  onClick={(e) => { e.stopPropagation(); openWokwi(lesson) }}
                  title="在软件内仿真运行"
                >
                  ▶
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default CurriculumPanel
