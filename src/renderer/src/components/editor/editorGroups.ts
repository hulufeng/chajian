/**
 * 分屏编辑器组状态模型（纯函数，自研，符合红线）。
 * 全部操作不可变返回新 groups，便于 React 直接 setState 并复用 memo。
 * 被 #24（状态模型）/ #26（跨组移动拖拽）/ #27（check-split 自检）共用。
 *
 * 约束：
 * - tab 全局唯一：同一文件不能同时出现在两个组；openTab/moveTab 跨组时自动去重。
 * - groups 永远至少保留 1 个（空组在有其他组时被回收，唯一的组即使空也保留）。
 */
import type { EditorTab } from './types'

export interface EditorGroup {
  id: string
  tabs: EditorTab[]
  activeId: string | null
}

export type Groups = EditorGroup[]

export function createGroup(id: string, tabs: EditorTab[] = [], activeId: string | null = null): EditorGroup {
  return { id, tabs, activeId: activeId ?? (tabs[0]?.id ?? null) }
}

/** 扁平化全部 tab（供 resolveSketch / guardUnsaved 等与旧 tabs 数组兼容的消费方） */
export function flattenTabs(groups: Groups): EditorTab[] {
  return groups.flatMap((g) => g.tabs)
}

/** 找到 tab 所在组与下标；tab 全局唯一 */
export function findTabLocation(groups: Groups, tabId: string): { groupId: string; index: number } | null {
  for (const g of groups) {
    const i = g.tabs.findIndex((t) => t.id === tabId)
    if (i >= 0) return { groupId: g.id, index: i }
  }
  return null
}

/** 取某组的当前激活 tab */
export function getActiveTab(groups: Groups, groupId: string): EditorTab | null {
  const g = groups.find((x) => x.id === groupId)
  if (!g || !g.activeId) return null
  return g.tabs.find((t) => t.id === g.activeId) ?? null
}

/**
 * 在指定组打开/聚焦 tab：
 * - 全新 → 追加并激活；
 * - 已在目标组 → 用最新内容更新并激活（外部刷新/内容变化）；
 * - 在别的组 → 先去重移除，再在目标组追加并激活。
 * 返回新 groups 与被激活的 groupId（可能刚回收了空组）。
 */
export function openTab(groups: Groups, groupId: string, tab: EditorTab): { groups: Groups; activeGroupId: string } {
  if (!groups.some((g) => g.id === groupId)) return { groups, activeGroupId: groupId }
  const loc = findTabLocation(groups, tab.id)
  let next: Groups = groups.map((g) => ({ ...g, tabs: g.tabs.slice() }))
  // 只回收「被本次跨组去重搬空」的组；预先存在的空组（用户刚点 ⊞ 新建的）不得被误回收，
  // 否则用户一分屏、焦点切回旧组开个文件，新分的空组就凭空消失了。
  let emptiedId: string | null = null
  if (loc && loc.groupId !== groupId) {
    const srcId = loc.groupId
    next = next.map((g) =>
      g.id === srcId
        ? { ...g, tabs: g.tabs.filter((t) => t.id !== tab.id), activeId: g.activeId === tab.id ? (g.tabs.find((t) => t.id !== tab.id)?.id ?? null) : g.activeId }
        : g
    )
    if (next.find((g) => g.id === srcId)?.tabs.length === 0) emptiedId = srcId
  }
  next = next.map((g) => {
    if (g.id !== groupId) return g
    const exists = g.tabs.some((t) => t.id === tab.id)
    return {
      ...g,
      tabs: exists ? g.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...g.tabs, tab],
      activeId: tab.id,
    }
  })
  if (emptiedId && next.length > 1) next = next.filter((g) => g.id !== emptiedId)
  next = next.length > 0 ? next : groups.slice(0, 1)
  return { groups: next, activeGroupId: groupId }
}

/**
 * 关闭 tab：
 * - 若该组关闭后为空且存在其他组 → 整组回收（closedGroupId 返回被关组 id）；
 * - 激活态若被关 → 焦点回退到相邻 tab；
 * - 若当前激活组被回收 → activeGroupId 回退到第一个组。
 */
