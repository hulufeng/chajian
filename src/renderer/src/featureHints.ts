/**
 * featureHints.ts ——「悬停即显示」的功能介绍文案库
 * --------------------------------------------------------------------------
 * 为什么单独一个文件：文案是内容、不是组件，集中放才能一处改全应用生效，
 * 也方便逐条核对「写的是不是这个按钮真的会做的事」。
 *
 * 三条硬约束（改文案时务必遵守）：
 *   1. 只写界面上真实存在的行为。不确定的宁可不写 —— 功能介绍骗人比没有更糟。
 *   2. desc 控制在 2~3 句：说清「它做什么 / 什么时候用 / 有什么坑」，不写说明书。
 *   3. 文案不带 emoji、不带营销腔，像给旁边同事解释一句。
 *
 * 用法：<button {...hint('compile')}>…</button>
 *      悬停由全局的 FeatureHintLayer 统一接管（组件里不用写任何 hover 逻辑）。
 */

export interface FeatureHintDef {
  /** 卡片标题：功能名，尽量和界面上的叫法一致，用户才能对上号 */
  title: string
  /** 正文：做什么 / 什么时候用 / 注意什么 */
  desc: string
  /** 末行小贴士（可选）：一句经验或避坑提醒 */
  tip?: string
}

export const FEATURE_HINTS = {
  /* ---------- ① 硬链路：编译 / 烧录 / 串口 / 板卡 ---------- */
  compile: {
    title: '编译（只校验，不写板子）',
    desc: '调用 arduino-cli 把当前工程编译成板卡能跑的固件，这一步只做语法与链接检查，不会动开发板。首次编译要准备核心库会慢一些，之后走增量编译（复用同一个 build 目录），通常几秒完成。',
    tip: '编译完输出面板会给出 Flash / RAM 占用与耗时摘要；有错就按错误行改。'
  },
  upload: {
    title: '烧录（把固件写进开发板）',
    desc: '把编译产物通过串口写进开发板，写完板子立即复位运行新程序。烧录前会自动断开串口监视器（同一个串口不能一边被占用一边写），完成后自动接回去。',
    tip: '提示「找不到编译产物」时，先点一次编译再烧录。'
  },
  serial: {
    title: '串口监视器',
    desc: '按选定波特率打开开发板的串口，看 Serial.print 的输出，也能直接往板子发指令调试。波特率要和代码里 Serial.begin() 的一样，否则看到的是乱码。',
    tip: '串口和烧录抢同一个端口，所以烧录时会被自动断开。'
  },
  target: {
    title: '硬件目标（板卡 / 端口）',
    desc: '选板卡型号与串口端口 —— 它是编译和烧录的唯一依据，板卡选错，编译出来的固件就跑不对。ESP32 走 arduino-cli，STM32 走 PlatformIO，在这里切换即可。',
    tip: '板卡 / 端口只在硬件目标面板和工具链侧栏里改，全应用共用同一份。'
  },
  output: {
    title: '输出面板',
    desc: '底部面板组：编译日志、串口监视、波形、终端、问题列表都在这里切换。编译报错会列出可点击的错误行，点一下跳到对应代码，也可以交给 AI 分析。',
  },
  debug: {
    title: '片上调试器（JTAG / SWD）',
    desc: '通过 openocd + telnet 连调试器，做断点、单步、读写寄存器与内存、查看全局变量。STM32 直接可用；ESP32 需要外接 JTAG 适配器。',
    tip: '调试会占用芯片，调试期间不能烧录。'
  },

  /* ---------- ② AI 助手面板 ---------- */
  aiPanel: {
    title: 'AI 辅助编程',
    desc: '把报错、代码或需求贴进来，让它解释报错原因、改代码、给接线说明。三种通道：本地模型离线跑、自带 Key（BYOK）、官方账号登录。',
    tip: '选中一段代码再提问，它会自动带上这段代码当上下文。'
  },

  /* ---------- ③ 调试面板（底部「调试」页签） ---------- */
  debugPanel: {
    title: '调试面板',
    desc: '连上调试器后在这里下断点、单步运行、看寄存器 / 内存 / 全局变量。适合排查「编译过、烧进去了，但跑起来不对」的问题。',
  },

  /* ---------- ④ 项目与编辑器 ---------- */
  projectTree: {
    title: '项目文件树',
    desc: '打开文件夹后显示工程结构，双击文件在编辑器里打开。.ino / .cpp / .h 会按当前板卡的核心配置做补全与悬停文档。',
  },
  openProject: {
    title: '打开项目文件夹',
    desc: '选一个文件夹作为工程根目录。Arduino 工程有个硬性要求：主 .ino 文件名必须和文件夹同名，否则编译时找不到主文件。',
  },
  editor: {
    title: '代码编辑器',
    desc: '基于 Monaco：语法高亮、括号匹配、多光标，配合 clangd 提供补全 / 跳转 / 悬停文档。Ctrl+S 保存；标签上的圆点表示有未保存的改动。',
  },
  git: {
    title: 'Git 版本管理',
    desc: '看工作区改动、切分支、看提交历史并直接提交。建议每跑通一个版本就提交一次，改坏了能退回来。',
  },
  search: {
    title: '搜索 / 命令面板',
    desc: '按文件名找文件、按名字找命令，一个入口直达所有功能。记不住某个功能藏在哪儿时，先来这里搜。',
    tip: '快捷键 Ctrl+K。'
  },
  settings: {
    title: '设置',
    desc: '主题、字体、终端 Shell、AI 通道与模型、Git 等都在这里配，改动即时生效并保存在本机。',
  },
} as const satisfies Record<string, FeatureHintDef>

export type FeatureHintId = keyof typeof FEATURE_HINTS

/** 挂到元素上的 data 属性；override 用于同一功能在不同位置补一句定制说明 */
export function hint(id: FeatureHintId, override?: Partial<FeatureHintDef>): {
  'data-hint-title': string
  'data-hint-desc': string
  'data-hint-tip'?: string
} {
  // 显式标注成 FeatureHintDef：FEATURE_HINTS 是 as const，各条目字面量类型不同
  // （有的没有 tip），直接取 .tip 会被 TS 判成"该属性在某些联合分支上不存在"
  const base: FeatureHintDef = FEATURE_HINTS[id]
  const title = override?.title ?? base.title
  const desc = override?.desc ?? base.desc
  const tip = override?.tip ?? base.tip
  return tip ? { 'data-hint-title': title, 'data-hint-desc': desc, 'data-hint-tip': tip } : { 'data-hint-title': title, 'data-hint-desc': desc }
}
