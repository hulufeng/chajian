interface WelcomeViewProps {
  onOpenExample: (fileName: string) => void
  onOpenProject: () => void
  onFlash: () => void
  onAssist: () => void
  onSolve: () => void
}

const FlashIcon = (): React.JSX.Element => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.75 13.5 14.25 2.25l-1.5 8.25h7.5L9.75 21.75l1.5-8.25H3.75Z" />
  </svg>
)

const AssistIcon = (): React.JSX.Element => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
  </svg>
)

const SolveIcon = (): React.JSX.Element => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z" />
  </svg>
)

const EXAMPLES = [
  {
    file: '01-blink.ino',
    title: 'LED 闪烁',
    desc: 'GPIO 输出入门：点亮/熄灭板载 LED',
    tag: 'GPIO',
  },
  {
    file: '02-serial.ino',
    title: '串口输出',
    desc: 'Serial 通信：把数据打印到串口监视器',
    tag: '调试',
  },
  {
    file: '12-adc-pot.ino',
    title: 'ADC 电位器',
    desc: '模拟输入：读取电位器电压（0-3.3V）',
    tag: 'ADC',
  },
  {
    file: '13-sht30.ino',
    title: '温湿度传感器',
    desc: 'I2C 传感器：读取 SHT30/DHT22 温湿度',
    tag: 'I2C',
  },
]

/** 欢迎页（突出三大核心能力：烧录 / 辅助编程 / 解决问题） */
function WelcomeView({ onOpenExample, onOpenProject, onFlash, onAssist, onSolve }: WelcomeViewProps): React.JSX.Element {
  return (
    <div className="welcome-view">
      <div className="welcome-hero-banner">
        <div className="welcome-title">写码 · 烧录 · AI 辅助 · 排错，一个工具搞定</div>
        <div className="welcome-sub">从写第一行代码，到把固件烧进开发板，遇到问题 AI 帮你排查</div>
      </div>

      <div className="welcome-hero">
        <button className="welcome-hero-card flash" onClick={onFlash}>
          <span className="welcome-hero-icon"><FlashIcon /></span>
          <span className="welcome-hero-title">烧录</span>
          <span className="welcome-hero-desc">一键编译并把固件烧录到 ESP32 / 开发板</span>
          <span className="welcome-hero-tag">硬件闭环</span>
        </button>
        <button className="welcome-hero-card assist" onClick={onAssist}>
          <span className="welcome-hero-icon"><AssistIcon /></span>
          <span className="welcome-hero-title">辅助编程</span>
          <span className="welcome-hero-desc">AI 帮你写代码、改代码、解释原理</span>
          <span className="welcome-hero-tag">AI 智能体</span>
        </button>
        <button className="welcome-hero-card solve" onClick={onSolve}>
          <span className="welcome-hero-icon"><SolveIcon /></span>
          <span className="welcome-hero-title">解决问题</span>
          <span className="welcome-hero-desc">把编译 / 烧录 / 串口报错贴给 AI，自动定位并修复</span>
          <span className="welcome-hero-tag">排错诊断</span>
        </button>
      </div>

      <div className="welcome-examples">
        <div className="welcome-examples-title">或从示例工程开始</div>
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
    </div>
  )
}

export default WelcomeView