export function closeTab(groups: Groups, groupId: string, tabId: string): { groups: Groups; activeGroupId: string; closedGroupId: string | null } {
  const gi = groups.findIndex((g) => g.id === groupId)
  if (gi < 0) return { groups, activeGroupId: groupId, closedGroupId: null }
  const g = groups[gi]
  const idx = g.tabs.findIndex((t) => t.id === tabId)
  if (idx < 0) return { groups, activeGroupId: groupId, closedGroupId: null }

  const newTabs = g.tabs.filter((t) => t.id !== tabId)
  let newActive = g.activeId
  if (g.activeId === tabId) newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null

  let next = groups.map((gg, i) => (i === gi ? { ...gg, tabs: newTabs, activeId: newActive } : gg))

  let closedGroupId: string | null = null
  if (newTabs.length === 0 && next.length > 1) {
    closedGroupId = groupId
    next = next.filter((gg) => gg.id !== groupId)
  }
  const activeGroupId = next.some((gg) => gg.id === groupId) ? groupId : (next[0]?.id ?? groupId)
  return { groups: next, activeGroupId, closedGroupId }
}

/** 激活组内某 tab（仅改 activeId） */
export function activateTab(groups: Groups, groupId: string, tabId: string): Groups {
  return groups.map((g) => (g.id === groupId ? { ...g, activeId: tabId } : g))
}

/**
 * 跨组移动（#26 拖拽用）：把 tab 从所在组移到 toGroup 的 toIndex 处（缺省末尾）。
 * 同组移动按 toIndex 重排；跨组时保留内容并去重。
 */
export function moveTab(groups: Groups, tabId: string, toGroupId: string, toIndex?: number): Groups {
  const loc = findTabLocation(groups, tabId)
  if (!loc) return groups
  const fromGroup = groups.find((g) => g.id === loc.groupId)
  const moved = fromGroup?.tabs[loc.index]
  if (!moved) return groups

  let next: Groups = groups.map((g) => ({ ...g, tabs: g.tabs.slice() }))

  if (loc.groupId === toGroupId) {
    // 同组重排（移动后激活该 tab，拖拽语义一致）
    const arr = next.find((g) => g.id === toGroupId)!.tabs
    arr.splice(loc.index, 1)
    const insertAt = toIndex === undefined ? arr.length : Math.max(0, Math.min(toIndex, arr.length))
    arr.splice(insertAt, 0, moved)
    next = next.map((g) => (g.id === toGroupId ? { ...g, activeId: tabId } : g))
    return next
  }

  // 跨组：先移除（同样只回收「被搬空」的源组）
  let emptiedId: string | null = null
  next = next.map((g) =>
    g.id === loc.groupId
      ? { ...g, tabs: g.tabs.filter((t) => t.id !== tabId), activeId: g.activeId === tabId ? (g.tabs.find((t) => t.id !== tabId)?.id ?? null) : g.activeId }
      : g
  )
  if (next.find((g) => g.id === loc.groupId)?.tabs.length === 0) emptiedId = loc.groupId
  const ti = next.findIndex((g) => g.id === toGroupId)
  if (ti < 0) return groups
  const arr = next[ti].tabs
  const insertAt = toIndex === undefined ? arr.length : Math.max(0, Math.min(toIndex, arr.length))
  arr.splice(insertAt, 0, moved)
  next[ti] = { ...next[ti], tabs: arr, activeId: tabId }
  if (emptiedId && next.length > 1) next = next.filter((g) => g.id !== emptiedId)
  return next.length > 0 ? next : groups.slice(0, 1)
}

/** 新增一个空组（id 由调用方提供，保证纯函数可测） */
export function addGroup(groups: Groups, id: string): { groups: Groups; id: string } {
  if (groups.some((g) => g.id === id)) return { groups, id }
  return { groups: [...groups, createGroup(id)], id }
}
