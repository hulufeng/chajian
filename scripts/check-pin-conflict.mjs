/**
 * 引脚冲突检测自检（临时工程夹具 + 真函数，不依赖 Electron）。
 *
 * 为什么用真工程夹具：checkPinConflicts 会**真实扫描目录**（.ino/.cpp/.h），
 * 单靠喂字符串测不到"注释里那行代码会不会被误当成真代码"这件事。
 *
 * 盯的是项目原则「不猜、不编造引脚号」：
 *   - 解析不出就如实进 unresolved（info 提示），绝不硬猜一个 GPIO；
 *   - 反过来也不能漏 —— 真冲突必须报出来（越界 / strapping / ADC 与 PWM 撞脚）。
 *
 * 用法：node scripts/check-pin-conflict.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'pin-'))
const out = join(tmp, 'bundle')
mkdirSync(out)
const outfile = join(out, 'pinConflict.mjs')
buildSync({
  entryPoints: ['src/main/services/pinConflict.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile
})
const { detectChipModel, checkPinConflicts } = await import('file://' + outfile.replace(/\\/g, '/'))

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

/** 写一个临时工程目录（files: { 相对路径: 内容 }），返回目录路径 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

// ── ① 芯片模型推断 ───────────────────────────────────────────────────────
check('① fqbn esp32s3 → esp32s3', detectChipModel('esp32:esp32:esp32s3') === 'esp32s3')
check('  ↳ fqbn esp32c3 → esp32c3', detectChipModel('esp32:esp32:esp32c3') === 'esp32c3')
check('  ↳ 普通 esp32 → esp32', detectChipModel('esp32:esp32:esp32') === 'esp32')
check('  ↳ 空的/未给 → esp32', detectChipModel() === 'esp32')
check('  ↳ PlatformIO board id 也认得', detectChipModel('esp32-s3-devkitc-1') === 'esp32s3')

// ── ② 真冲突必须报出来 ──────────────────────────────────────────────────
{
  const dir = fixture({ 'Blink/Blink.ino': ['#define LED_PIN 8', 'void setup() {', '  pinMode(LED_PIN, OUTPUT);', '  pinMode(30, OUTPUT);', '  analogRead(4);', '  ledcAttach(4);', '}'].join('\n') })
  const r = checkPinConflicts(dir, { fqbn: 'esp32:esp32:esp32c3' })
  check('② 宏常量 LED_PIN=8 被解析成 GPIO 8', r.uses.some((u) => u.pin === 8 && u.api === 'pinMode'), JSON.stringify(r.uses.map((u) => `${u.api}@${u.pin}`)))
  check('  ↳ 越界 GPIO 30 报 error', r.issues.some((i) => i.level === 'error' && i.pin === 30 && /不存在/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  check('  ↳ ADC 与 PWM 撞同一脚报 error', r.issues.some((i) => i.level === 'error' && i.pin === 4 && /ADC 与 PWM/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  check('  ↳ 扫描到的文件数 > 0', r.scannedFiles >= 1, `scannedFiles=${r.scannedFiles}`)
  rmSync(dir, { recursive: true, force: true })
}
{
  // ESP32-S3 strapping 脚 0 / 3 / 45 / 46，输出驱动它会让下载模式异常
  const dir = fixture({ 'x.ino': 'void setup() { pinMode(0, OUTPUT); }' })
  const r = checkPinConflicts(dir, { fqbn: 'esp32:esp32:esp32s3' })
  check('② strapping 脚输出 → warning', r.issues.some((i) => i.level === 'warning' && i.pin === 0 && /strapping/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // 同一脚既读又写（要 mode + in + out 三者齐，光 pinMode+digitalRead 不算冲突）
  const dir = fixture({ 'x.ino': 'void setup() { pinMode(2, OUTPUT); digitalRead(2); digitalWrite(2, HIGH); }' })
  const r = checkPinConflicts(dir)
  check('② 既读又写 → error', r.issues.some((i) => i.level === 'error' && i.pin === 2 && /既读又写/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // ESP-IDF 枚举写法
  const dir = fixture({ 'x.ino': 'void setup() { analogRead(GPIO_NUM_4); }' })
  const r = checkPinConflicts(dir)
  check('② GPIO_NUM_4 枚举能解析', r.uses.some((u) => u.pin === 4 && u.kind === 'adc'), JSON.stringify(r.uses))
  rmSync(dir, { recursive: true, force: true })
}

// ── ③ 解析不出就如实提示，不猜编号 ─────────────────────────────────────
{
  const dir = fixture({ 'x.ino': 'void setup() { pinMode(LED_BUILTIN, OUTPUT); }' })
  const r = checkPinConflicts(dir)
  check('③ 未解析的引脚名进 unresolved 且是 info', r.unresolved.some((u) => u.token === 'LED_BUILTIN') && r.issues.some((i) => i.level === 'info' && /LED_BUILTIN/.test(i.title)),
    JSON.stringify(r.issues.map((i) => i.title)))
  check('  ↳ 未解析的脚不进 uses（宁可不报也不编造）', !r.uses.some((u) => u.pin === -1), JSON.stringify(r.uses))
  rmSync(dir, { recursive: true, force: true })
}

// ── ④ 注释里的代码不能被当成真代码（误报比漏报更烦人） ─────────────────
{
  // GPIO2 是 ESP32 的 strapping 脚。整行被注释掉的调用不该再参与判定。
  const dir = fixture({ 'x.ino': 'void setup() { // digitalWrite(2, HIGH); 点亮 LED\n}' })
  const r = checkPinConflicts(dir)
  check('④ 整行注释掉的调用不算真代码', !r.issues.some((i) => i.pin === 2 && /strapping/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // 反向断言（这条更容易写错）：剥注释不能把真代码一起吃掉。
  // `digitalWrite(2, HIGH); // 点亮 LED` 里调用是真的 → strapping 警告必须照报。
  const dir = fixture({ 'x.ino': 'void setup() { digitalWrite(2, HIGH); // 点亮 LED\n}' })
  const r = checkPinConflicts(dir)
  check('④ 真代码 + 行尾注释 → 真代码照报（剥注释不能误伤）', r.issues.some((i) => i.pin === 2 && /strapping/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // 行内块注释夹在真代码中间，真代码那半截要保住（ESP32 上 GPIO9 是保留脚）
  const dir = fixture({ 'x.ino': 'void setup() { pinMode(9, OUTPUT); /* 板载 LED 脚 */ }' })
  const r = checkPinConflicts(dir)
  check('④ 行内块注释后的真代码照扫', r.issues.some((i) => i.pin === 9 && /保留脚/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = fixture({ 'x.ino': '/* pinMode(9, OUTPUT); */\nvoid setup() { }' })
  const r = checkPinConflicts(dir)
  check('④ 单行块注释里的调用不算真代码', !r.issues.some((i) => i.pin === 9), JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // 跨行块注释：首行只写 /*，真正的调用在下一行
  const dir = fixture({ 'x.ino': '/*\n  digitalWrite(9, HIGH);\n*/\nvoid setup() { }' })
  const r = checkPinConflicts(dir)
  check('④ 跨行块注释里的调用不算真代码', !r.issues.some((i) => i.pin === 9), JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // 反例：字符串里的 // 不是注释，同一行后面的真调用必须还能扫到
  const dir = fixture({ 'x.ino': 'void setup() { Serial.println("a//b"); pinMode(7, OUTPUT); }' })
  const r = checkPinConflicts(dir)
  check('④ 字符串里的 // 不当注释，行尾真代码照扫', r.uses.some((u) => u.pin === 7 && u.api === 'pinMode'), JSON.stringify(r.uses.map((u) => `${u.api}@${u.pin}`)))
  rmSync(dir, { recursive: true, force: true })
}

// ── ⑤ 跳过目录与空工程 ─────────────────────────────────────────────────
{
  const dir = fixture({
    'x.ino': 'void setup() { }',
    'build/Stale.ino': 'void setup() { pinMode(30, OUTPUT); }',
    'node_modules/foo/foo.ino': 'void setup() { pinMode(31, OUTPUT); }'
  })
  const r = checkPinConflicts(dir)
  check('⑤ build/ 与 node_modules/ 不参与扫描', !r.issues.some((i) => [30, 31].includes(i.pin)), JSON.stringify(r.issues.map((i) => i.pin)))
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = fixture({ 'README.md': '# 只是文档' })
  const r = checkPinConflicts(dir)
  check('⑤ 没有源码时如实说明（不粉饰）', r.scannedFiles === 0 && /未|无法/.test(r.summary), r.summary)
  rmSync(dir, { recursive: true, force: true })
}

// ── ⑥ overlay 覆盖层（保存即预检专用：编辑器实时内容未必落盘） ──────────────
{
  // 磁盘文件干净，但 overlay（编辑器里的最新内容）改出了越界脚 → 预检必须看到 overlay
  const dir = fixture({ 'x.ino': 'void setup() { pinMode(5, OUTPUT); }' })
  const abs = join(dir, 'x.ino')
  const overlay = { [abs]: 'void setup() { pinMode(30, OUTPUT); }' } // GPIO 30 在 C3 上越界
  const r = checkPinConflicts(dir, { fqbn: 'esp32:esp32:esp32c3', overlay })
  check('⑥ overlay 覆盖磁盘：越界 GPIO 30 报 error', r.issues.some((i) => i.level === 'error' && i.pin === 30 && /不存在/.test(i.title)),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // 反向：磁盘冲突、overlay 改干净 → 冲突应消失（overlay 真覆盖了磁盘，不是两种一起算）
  const dir = fixture({ 'x.ino': 'void setup() { pinMode(30, OUTPUT); }' })
  const abs = join(dir, 'x.ino')
  const overlay = { [abs]: 'void setup() { pinMode(5, OUTPUT); }' }
  const r = checkPinConflicts(dir, { fqbn: 'esp32:esp32:esp32c3', overlay })
  check('⑥ overlay 覆盖磁盘：原冲突消失', !r.issues.some((i) => i.pin === 30),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}
{
  // 未落盘的新文件（标签页里新建还没保存）也能被 overlay 纳入
  const dir = fixture({ 'clean.ino': 'void setup() { }' })
  const newAbs = join(dir, 'unsaved.ino')
  const overlay = { [newAbs]: 'void setup() { pinMode(31, OUTPUT); }' } // GPIO 31 越界
  const r = checkPinConflicts(dir, { fqbn: 'esp32:esp32:esp32c3', overlay })
  check('⑥ overlay 纳入未落盘新文件：越界 GPIO 31 报 error', r.issues.some((i) => i.level === 'error' && i.pin === 31),
    JSON.stringify(r.issues.map((i) => `${i.level}:${i.pin}:${i.title}`)))
  rmSync(dir, { recursive: true, force: true })
}

rmSync(tmp, { recursive: true, force: true })

console.log(`[pin] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[pin] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[pin] ✓ 全部通过')
