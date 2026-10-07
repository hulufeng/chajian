/**
 * 自检：三个新插件的纯逻辑 + manifest 合法性（真实 require，不 mock）。
 *
 * 覆盖：
 *   1. serial-analyser：格式识别（JSON/CSV/TSV/键值对/纯文本）、数值提取（含单位）、
 *      统计计算（均值/中位数/标准差/异常点）
 *   2. serial-scope：ASCII 波形渲染、频率估算（有时间戳/无时间戳）、
 *      自包含性（不跨插件 require）
 *   3. esp32-crash-lookup：签名匹配（真实报错文本）
 *   4. 三者的 plugin.json 能通过 validateManifest
 *   5. 无跨插件依赖（插件必须自包含，各自独立 zip）
 *
 * 用法：node scripts/check-demo-plugins.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)
const PLUGINS = join(root, 'resources/plugin-demo')

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}

// ── 1. serial-analyser ──
console.log('\n[1] serial-analyser 格式识别与统计')
const analyser = require(join(PLUGINS, 'serial-analyser/analyser.js'))

ok(analyser.parseNumber('23.5C') === 23.5, '解析带单位数值 23.5C → 23.5')
ok(analyser.parseNumber('-12ms') === -12, '解析负数带单位 -12ms → -12')
ok(analyser.parseNumber('3.3V') === 3.3, '解析电压 3.3V → 3.3')
ok(analyser.parseNumber('1.5e3') === 1500, '解析科学计数法 1.5e3 → 1500')
ok(analyser.parseNumber('abc') === null, '非数值返回 null（不硬编成 0）')
ok(analyser.parseNumber('') === null, '空串返回 null')

const csv = 'temp,hum\n23.5,60\n24.0,61\n25.5,59\n'
const dCsv = analyser.detect(csv)
ok(dCsv.format === 'csv', `识别 CSV（实际 ${dCsv.format}）`)
ok(dCsv.columns.length === 2 && dCsv.columns[0] === 'temp', 'CSV 表头识别正确')
ok(dCsv.rows === 3, `CSV 行数 3（实际 ${dCsv.rows}）`)

const tsv = 'a\tb\n1\t2\n3\t4\n'
const dTsv = analyser.detect(tsv)
ok(dTsv.format === 'tsv', `识别 TSV（实际 ${dTsv.format}）`)

const jsonText = '{"tempC":23.5,"lux":120}\n{"tempC":24.0,"lux":135}\n'
const dJson = analyser.detect(jsonText)
ok(dJson.format === 'json', `识别 JSON 行（实际 ${dJson.format}）`)
ok(dJson.columns.includes('tempC'), 'JSON 数值列识别正确')

const kv = 'temp=23.5 hum=60\ntemp=24.0 hum=61\n'
const dKv = analyser.detect(kv)
ok(dKv.format === 'kv', `识别键值对（实际 ${dKv.format}）`)

const plain = '温度 23.5 度\n湿度 60%\n'
const dText = analyser.detect(plain)
ok(dText.format === 'text', `纯文本兜底（实际 ${dText.format}）`)
ok(dText.rows === 2, `纯文本提取到 2 个数字（实际 ${dText.rows}）`)

ok(analyser.detect('').format === 'empty', '空输入返回 empty（不报错）')
ok(analyser.detect('   \n\n').format === 'empty', '空白输入返回 empty')

// 统计
// 注：3σ 是相对总体自身的标准差判离群点，样本越少 σ 被离群点撑得越大。
// 这里用「5 个接近 + 1 个极端」构造，100 距均值远超 3σ 才算真离群。
const values = [10, 12, 11, 13, 12, 100]
const colVals = analyser.columnValues(analyser.detect('v\n' + values.map((v) => v).join('\n')), 'v')
ok(colVals.values.length === 6, `取出 6 个样本（实际 ${colVals.values.length}）`)
const st = analyser.stats(colVals.values, 3)
ok(st.count === 6, '统计样本数正确')
ok(Math.abs(st.mean - (10 + 12 + 11 + 13 + 12 + 100) / 6) < 1e-9, '均值计算正确')
ok(st.median === 12, `中位数正确（实际 ${st.median}）`)
ok(st.min === 10 && st.max === 100, '极值正确')
ok(st.outlierCount >= 1, `100 被标为离群点（实际 ${st.outlierCount} 个）`)
ok(analyser.stats([]).count === 0, '空序列统计不崩，返回 count=0')
ok(analyser.stats([5, 5, 5]).stddev === 0, '全等值时标准差为 0（不返回 NaN）')
// 离群点判定用 MAD 而非 3σ：3σ 的 σ 会被离群点自己撑大，导致明显坏点检不出来
// （实测 [10,12,11,13,12,100] 在 3σ 下 100 只偏离 2.24σ，被漏判）
const fewSample = analyser.stats([10, 12, 11, 13, 12, 50], 3)
ok(fewSample.outlierCount === 1 && fewSample.outliers[0].value === 50, `50 被 MAD 检出为离群（实际 ${fewSample.outlierCount} 个）`)
ok(fewSample.mad !== null && fewSample.mad > 0, `MAD 有值（${fewSample.mad}）`)
// 数据高度集中（多数相同）时退回 3σ，不能把任何差异都当离群
const concentrated = analyser.stats([5, 5, 5, 5, 9], 3)
ok(concentrated.outlierCount >= 0, '多数值相同时不崩（MAD=0 走 3σ 兜底）')
ok(analyser.stats([5, 5, 5, 5, 5]).mad === 0, '全等值时 MAD 为 0')
// 带单位的单元格也要能解析出数值
const unitCells = analyser.columnValues(analyser.detect('temp,hum\n23.5C,60%\n24.0C,61%'), 'temp')
ok(unitCells.values.length === 2 && unitCells.values[0] === 23.5, `带单位单元格解析正确（实际 ${JSON.stringify(unitCells.values)}）`)

// ── 2. serial-scope ──
console.log('\n[2] serial-scope 波形与频率')
const scope = require(join(PLUGINS, 'serial-scope/scope.js'))

const wave = scope.renderWave([1, 5, 3, 8, 2, 6], 20, 10)
ok(wave.includes('▁') || wave.includes('█'), '波形用块字符渲染')
ok(wave.includes('min='), '波形带量程刻度说明')
const flat = scope.renderWave([3, 3, 3, 3], 20, 10)
ok(flat.length > 0, '全等值时画中线（不除零得 NaN）')
ok(scope.renderWave([], 20, 10) === '(没有数据)', '空数据给出明确提示')
ok(scope.renderWave([1, 2], 1000, 10).length > 0, '超宽/超高参数被夹到合法范围（不崩）')

const withTs = { freqHz: 10 }
const est = scope.estimateFrequency([1, 2, 3, 4], [100, 100, 100, 100])
ok(est.freqHz !== null && Math.abs(est.freqHz - 10) < 1e-9, `100ms 间隔 → 10Hz（实际 ${est.freqHz}）`)
ok(est.gapCount === 0, '均匀间隔不报丢包')
const withGap = scope.estimateFrequency([1, 2, 3, 4], [100, 100, 5000, 100])
ok(withGap.gapCount >= 1, '5000ms 间隔被判为中断/丢包')

const noTs = scope.estimateFrequency([1, 2, 3], [])
ok(noTs.freqHz === null && !!noTs.note, '无时间戳时如实说算不出（不编频率）')
ok(scope.estimateFrequency([1], []).samples === 1, '单样本返回 samples=1（不崩）')
ok(scope.parseTimestamp('2026-10-07T10:00:00Z') !== null, '解析 ISO 时间戳')
ok(scope.parseTimestamp('1757239200') !== null, '解析 Unix 秒级时间戳')
ok(scope.parseTimestamp('1757239200123') !== null, '解析 Unix 毫秒时间戳')
ok(scope.parseTimestamp('ts=250') === 250, '解析相对毫秒数 ts=250（设备常用「开机以来 ms」）')
ok(scope.parseTimestamp('no time here') === null, '无时间戳返回 null')

const ivs = scope.extractIntervals(['ts=100', 'ts=200', 'ts=300'])
ok(ivs.length === 2 && ivs[0] === 100, '从日志行提取相邻间隔')

// ── 3. esp32-crash-lookup ──
console.log('\n[3] esp32-crash-lookup 签名匹配')
const crash = require(join(PLUGINS, 'esp32-crash-lookup/signatures.js'))
ok(crash.SIGNATURES.length >= 10, `签名数量 ≥10（实际 ${crash.SIGNATURES.length}）`)

const gm = crash.lookup("Guru Meditation Error: Core 0 panic'ed (abort) at ...")
ok(gm.hit && gm.hit.id === 'guru-meditation', `识别 Guru Meditation（实际 ${gm.hit?.id}）`)
const bo = crash.lookup('Brownout detector was triggered')
ok(bo.hit && bo.hit.id === 'brownout', '识别 Brownout')
const wdt = crash.lookup('Task watchdog got triggered')
ok(wdt.hit && wdt.hit.id === 'watchdog', '识别看门狗超时')
const rst = crash.lookup('rst:0x3 (VCC_SWITCH), boot:0x13')
ok(rst.all.length > 0, '识别 rst:0x 复位原因')
const none = crash.lookup('这段文字什么都没有')
ok(none.hit === null && none.all.length === 0, '无关文本不硬套签名')

const rendered = crash.render(crash.SIGNATURES[0])
ok(rendered.includes('原因') && rendered.includes('修复建议'), '签名渲染含原因与建议')
const gmr = crash.render(gm.hit)
ok(gmr.includes('addr2line'), 'Guru Meditation 条目带 addr2line 解码命令')

// ── 4. manifest 合法性 ──
console.log('\n[4] plugin.json 通过 validateManifest')
// 直接用 esbuild bundle 校验器（它是纯函数，依赖少）
const { buildSync } = await import('esbuild')
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const tmp = mkdtempSync(join(tmpdir(), 'plugchk-'))
const vOut = join(tmp, 'validate.mjs')
const vEntry = join(tmp, 've.mjs')
writeFileSync(
  vEntry,
  `export * from ${JSON.stringify(join(root, 'src/main/plugins/validate-manifest.ts').replace(/\\/g, '/'))}
export * as pm from ${JSON.stringify(join(root, 'src/main/plugins/pluginManager.ts').replace(/\\/g, '/'))}\n`,
  'utf8'
)
buildSync({
  entryPoints: [vEntry], bundle: true, format: 'esm', platform: 'node', outfile: vOut,
  alias: { electron: join(root, 'scripts/stubs/electron-dom-stub.mjs') }
})
const { validateManifest } = await import('file://' + vOut.replace(/\\/g, '/'))

for (const id of ['esp32-sensor-lab', 'serial-analyser', 'serial-scope', 'esp32-crash-lookup']) {
  const mf = join(PLUGINS, id, 'plugin.json')
  if (!existsSync(mf)) { ok(false, `${id} 有 plugin.json`); continue }
  const r = validateManifest(JSON.parse(readFileSync(mf, 'utf8')))
  const errs = (r.errors || []).map((e) => `${e.field}:${e.message}`).join('; ')
  ok(r.valid, `${id} manifest 合法${r.valid ? '' : ` — ${errs}`}`)
}

// ── 5. 插件自包含（不能跨插件 require）──
console.log('\n[5] 插件自包含性')
for (const id of ['serial-analyser', 'serial-scope', 'esp32-crash-lookup']) {
  const src = readFileSync(join(PLUGINS, id, 'index.js'), 'utf8')
  const crossRequire = src.match(/require\(['"]\.\.\//g) || []
  ok(crossRequire.length === 0, `${id} 不跨插件 require（各自独立 zip）${crossRequire.length ? ` — 找到 ${crossRequire.length} 处` : ''}`)
}
// manifest 里声明的 channel 必须真的在代码里 register
for (const id of ['serial-analyser', 'serial-scope', 'esp32-crash-lookup']) {
  const mf = JSON.parse(readFileSync(join(PLUGINS, id, 'plugin.json'), 'utf8'))
  const src = readFileSync(join(PLUGINS, id, 'index.js'), 'utf8')
  const declared = Object.entries(mf.channels || {}).flatMap(([, cmds]) => cmds)
  const missing = declared.filter((c) => !src.includes(`'${c}'`))
  ok(missing.length === 0, `${id} manifest 声明的 ${declared.length} 个命令都有注册${missing.length ? ` — 缺: ${missing.join(', ')}` : ''}`)
}

// ── 6. 清单 sha256 与实际 zip 一致（填错会导致安装直接失败）──
console.log('\n[6] 内置清单 sha256 与实际 zip 一致')
const { createHash } = await import('node:crypto')
const catalogSrc = readFileSync(join(root, 'src/main/plugins/plugin-catalog.ts'), 'utf8')
for (const id of ['esp32-sensor-lab', 'serial-analyser', 'serial-scope', 'esp32-crash-lookup']) {
  const zipPath = join(PLUGINS, `${id}.zip`)
  if (!existsSync(zipPath)) { ok(false, `${id}.zip 存在`); continue }
  const real = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  // 从清单里取出该 id 附近的 sha256
  const idx = catalogSrc.indexOf(`id: '${id}'`)
  ok(idx >= 0, `${id} 在清单中`)
  if (idx < 0) continue
  const after = catalogSrc.slice(idx, idx + 700)
  const m = /sha256:\s*'([0-9a-f]{64})'/.exec(after)
  ok(!!m, `${id} 清单里有 sha256`)
  if (m) ok(m[1] === real, `${id} sha256 与实际 zip 一致${m[1] === real ? '' : ` 清单=${m[1].slice(0, 12)}… 实际=${real.slice(0, 12)}…`}`)
}

// ── 7. 清单不含硬编码绝对路径 ──
console.log('\n[7] 清单可移植性')
// 只看代码行：注释里会保留「原写法是 file:///D:/...」的说明，不能算违规
const catalogCode = catalogSrc
  .split('\n')
  .filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l))
  .join('\n')
ok(!/file:\/\/\/[A-Za-z]:/.test(catalogCode), '清单代码里没有 file:///C: 形式的本机绝对路径')
ok(!/url:\s*['"][A-Za-z]:\\/.test(catalogCode), '没有 url: "C:\\..." 形式的绝对路径')
ok(/resolveBuiltinBundle/.test(catalogSrc), '用 resolveBuiltinBundle 运行时探测路径')

// ── 8. 本地市场目录支持 ──
console.log('\n[8] 本地市场目录')
const installerSrc = readFileSync(join(root, 'src/main/plugins/pluginInstaller.ts'), 'utf8')
ok(/loadLocalMarket/.test(installerSrc), '支持本地市场目录（userData/plugins/market/*.json）')
ok(/plugins.*market|'market'/.test(installerSrc), '本地市场路径为 plugins/market')
ok(/远程不可用|loadRemoteOrFallback/.test(installerSrc), '远端不可用时回退内置（不因远端挂了就整个市场打不开）')
ok(/解析失败，已跳过/.test(installerSrc), '坏掉的本地清单文件会明确报告而非静默')

console.log('')
console.log(`[示例插件自检] 通过 ${pass} / 失败 ${fail}`)
rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)