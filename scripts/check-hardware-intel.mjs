/**
 * 硬件智能增强自检（纯数据 / 纯函数，不依赖 Electron、不依赖 clangd）。
 * 覆盖 #32 代码片段库（片段形态 / 架构过滤 / 前缀匹配 / 3.x PWM API 正确性）
 * 与 #33 悬停知识库（函数查得着 / 引脚宏 / 合并悬停 / 未知词返回 null）。
 * 用法：node scripts/check-hardware-intel.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'hw-'))

async function load(rel, name) {
  const outfile = join(tmp, `${name}.mjs`)
  buildSync({ entryPoints: [join(root, rel)], bundle: true, format: 'esm', platform: 'node', outfile })
  return import('file://' + outfile.replace(/\\/g, '/'))
}

const snip = await load('src/renderer/src/components/editor/hardwareSnippets.ts', 'snip')
const hov = await load('src/renderer/src/components/editor/pinHover.ts', 'hov')

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── #32 代码片段 ──
const ALL = snip.HARDWARE_SNIPPETS
check('片段库非空', Array.isArray(ALL) && ALL.length > 0)
check('每条都有 label/detail/body/arch', ALL.every((s) => s.label && s.detail && Array.isArray(s.body) && s.arch))
check('body 是行数组（便于拼接）', ALL.every((s) => s.body.every((l) => typeof l === 'string')))
check('label 唯一（补全不重名）', new Set(ALL.map((s) => s.label)).size === ALL.length)

// 架构过滤
const esp = snip.snippetsForArch('esp32')
const stm = snip.snippetsForArch('stm32')
check('esp32 含 WiFi 片段', esp.some((s) => s.label === 'wifista'))
check('esp32 不含 stm32 专属片段', !esp.some((s) => s.arch === 'stm32'))
check('stm32 含 HAL 片段', stm.some((s) => s.label === 'stm32hal_gpio'))
check('stm32 不含 esp32 专属片段', !stm.some((s) => s.arch === 'esp32'))
check('any 架构两者都能拿到通用骨架', esp.some((s) => s.label === 'sketch') && stm.some((s) => s.label === 'sketch'))

// 关键事实：arduino-esp32 3.x 的 PWM 已换 API，片段必须用新 API
const pwm = ALL.find((s) => s.label === 'ledcpwm')
const pwmText = pwm.body.join('\n')
check('PWM 用新 API ledcAttach（3.x）', pwmText.includes('ledcAttach'))
check('PWM 用新 API ledcWrite（3.x）', pwmText.includes('ledcWrite'))
check('PWM 不用已废弃的 ledcSetup', !pwmText.includes('ledcSetup'))
check('PWM 不用已废弃的 ledcAttachPin', !pwmText.includes('ledcAttachPin'))
check('PWM 片段标为 esp32 专属', pwm.arch === 'esp32')

// WiFi 片段要给超时保护（死等是新手最常见的坑）
check('WiFi 片段有超时/重试（不死等）', (ALL.find((s) => s.label === 'wifista').body.join('\n')).includes('tries'))

// 前缀匹配
check('前缀匹配命中', snip.matchSnippets('wifi', 'esp32').length >= 2)
check('前缀匹配大小写不敏感', snip.matchSnippets('WIFI', 'esp32').length === snip.matchSnippets('wifi', 'esp32').length)
check('空前缀返回空（不刷屏）', snip.matchSnippets('', 'esp32').length === 0)
check('无匹配返回空', snip.matchSnippets('zzzz', 'esp32').length === 0)

// suggestion 转换
const sug = snip.toSuggestions(snip.snippetsForArch('esp32'), { fake: 'range' })
check('转换出 suggestion 数组', Array.isArray(sug) && sug.length === esp.length)
check('suggestion 带 snippet 插入规则(4)', sug.every((s) => s.insertTextRules === 4))
check('suggestion 保留 range', sug.every((s) => s.range && s.range.fake === 'range'))
check('suggestion kind=15(Snippet)', sug.every((s) => s.kind === 15))

// ── #33 悬停知识 ──
check('查得到 pinMode', !!hov.hoverFor('pinMode'))
check('查得到 digitalWrite', !!hov.hoverFor('digitalWrite'))
check('查得到 Serial.printf', !!hov.hoverFor('Serial.printf'))
check('查得到 WiFi.begin', !!hov.hoverFor('WiFi.begin'))
check('未知词返回 null（不弹空窗）', hov.hoverFor('someRandomFn') === null)
check('引脚宏 GPIO_NUM_2 命中', !!hov.pinDoc('GPIO_NUM_2'))
check('引脚宏 GPIO5 命中', !!hov.pinDoc('GPIO5'))
check('非引脚词不误判为引脚', hov.pinDoc('setup') === null)
const pd = hov.pinDoc('GPIO_NUM_2')
check('引脚说明含 strapping 提醒', pd.body.includes('strapping'))
check('引脚说明含 ADC2 提醒', pd.body.includes('ADC2'))
check('引脚宏带 title', pd.title === 'GPIO2')

// 3.x PWM 的悬停也要说清新旧 API
const ledc = hov.hoverFor('ledcAttach')
check('ledcAttach 有悬停', !!ledc)
check('ledcAttach 提示旧 API 已废弃', ledc.body.includes('ledcSetup'))
check('ledcAttach 标注适用架构', ledc.body.includes('ESP32'))

const espSleep = hov.hoverFor('esp_deep_sleep_start')
check('深睡悬停提到会重跑 setup', !!espSleep && espSleep.body.includes('setup'))

// 合并悬停
const merged = hov.mergeHover('LSP 给的说明', { title: 'T', signature: 'S', body: 'B' })
check('合并含 LSP 部分', merged.includes('LSP 给的说明'))
check('合并含自定义部分', merged.includes('B') && merged.includes('T'))
check('两边都空返回 null', hov.mergeHover(null, null) === null)
check('只有 LSP 时原样保留', hov.mergeHover('only-lsp', null) === 'only-lsp')
check('只有自定义时也能给', (hov.mergeHover(null, { title: 'T', signature: '', body: 'B' }) || '').includes('B'))

rmSync(tmp, { recursive: true, force: true })

console.log(`\n硬件智能增强自检：通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
} else {
  console.log('✓ 全部通过')
}
