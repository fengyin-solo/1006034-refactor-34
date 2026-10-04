import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

/**
 * 资源缺口测算 —— 全应用唯一收口，三个调用点共用，禁止再各写一份：
 *   1. 资源计划列表/导出展示（presentResourceGap）
 *   2. 「下发计划」动作落库冻结（freezeResourceGap）
 *   3. 保障班组待办清单（listGapTodos）
 *
 * 两条口径（依据见 README「缺口测算口径」）：
 *   一、三类需求的扣减顺序固定为「机位 → 车辆 → 人员」：机位是最硬的稀缺资源，
 *       先锁机位再派车、车辆到位后才核定人员；顺序固定，测算结果才可复现。
 *   二、单类缺口为负时截零记 0，富余（surplus）只备查，不跨类抵扣总缺口，
 *       避免人员富余把机位/车辆的真实缺口抹平。
 */

// 扣减顺序只能改这里，调用点一律按此顺序归约。
export const GAP_KINDS = ['机位', '车辆', '人员'] as const
export type GapKind = (typeof GAP_KINDS)[number]

export type GapPart = {
  demand: number
  supply: number
  gap: number
  surplus: number
}

export type ResourceGapResult = {
  parts: Record<GapKind, GapPart>
  total: number
  hasGap: boolean
}

export type GapTodoItem = {
  planId: string
  period: string
  teamName: string
  gaps: Record<GapKind, number>
  total: number
}

export const PLAN_PERIOD_FIELD = '保障时段'
export const GAP_TOTAL_FIELD = '资源缺口'

const PLAN_ID_FIELD = '计划编号'
const DEMAND_FIELDS: Record<GapKind, string> = {
  机位: '机位需求',
  车辆: '车辆需求',
  人员: '人员需求',
}
const GAP_FROZEN_FIELD = '缺口已冻结'
const GAP_SNAPSHOT_FIELD = '缺口测算明细'

const STAND_STATUS_AVAILABLE = '空闲'
const VEHICLE_STATUS_AVAILABLE = '待命'
const TEAM_STATUS_ON_DUTY = '在岗'
const TEAM_PERIOD_FIELD = '班次时段'
const TEAM_HEADCOUNT_FIELD = '在岗人数'
const TEAM_NAME_FIELD = '班组名称'
const NO_TEAM_LABEL = '未匹配班组'

/** 只认非负整数；占位文本、空值、负数一律按 0 处理，保证减法不被脏值带偏。 */
export function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return 0
}

/** 可用机位：当前空闲的停机位，按「条」计。 */
function availableStands(): number {
  return listRows('stand').filter((row) => String(row.status) === STAND_STATUS_AVAILABLE).length
}

/** 可用车辆：当前待命的摆渡车，按「辆」计。 */
function availableVehicles(): number {
  return listRows('shuttle').filter((row) => String(row.status) === VEHICLE_STATUS_AVAILABLE).length
}

/** 可用人员：同一保障时段（班次时段）内在岗班组的人数合计；时段不匹配的人力不能计入。 */
function availableStaff(period: string): number {
  return listRows('team')
    .filter(
      (row) =>
        String(row.status) === TEAM_STATUS_ON_DUTY &&
        String(row[TEAM_PERIOD_FIELD] ?? '') === period,
    )
    .reduce((sum, row) => sum + toCount(row[TEAM_HEADCOUNT_FIELD]), 0)
}

/**
 * 缺口测算的唯一实现。按「机位 → 车辆 → 人员」的固定顺序归约；
 * 单类缺口 = max(需求 - 可用供给, 0)，总缺口为三类非负缺口之和。
 */
