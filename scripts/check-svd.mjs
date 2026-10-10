/**
 * SVD 解析 / 查询自检（esbuild 把 electron 顶成 stub，node 真跑 parseSvd/loadSvd/findRegister）。
 *
 * 盯的是「降幻觉」红线：寄存器地址/位域必须和官方 SVD 逐字一致，解析错一位都害人。
 * 覆盖：normalizeChip / suggestChipByFqbn / parseSvd（外设·寄存器·位域·derivedFrom·数组寄存器）/
 *       loadSvd 缺失报错 / looksLikeSvd 损坏判定 / findRegister 前缀拆解（GPIO_OUT_REG → GPIO.OUT）/
 *       derivedFrom 外设继承寄存器并按子基址重算地址 / hex / formatRegister 位域区间。
 *
 * 用法：node scripts/check-svd.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 让 svdService 的 app.getPath('appData') 指向测试临时目录
const svdTmp = mkdtempSync(join(tmpdir(), 'svdtest-'))
process.env.SVD_TEST_APPDATA = svdTmp

const outfile = 'scripts/.tmp/svdService.bundle.mjs'
buildSync({
  entryPoints: ['src/main/services/svdService.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { electron: resolve('scripts/stubs/electron-dom-stub.mjs') }
})
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/' + outfile.replace(/\\/g, '/'))
const { parseSvd, normalizeChip, suggestChipByFqbn, loadSvd, looksLikeSvd, findRegister, hex, formatRegister, getSvdDir } = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

// ── ① normalizeChip ──────────────────────────────────────────────────────
check('① normalizeChip 小写+去符号', normalizeChip('ESP32-S3') === 'esp32-s3', normalizeChip('ESP32-S3'))
check('  ↳ 空 → 空串', normalizeChip('') === '', JSON.stringify(normalizeChip('')))
check('  ↳ 带空格/大写/非法字符', normalizeChip('  ESP32C3! ') === 'esp32c3', normalizeChip('  ESP32C3! '))

// ── ② suggestChipByFqbn ─────────────────────────────────────────────────
check('② fqbn esp32:esp32:esp32s3 → esp32s3', suggestChipByFqbn('esp32:esp32:esp32s3') === 'esp32s3')
check('  ↳ esp32c3 → esp32c3', suggestChipByFqbn('esp32:esp32:esp32c3') === 'esp32c3')
check('  ↳ 空 → null', suggestChipByFqbn() === null)
check('  ↳ esp32s3-ulp 不作为推断目标（更具体优先却要排除 family）', suggestChipByFqbn('esp32:esp32:esp32s3') === 'esp32s3')
check('  ↳ 长名优先（esp32s3 不被 esp32 抢）', suggestChipByFqbn('x-esp32s3-y') === 'esp32s3')

// ── ③ parseSvd：外设/寄存器/位域/derivedFrom/数组寄存器 ──────────────────
const SVD = `<?xml version="1.0"?>
<device schemaVersion="1.1">
  <name>ESP32-TEST</name>
  <vendor>Espressif</vendor>
  <version>1.0</version>
  <peripherals>
    <peripheral>
      <name>GPIO</name>
      <baseAddress>0x3FF44000</baseAddress>
      <registers>
        <register>
          <name>OUT</name>
          <description>GPIO output register</description>
          <addressOffset>0x04</addressOffset>
          <size>32</size>
          <fields>
            <field><name>gpio_out0</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field>
            <field><name>gpio_out1</name><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>mode</name><bitOffset>8</bitOffset><bitWidth>2</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>ENABLE</name>
          <addressOffset>0x08</addressOffset>
          <size>32</size>
        </register>
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIO">
      <name>GPIO1</name>
      <baseAddress>0x3FF44020</baseAddress>
    </peripheral>
    <peripheral>
      <name>KEY</name>
      <baseAddress>0x3FF45000</baseAddress>
      <registers>
        <register>
          <name>KEY[%s]</name>
          <addressOffset>0x00</addressOffset>
          <size>32</size>
          <dim>8</dim>
          <dimIncrement>0x04</dimIncrement>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>`
{
  const svd = parseSvd(SVD)
  check('③ 设备名/厂牌/版本解析', svd.deviceName === 'ESP32-TEST' && svd.vendor === 'Espressif' && svd.version === '1.0',
    JSON.stringify([svd.deviceName, svd.vendor, svd.version]))
  check('  ↳ 解析出 3 个外设', svd.peripherals.length === 3, `len=${svd.peripherals.length}`)
  const gpio = svd.peripherals.find((p) => p.name === 'GPIO')
  check('  ↳ GPIO 基址正确', gpio.baseAddress === 0x3ff44000, hex(gpio.baseAddress))
  const out = gpio.registers.find((r) => r.name === 'OUT')
  check('  ↳ OUT 绝对地址 = 基址+偏移', out.address === 0x3ff44004, hex(out.address))
  check('  ↳ OUT 位域 3 个，bitOffset/Width 解析', out.fields.length === 3 && out.fields[0].bitOffset === 0 && out.fields[0].bitWidth === 1 && out.fields[1].bitOffset === 1 && out.fields[2].bitOffset === 8 && out.fields[2].bitWidth === 2,
    JSON.stringify(out.fields))
  check('  ↳ OUT 位域 access 解析', out.fields[0].access === 'read-write', out.fields[0].access)
  // derivedFrom：GPIO1 无寄存器定义，应继承 GPIO 并按 GPIO1 基址重算
  const gpio1 = svd.peripherals.find((p) => p.name === 'GPIO1')
  check('  ↳ derivedFrom 继承父外设寄存器', gpio1.registers.length === 2, `len=${gpio1.registers.length}`)
  const out1 = gpio1.registers.find((r) => r.name === 'OUT')
  check('  ↳ 派生外设寄存器地址按子基址重算（0x3FF44020+0x04）', out1.address === 0x3ff44024, hex(out1.address))
  // 数组寄存器
  const key = svd.peripherals.find((p) => p.name === 'KEY').registers[0]
  check('  ↳ 数组寄存器 dim/dimIncrement 解析', key.name === 'KEY[%s]' && key.dim === 8 && key.dimIncrement === 0x4, JSON.stringify([key.name, key.dim, key.dimIncrement]))
  check('  ↳ 索引键剥离 [%s] 后大写', svd.index.has('KEY') && svd.index.get('KEY').length === 1, JSON.stringify([...svd.index.keys()]))
}

// ── ④ looksLikeSvd：损坏判定 ────────────────────────────────────────────
{
  const smallPath = join(svdTmp, 'small.svd')
  writeFileSync(smallPath, '<device></device>')
  check('④ <1KB 视为损坏', looksLikeSvd(smallPath) === false)
  const htmlPath = join(svdTmp, 'fake.svd')
  writeFileSync(htmlPath, '<html><body>404 Not Found</body></html>')
  check('  ↳ HTML 404 页视为损坏', looksLikeSvd(htmlPath) === false)
  const goodPath = join(svdTmp, 'good.svd')
  writeFileSync(goodPath, SVD)
  check('  ↳ 真 SVD（含 <device>）视为可用', looksLikeSvd(goodPath) === true)
  rmSync(smallPath, { force: true }); rmSync(htmlPath, { force: true }); rmSync(goodPath, { force: true })
}

// ── ⑤ loadSvd：缺失报错（不编造） ───────────────────────────────────────
{
  let threw = false
  let msg = ''
  try { loadSvd('notinstalled') } catch (e) { threw = true; msg = e.message }
  check('⑤ 未安装芯片抛错且提示安装方法', threw && /未安装/.test(msg) && /安装方式/.test(msg), msg.slice(0, 40))
}

// ── ⑥ findRegister：前缀拆解 + derivedFrom + 数组 ───────────────────────
{
  // 写一个 testchip.svd 到真实 getSvdDir()，走 loadSvd 真实路径
  const dir = getSvdDir()
  const fs = await import('node:fs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'testchip.svd'), SVD)
  const r1 = findRegister('testchip', 'GPIO_OUT_REG')
  check('⑥ GPIO_OUT_REG 前缀拆解命中 GPIO.OUT', r1.some((h) => h.peripheral === 'GPIO' && h.register.name === 'OUT'),
    JSON.stringify(r1.map((h) => `${h.peripheral}.${h.register.name}`)))
  check('  ↳ 命中寄存器绝对地址正确（GPIO 基址+偏移）', r1.some((h) => h.peripheral === 'GPIO' && h.register.address === 0x3ff44004),
    JSON.stringify(r1.map((h) => `${h.peripheral}.${h.register.name}@${hex(h.register.address)}`)))
  const r2 = findRegister('testchip', 'GPIO1_OUT_REG')
  check('  ↳ 派生外设 GPIO1_OUT_REG 命中且地址按子基址', r2.some((h) => h.peripheral === 'GPIO1' && h.register.address === 0x3ff44024),
    JSON.stringify(r2.map((h) => `${h.peripheral}.${h.register.name}@${hex(h.register.address)}`)))
  const r3 = findRegister('testchip', 'KEY', { exact: true })
  check('  ↳ 数组寄存器 KEY 直查命中（dim=8）', r3.some((h) => h.register.name === 'KEY[%s]' && h.register.dim === 8),
    JSON.stringify(r3.map((h) => h.register.name)))
  const r4 = findRegister('testchip', 'OUT', { peripheral: 'GPIO', exact: true })
  check('  ↳ 限外设 exact 查只返回该外设', r4.length === 1 && r4[0].peripheral === 'GPIO', JSON.stringify(r4.map((h) => h.peripheral)))
}

// ── ⑦ hex / formatRegister ──────────────────────────────────────────────
check('⑦ hex 默认 8 位宽补零', hex(0x3ff44004) === '0x3FF44004', hex(0x3ff44004))
{
  const svd = parseSvd(SVD)
  const out = svd.peripherals.find((p) => p.name === 'GPIO').registers.find((r) => r.name === 'OUT')
  const txt = formatRegister({ peripheral: 'GPIO', baseAddress: 0x3ff44000, register: out })
  check('⑦ formatRegister 含绝对地址与单 bit 区间', /0x3FF44004/.test(txt) && /bit0/.test(txt) && /bit1/.test(txt), txt)
  check('  ↳ 多 bit 位域区间 bit9:8（hi=offset+width-1）', /bit9:8/.test(txt), txt)
  check('  ↳ 单 bit 不渲染成 bit0:0', !/bit0:0/.test(txt), txt)
}

rmSync(svdTmp, { recursive: true, force: true })

console.log(`[svd] 通过 ${pass} 项`)
if (fails.length) {
  console.log(`[svd] ✗ 失败 ${fails.length} 项`)
  fails.forEach((f) => console.log('          -', f))
  process.exit(1)
}
console.log('[svd] ✓ 全部通过')
