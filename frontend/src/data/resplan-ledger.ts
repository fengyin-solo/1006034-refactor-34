import { listRows, saveRows } from './local-store'
import { measureResourceGap } from './resplan-gap'
import type { EntryRow } from './types'

// 缺口台账：已下发资源计划的缺口结论，按保障时段归集。
// 计划下发时在这里记一笔，保障班组的待办清单从这里读，
// 两边看到的是同一份记录，缺口数值不会两样。
export const GAP_LEDGER_KEY = 'resplan-gap-ledger'

export const LEDGER_SOURCE_DISPATCH = '下发记账'
export const LEDGER_SOURCE_MIGRATE = '迁移回填'

// 重复下发只算一次缺口：台账按计划编号 upsert，同一计划再记只会覆盖，
// 不会叠加出第二笔。状态流转那边的重复下发拦截是第一道，这里是第二道。
export function recordDispatchedGap(
  plan: EntryRow,
  source: string = LEDGER_SOURCE_DISPATCH,
): void {
  const gap = measureResourceGap(plan)
  const planCode = String(plan['计划编号'] ?? plan.id)
  const entry: EntryRow = {
    id: Number(plan.id),
    status: '已入账',
    pending: gap.合计缺口 > 0,
    abnormal: false,
    保障时段: String(plan['保障时段'] ?? ''),
    计划编号: planCode,
    机位缺口: gap.机位缺口,
    车辆缺口: gap.车辆缺口,
    人员缺口: gap.人员缺口,
    合计缺口: gap.合计缺口,
    记账来源: source,
  }
  const rest = listRows(GAP_LEDGER_KEY).filter((row) => String(row['计划编号']) !== planCode)
  saveRows(GAP_LEDGER_KEY, [...rest, entry])
}

// 台账全量，按保障时段、计划编号排序，保证任何页面读到的顺序一致。
export function listGapLedger(): EntryRow[] {
  return listRows(GAP_LEDGER_KEY)
    .slice()
    .sort((a, b) => {
      const byPeriod = String(a['保障时段']).localeCompare(String(b['保障时段']))
      if (byPeriod !== 0) return byPeriod
      return String(a['计划编号']).localeCompare(String(b['计划编号']))
    })
}

// 班组待办：只挑还欠着缺口的记录，合计为 0 的不构成待办。
export function listGapTodos(): EntryRow[] {
  return listGapLedger().filter((row) => Number(row['合计缺口']) > 0)
}