export function evaluateResourceGap(plan: EntryRow): ResourceGapResult {
  const period = String(plan[PLAN_PERIOD_FIELD] ?? '')
  const demand: Record<GapKind, number> = {
    机位: toCount(plan[DEMAND_FIELDS.机位]),
    车辆: toCount(plan[DEMAND_FIELDS.车辆]),
    人员: toCount(plan[DEMAND_FIELDS.人员]),
  }
  // 供给随保障时段核定：人员严格匹配时段；机位、车辆为全局共享资源，取当前可用量。
  const supply: Record<GapKind, number> = {
    机位: availableStands(),
    车辆: availableVehicles(),
    人员: availableStaff(period),
  }

  const parts = GAP_KINDS.reduce((acc, kind) => {
    const diff = demand[kind] - supply[kind]
    acc[kind] = {
      demand: demand[kind],
      supply: supply[kind],
      gap: Math.max(0, diff),
      surplus: Math.max(0, -diff),
    }
    return acc
  }, {} as Record<GapKind, GapPart>)

  const total = GAP_KINDS.reduce((sum, kind) => sum + parts[kind].gap, 0)
  return { parts, total, hasGap: total > 0 }
}

export function isGapFrozen(plan: EntryRow): boolean {
  return plan[GAP_FROZEN_FIELD] === true
}

/**
 * 下发时调用一次：把测算结论冻结到计划上。重复下发在状态流转处已被拒绝，
 * 因此缺口在整个生命周期里只落这一次，后续供给变化不回算。
 */
export function freezeResourceGap(plan: EntryRow): EntryRow {
  const result = evaluateResourceGap(plan)
  return {
    ...plan,
    [GAP_TOTAL_FIELD]: result.total,
    [GAP_SNAPSHOT_FIELD]: JSON.stringify(result),
    [GAP_FROZEN_FIELD]: true,
  }
}

/** 取一条计划的缺口结论：已下发读冻结快照，未下发实时测算（仅作编制期预览）。 */
export function gapOfPlan(plan: EntryRow): ResourceGapResult {
  if (!isGapFrozen(plan)) {
    return evaluateResourceGap(plan)
  }
  const raw = plan[GAP_SNAPSHOT_FIELD]
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as ResourceGapResult
    } catch {
      // 快照损坏时退回同一套算法重算，保证读到的值仍出自本口径。
    }
  }
  return evaluateResourceGap(plan)
}

/** 列表/导出展示用的缺口文本，三个调用点看到的都是这一个值。 */
export function presentResourceGap(plan: EntryRow): string {
  return String(gapOfPlan(plan).total)
}

/** 按保障时段定位承接缺口的在岗班组；一个时段多个在岗班组时并列展示，匹配不到要明示。 */
function resolveTeamName(period: string): string {
  const names = listRows('team')
    .filter(
      (row) =>
        String(row.status) === TEAM_STATUS_ON_DUTY &&
        String(row[TEAM_PERIOD_FIELD] ?? '') === period,
    )
    .map((row) => String(row[TEAM_NAME_FIELD] ?? '').trim())
    .filter(Boolean)
  return names.length > 0 ? names.join('、') : NO_TEAM_LABEL
}

/**
 * 保障班组待办：只取已下发且存在缺口的计划，缺口直接读下发时冻结的同一份结论，
 * 不允许在班组侧重算，确保班组读到的缺口与资源计划上的完全一致。
 */
export function listGapTodos(): GapTodoItem[] {
  return listRows('resplan')
    .filter((row) => String(row.status) === '已下发')
    .map((row) => ({ row, gap: gapOfPlan(row) }))
    .filter(({ gap }) => gap.hasGap)
    .map(({ row, gap }) => ({
      planId: String(row[PLAN_ID_FIELD] ?? ''),
      period: String(row[PLAN_PERIOD_FIELD] ?? ''),
      teamName: resolveTeamName(String(row[PLAN_PERIOD_FIELD] ?? '')),
      gaps: {
        机位: gap.parts.机位.gap,
        车辆: gap.parts.车辆.gap,
        人员: gap.parts.人员.gap,
      },
      total: gap.total,
    }))
    .sort((a, b) => a.period.localeCompare(b.period) || a.planId.localeCompare(b.planId))
}
