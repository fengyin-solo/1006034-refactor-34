import { listRows, saveRows } from './local-store'
import { measureResourceGap } from './resplan-gap'
import { LEDGER_SOURCE_MIGRATE, recordDispatchedGap } from './resplan-ledger'
import type { EntryRow } from './types'

// 存量数据迁移，只在版本号落后时跑一次，跑完记版本，重复打开页面不会重跑。
const SCHEMA_VERSION = 1
const VERSION_KEY = 'airport-ground-ops:schema-version'

export function migrateIfNeeded(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const current = Number(window.localStorage.getItem(VERSION_KEY) ?? '0')
  if (current >= SCHEMA_VERSION) {
    return
  }
  backfillResplanGaps()
  window.localStorage.setItem(VERSION_KEY, String(SCHEMA_VERSION))
}

// 存量计划按保障时段回填：逐条用统一算法重算资源缺口写回计划行；
// 已下发的历史计划再把缺口结论补记进台账（按计划编号 upsert，
// 即使迁移被意外重跑也不会重复记账）。
//
// 历史计划统一按新算法回填，不沿用旧算法。依据：旧算法三个口径互相矛盾，
// 没有可保留的权威值；班组待办与计划页必须同口径，留两套算法永远对不上。
// 回填只重算缺口数值、补记台账，不动状态、不重走流转，已下发的还是已下发。
function backfillResplanGaps(): void {
  const rows = listRows('resplan')
  if (rows.length === 0) {
    return
  }
  const next = rows.map((row): EntryRow => ({
    ...row,
    资源缺口: measureResourceGap(row).合计缺口,
  }))
  saveRows('resplan', next)
  const dispatched = next
    .filter((row) => String(row.status) === '已下发')
    .sort((a, b) => String(a['保障时段']).localeCompare(String(b['保障时段'])))
  for (const plan of dispatched) {
    recordDispatchedGap(plan, LEDGER_SOURCE_MIGRATE)
  }
}
