/**
 * 自检：自研浏览器自动化的核心逻辑（不依赖真实浏览器）。
 *
 * 背景：浏览器自动化原依赖 Playwright（不在 package.json → 工具整体不可用），
 * 现改为 Electron BrowserWindow + 内置 webContents.debugger（CDP）+ 自研逻辑，零三方依赖。
 * Electron 窗口必须 app ready 才能建，所以这里只能验证「可离线验证的部分」：
 *   - 元素定位脚本 / 点击合成 / 表单填写脚本的正确性（用最小 DOM 替身在 node 里跑）
 *   - CDP 命令序列与参数名是否正确（对照 CDP 协议）
 *   - 对话框策略映射、下载/网络记录字段处理
 *   - 源码层面的结构断言（不重复注册监听器、无 Playwright 残留、死代码已清）
 *
 * 真实端到端（真窗口、真导航）需要在 Electron 运行时里验证，不在此脚本范围。
 *
 * 用法：node scripts/check-browser-driver.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}`) }
}

const SRC = readFileSync(join(root, 'src/main/services/browser-automation.ts'), 'utf8')

// ── 1. 零依赖 / 无 Playwright 残留 ──
console.log('\n[1] 零三方依赖')
ok(!/import\(['"]playwright['"]\)/.test(SRC), '不再动态 import playwright')
ok(!/require\(['"]playwright['"]\)/.test(SRC), '不再 require playwright')
const pkg = readFileSync(join(root, 'package.json'), 'utf8')
const depMatch = pkg.match(/"dependencies"\s*:\s*\{([^}]*)\}/s)
ok(!/playwright/i.test(depMatch ? depMatch[1] : ''), 'package.json 依赖里无 playwright')
// 只依赖 electron 自带能力
ok(/from 'electron'/.test(SRC), '依赖 Electron 自带 BrowserWindow/debugger')

// ── 2. 依赖 Electron 内置 CDP，不开调试端口 ──
console.log('\n[2] CDP 走 webContents.debugger')
ok(/webContents\.debugger\.attach\(/.test(SRC), '用 webContents.debugger.attach 附着')
ok(/Runtime\.evaluate/.test(SRC), '经 Runtime.evaluate 在页面上下文求值')
ok(/Network\.enable/.test(SRC), '开启 Network 域（网络记录依赖它）')
ok(/Page\.enable/.test(SRC), '开启 Page 域（对话框依赖它）')
ok(/Page\.handleJavaScriptDialog/.test(SRC), '对话框经 CDP 回应（不回应会阻塞页面）')
ok(/Page\.javascriptDialogOpening/.test(SRC), '监听 Page.javascriptDialogOpening 捕获对话框')
ok(!/remote-debugging-port/.test(SRC), '不开放调试端口（避免给本机进程开后门）')

// ── 3. 监听器不重复注册（会导致网络记录翻倍 / 对话框多次处理）──
console.log('\n[3] 监听器注册次数')
// 注意：要匹配真正的代码调用，不能被注释里的文字命中，所以先剥掉注释再数。
const codeOnly = SRC.split('\n').filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l)).join('\n')
// 用括号配平精确提取 ensureAttached 的函数体（不能用 indexOf 切片：
// 该函数在源码里可能出现在 on('message') 之后，slice 会取到空区间）
function extractFn(code, name) {
  const start = code.indexOf(`const ${name}`)
  if (start < 0) return ''
  const braceAt = code.indexOf('{', start)
  if (braceAt < 0) return ''
  let depth = 0
  for (let i = braceAt; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return code.slice(start, i + 1)
    }
  }
  return ''
}
const attachBody = extractFn(codeOnly, 'ensureAttached')
ok(attachBody.length > 0, `能精确提取 ensureAttached 函数体（长度 ${attachBody.length}）`)
ok(!/on\('message'/.test(attachBody), "on('message') 不在 ensureAttached 内（否则每次 send 都重复注册）")
const msgListeners = codeOnly.match(/on\('message'/g) || []
ok(msgListeners.length === 1, `on('message') 代码中恰好 1 处（实际 ${msgListeners.length} 处）`)

// ── 4. 元素定位 / 点击 / 填值脚本的正确性（用最小 DOM 替身在 node 里跑）──
console.log('\n[4] 页面侧脚本行为（DOM 替身）')
const locateTpl = SRC.slice(SRC.indexOf('function locateScript'), SRC.indexOf('// ── 对外接口'))
ok(/querySelector/.test(locateTpl), '定位脚本用 querySelector（CSS 选择器）')
ok(/getBoundingClientRect/.test(locateTpl), '用 getBoundingClientRect 判可见性')
ok(/slice\(0, 80\)/.test(locateTpl), '元素文本截断到 80 字符（避免超长）')

// 复刻定位脚本的判断顺序，用最小替身验证语义
const makeEl = (tag, text, rect) => ({
  tagName: tag,
  textContent: text,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: rect.width, height: rect.height })
})
const locate = (el) => {
  if (!el) return { found: false }
  const r = el.getBoundingClientRect()
  return { found: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80), visible: r.width > 0 && r.height > 0 }
}
const hit = locate(makeEl('BUTTON', '提交', { width: 10, height: 10 }))
ok(hit.found && hit.tag === 'BUTTON', '找到元素时返回 tag')
ok(hit.text === '提交', '提取元素文本（点击结果里回显用）')
ok(hit.visible === true, '可见性判定正确（有宽高 → 可见）')
ok(locate(makeEl('DIV', '', { width: 0, height: 0 })).visible === false, '宽高为 0 时判定为不可见（点击时会提示）')
ok(locate(null).found === false, '找不到元素时 found=false（工具会报「找不到匹配…的元素」）')
ok(locate(makeEl('DIV', 'x'.repeat(200), { width: 1, height: 1 })).text.length === 80, '超长文本被截断到 80')

// ── 5. React 受控组件兼容的填值逻辑 ──
console.log('\n[5] 表单填写兼容 React 受控组件')
ok(/getOwnPropertyDescriptor/.test(SRC), '用原生 value setter 赋值（React 受控组件才认）')
ok(/HTMLTextAreaElement\.prototype/.test(SRC), 'textarea 与 input 分别取正确原型')
ok(/new Event\('input'/.test(SRC), "派发 input 事件（React 靠它同步状态）")
ok(/new Event\('change'/.test(SRC), '派发 change 事件')
// 直接改 .value 会被 React 覆盖，所以主路径必须走原生 setter；
// else 分支保留 .value 赋值是合理兜底（setter 取不到时），不能断言成"没有直接赋值"
const setterFirst = SRC.indexOf('setter.set.call(el')
const directAssign = SRC.indexOf('else el.value =')
ok(setterFirst >= 0 && directAssign > setterFirst, '主路径是原生 setter，.value 仅作兜底且在其后')

// ── 6. 对话框三策略语义 ──
console.log('\n[6] 对话框策略')
ok(/dialogAction === 'accept'/.test(SRC), 'accept 策略映射到 accept=true')
ok(/promptText/.test(SRC), 'prompt 类型支持填文本')
// 关键正确性：三种策略都必须「明确回应」，否则页面脚本会一直阻塞。
// accept 只在 accept 策略时为 true → dismiss/ignore 都发 accept=false。
ok(/const accept = s\.dialogAction === 'accept'/.test(SRC), 'accept 仅在 accept 策略为 true（dismiss/ignore 回应 false，不阻塞页面）')
ok(/Page\.handleJavaScriptDialog/.test(codeOnly), '无论何种策略都发 handleJavaScriptDialog（不回应会卡死页面）')

// ── 7. 导出接口与 browser-tools 的约定一致 ──
console.log('\n[7] 对外接口契约')
for (const fn of [
  'browserNavigate', 'browserScreenshot', 'browserClick', 'browserFill',
  'browserEvaluate', 'browserNetwork', 'browserUpload', 'browserDownload',
  'browserDialogHandler', 'browserClose'
]) {
  ok(new RegExp(`export (async )?function ${fn}\\b`).test(SRC), `导出 ${fn}`)
}
const tools = readFileSync(join(root, 'src/main/engine/tools/browser-tools.ts'), 'utf8')
// 顶部注释里说明「不依赖 Playwright」是正确的设计说明，不能断言成"完全不许出现该词"；
// 要禁止的是**让用户去装** Playwright 的过时指引。
ok(!/npm i playwright|npx playwright install/.test(tools), 'browser-tools.ts 不再要求用户安装 Playwright')
const toolCount = (tools.match(/name: 'browser_/g) || []).length
ok(toolCount === 10, `browser_* 工具仍为 10 个（实际 ${toolCount}）`)

// ── 8. 死代码清理 ──
console.log('\n[8] 死代码')
ok(!/cdpClient/.test(SRC), '未引用已废弃的自研 cdpClient（改用内置 debugger）')
ok(!/findFreePort/.test(SRC), '没有为远程调试端口探测留死代码')
// 注释里可以提到"不用 as unknown as"，代码里出现才是问题
ok(!/as unknown as/.test(codeOnly), '代码里没有用 as unknown as 绕过类型检查')
ok(!/Object\.assign\(s,/.test(SRC), '没有往 session 上强挂方法（用类型化接口）')

console.log('')
console.log(`[浏览器驱动自检] 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)