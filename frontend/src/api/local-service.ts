import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  freezeResourceGap,
  isGapFrozen,
  listGapTodos,
  presentResourceGap,
  type GapTodoItem,
} from '@/domain/resource-gap'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 顺序不许跨越：登记了来源名单的动作，只能从名单内的上一状态受理。
  const allowedSources = meta.actionSources?.[action]
  if (allowedSources && !allowedSources.includes(current)) {
    return {
      ok: false,
      message: `资源计划当前为「${current}」，只有处于${allowedSources
        .map((status) => `「${status}」`)
        .join('或')}的计划才能执行「${action}」，越级动作不予受理`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 下发计划：缺口只在这里测算并冻结一次；重复下发已被上面的重复/越级检查拦住。
  if (key === 'resplan' && action === '下发计划') {
    updated = freezeResourceGap(updated)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === 'resplan') {
    migrateIssuedPlanGaps()
  }
  return listEntries(key)
}

/**
 * 历史计划迁移：已经下发、但还没有冻结缺口的存量计划，按保障时段统一用新算法
 * 回填并冻结（缺口旧值是代码生成器写的占位文本，不存在可信旧算法可沿用）。
 * 只补未冻结的行：重复执行、已由「下发计划」冻结的行都不会重算，保证只算一次。
 */
export function migrateIssuedPlanGaps(): void {
  const rows = listRows('resplan')
  let changed = false
  const next = rows.map((row) => {
    if (String(row.status) === '已下发' && !isGapFrozen(row)) {
      changed = true
      return freezeResourceGap(row)
    }
    return row
  })
  if (changed) {
    saveRows('resplan', next)
  }
}

/** 保障班组待办清单：缺口结论与资源计划下发时冻结的是同一份。 */
export function gapTodos(): GapTodoItem[] {
  return listGapTodos()
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    // 资源缺口列不导出原始存储值，统一走收口口径，导出与页面、班组待办保持一致。
    const values = meta.fields.map((field) =>
      key === 'resplan' && field === '资源缺口' ? presentResourceGap(row) : (row[field] ?? ''),
    )
    lines.push([row.id, ...values, row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// 模块加载时先把历史已下发计划按保障时段回填一次缺口；迁移本身幂等，后续加载不再改动。
migrateIssuedPlanGaps()
