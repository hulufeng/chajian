interface WelcomeViewProps {
  onOpenExample: (fileName: string) => void
  onOpenProject: () => void
}

const EXAMPLES = [
  {
    file: '01-blink.ino',
    title: '💡 LED 闪烁',
    desc: 'GPIO 输出入门：点亮/熄灭板载 LED',
    tag: 'GPIO',
  },
  {
    file: '02-serial.ino',
    title: '📡 串口输出',
    desc: 'Serial 通信：把数据打印到串口监视器',
    tag: '调试',
  },
  {
    file: '12-adc-pot.ino',
    title: '🎛 ADC 电位器',
    desc: '模拟输入：读取电位器电压（0-3.3V）',
    tag: 'ADC',
  },
  {
    file: '13-sht30.ino',
    title: '🌡 温湿度传感器',
    desc: 'I2C 传感器：读取 SHT30/DHT22 温湿度',
    tag: 'I2C',
  },
]

/** 欢迎页（对齐 TrieCode：冷启动引导 + 场景示例卡，点卡即开示例工程） */
function WelcomeView({ onOpenExample, onOpenProject }: WelcomeViewProps): React.JSX.Element {
  return (
    <div className="welcome-view">
      <div className="welcome-title">我们要一起做些什么？</div>
      <div className="welcome-sub">提问、写代码、编译、仿真、烧录——都可以告诉我</div>

      <div className="welcome-grid">
        {EXAMPLES.map((e) => (
          <button key={e.file} className="welcome-card" onClick={() => onOpenExample(e.file)}>
            <div className="welcome-card-title">{e.title}</div>
            <div className="welcome-card-desc">{e.desc}</div>
            <span className="welcome-card-tag">{e.tag}</span>
          </button>
        ))}
      </div>

      <div className="welcome-actions">
        <button className="welcome-open" onClick={onOpenProject}>打开项目…</button>
        <span className="welcome-hint">或点击上方示例卡，直接打开一个可编译、可仿真、可烧录的 ESP32 工程</span>
      </div>
    </div>
  )
}

export default WelcomeView
