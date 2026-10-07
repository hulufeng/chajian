'use strict'
/**
 * ESP32 崩溃速查表 —— 插件入口。
 * 纯离线知识库：不需要串口、不需要硬件、不联网，Agent 直接查。
 */

const { lookup, listAll, render } = require('./signatures.js')

function lookupCmd(args) {
  const text = args && typeof args.text === 'string' ? args.text : ''
  if (!text.trim()) return { ok: false, error: '请提供崩溃/报错文本（text 必填）' }
  const { hit, all } = lookup(text)
  if (!all.length) {
    return {
      ok: false,
      error: '没匹配到已知崩溃签名。可以先用 crash.list 看有哪些类型，或贴更完整的日志（含 Guru Meditation / rst: / Backtrace 等关键字）。'
    }
  }
  return {
    ok: true,
    // 命中多条时全给出来（很多崩溃同时匹配多个特征），但标出最可能的那个
    primary: hit ? hit.id : null,
    related: all.map((s) => s.id),
    answer: all.map((s) => render(s)).join('\n\n' + '─'.repeat(30) + '\n\n')
  }
}

function listCmd() {
  const items = listAll()
  return {
    ok: true,
    count: items.length,
    signatures: items,
    summary: `内置 ${items.length} 类 ESP32 崩溃签名：\n` + items.map((s, i) => `  ${i + 1}. ${s.title}`).join('\n')
  }
}

function load(ctx) {
  ctx.registerInternal('crash.lookup', (args) => lookupCmd(args || {}))
  ctx.registerInternal('crash.list', () => listCmd())
}

module.exports = { load, lookup: lookupCmd, list: listCmd }