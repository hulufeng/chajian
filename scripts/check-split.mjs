/**
 * 分屏编辑器组状态模型自检（纯函数，不依赖 Electron）。
 * 覆盖：openTab 新增/聚焦/跨组去重、closeTab 焦点回退/整组回收、activateTab、
 *       moveTab 同组重排/跨组移动、addGroup、flattenTabs、prune 不灭最后一组。
 * 用法：node scripts/check-split.mjs
 */
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const entry = join(root, 'src/renderer/src/components/editor/editorGroups.ts')

const tmp = mkdtempSync(join(tmpdir(), 'split-'))
const outfile = join(tmp, 'editorGroups.mjs')
buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile })
const mod = await import('file://' + outfile.replace(/\\/g, '/'))
const {
  createGroup, openTab, closeTab, activateTab, moveTab, addGroup, flattenTabs, findTabLocation, getActiveTab,
} = mod

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) pass++
  else fails.push(`${name}${detail ? '：' + detail : ''}`)
}

const tab = (id, name = id) => ({ id, name, language: 'cpp', content: '' })

// 初始：单组
let g = [createGroup('g1')]
check('初始单组 1 个', g.length === 1)
check('初始组无 tab', g[0].tabs.length === 0)

// openTab 新增
let r = openTab(g, 'g1', tab('a', 'a.ino'))
g = r.groups
check('openTab 新增 → g1 有 1 tab', g[0].tabs.length === 1 && g[0].tabs[0].id === 'a')
check('openTab 新增 → 激活 a', g[0].activeId === 'a')
check('openTab 返回 activeGroupId=g1', r.activeGroupId === 'g1')

// openTab 再来一个
r = openTab(g, 'g1', tab('b', 'b.ino'))
g = r.groups
check('openTab 第二个 → g1 有 2 tab', g[0].tabs.length === 2)

// openTab 已有 → 只聚焦不重复
r = openTab(g, 'g1', tab('a', 'a.ino'))
g = r.groups
check('openTab 已存在 → 不重复', g[0].tabs.length === 2)
check('openTab 已存在 → 激活切回 a', g[0].activeId === 'a')

// 新增组 + 跨组去重
let a = addGroup(g, 'g2')
g = a.groups
check('addGroup → 2 组', g.length === 2)
r = openTab(g, 'g2', tab('a', 'a.ino')) // a 已在 g1，应跨组移到 g2
g = r.groups
check('跨组 openTab → 全局唯一（共 2 tab）', flattenTabs(g).length === 2)
check('跨组 openTab → a 现在在 g2', findTabLocation(g, 'a')?.groupId === 'g2')
check('跨组 openTab → g1 剩 b', g.find((x) => x.id === 'g1')?.tabs.length === 1)

// closeTab 焦点回退
r = closeTab(g, 'g2', 'a')
g = r.groups
check('closeTab → g2 空且被回收', g.length === 1 && g[0].id === 'g1')
check('closeTab 返回 closedGroupId=g2', r.closedGroupId === 'g2')

// closeTab 焦点回退到相邻（仅当被关的是激活项）
let g2 = [createGroup('g1', [tab('a'), tab('b'), tab('c')], 'b')]
r = closeTab(g2, 'g1', 'b') // 关激活项 b（idx 1）→ 回退到新数组 [a,c] 的 min(1,1)=c
g2 = r.groups
check('closeTab 激活项 → 焦点回退到相邻 c', g2[0].activeId === 'c')
check('closeTab 激活项 → 剩 2 tab', g2[0].tabs.length === 2)

// closeTab 非激活项 → 激活态不变
let g3 = [createGroup('g1', [tab('a'), tab('b'), tab('c')], 'a')]
r = closeTab(g3, 'g1', 'b') // 关非激活的 b，激活 a 保持不变
g3 = r.groups
check('closeTab 非激活项 → 激活 a 不变', g3[0].activeId === 'a')
check('closeTab 非激活项 → 剩 2 tab', g3[0].tabs.length === 2)

// activateTab
g2 = activateTab(g2, 'g1', 'a')
check('activateTab → 切回 a', g2[0].activeId === 'a')

// moveTab 同组重排：把 c 移到首位
g2 = [createGroup('g1', [tab('a'), tab('b'), tab('c')], 'a')]
g2 = moveTab(g2, 'c', 'g1', 0)
check('moveTab 同组 → c 到首位', g2[0].tabs[0].id === 'c')
check('moveTab 同组 → 顺序 a? 实际 [c,a,b]', g2[0].tabs.map((t) => t.id).join(',') === 'c,a,b')
check('moveTab 同组 → 激活 c', g2[0].activeId === 'c')

// moveTab 跨组
let mg = [createGroup('g1', [tab('a'), tab('b')], 'a'), createGroup('g2', [tab('x')], 'x')]
mg = moveTab(mg, 'b', 'g2')
check('moveTab 跨组 → 全局唯一', flattenTabs(mg).length === 3)
check('moveTab 跨组 → b 进 g2', mg.find((x) => x.id === 'g2')?.tabs.some((t) => t.id === 'b'))
check('moveTab 跨组 → g1 剩 a', mg.find((x) => x.id === 'g1')?.tabs.length === 1)

// 最后一组永不灭
let last = [createGroup('g1', [tab('a')], 'a')]
let lr = closeTab(last, 'g1', 'a')
check('最后一组关空 → 仍保留 1 组', lr.groups.length === 1)
check('最后一组关空 → 该组 tabs 为空', lr.groups[0].tabs.length === 0)
check('最后一组关空 → closedGroupId 为 null（没真回收）', lr.closedGroupId === null)

// getActiveTab
check('getActiveTab 取激活 tab', getActiveTab([createGroup('g1', [tab('a'), tab('b')], 'b')], 'g1')?.id === 'b')

// 空组不被误回收（用户刚点 ⊞ 新建的空组，在别的组开文件也不能让它凭空消失）
let keepG = addGroup([createGroup('g1', [tab('a')], 'a')], 'g2') // g2：用户刚分出来的空组
check('新建空组 → 2 组且 g2 为空', keepG.groups.length === 2 && keepG.groups[1].tabs.length === 0)
const after = openTab(keepG.groups, 'g1', tab('b')).groups // 焦点回到 g1 再开文件
check('在其他组开文件 → 空组 g2 仍保留', after.length === 2 && after.some((x) => x.id === 'g2'))

// 跨组去重把源组搬空 → 源组回收
let drainG = [createGroup('g1', [tab('a')], 'a'), createGroup('g2', [tab('x')], 'x')]
drainG = openTab(drainG, 'g2', tab('a')).groups // 把 g1 唯一的 a 搬到 g2
check('搬运搬空源组 → 源组被回收', drainG.length === 1 && drainG[0].id === 'g2')
check('搬运搬空源组 → 全局 tab 仍唯一', flattenTabs(drainG).length === 2)

// moveTab 搬空源组 → 源组回收；但不会牵连本就空着的第三方组
let m2 = [createGroup('g1', [tab('a')], 'a'), createGroup('g2', [tab('x')], 'x'), createGroup('g3', [], null)]
m2 = moveTab(m2, 'a', 'g2')
check('moveTab 搬空源组 → g1 回收', !m2.some((x) => x.id === 'g1'))
check('moveTab 保留本就空着的 g3', m2.some((x) => x.id === 'g3' && x.tabs.length === 0))

rmSync(tmp, { recursive: true, force: true })

console.log(`\n分屏状态模型自检：通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
} else {
  console.log('✓ 全部通过')
}
