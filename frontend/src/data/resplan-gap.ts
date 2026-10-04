import type { EntryRow } from './types'

// 资源缺口测算的唯一入口。
// 机位需求、车辆需求、人员需求原本是三个各算各的调用点：机位栏减一个值、
// 车辆栏带进一个值、人员栏干脆没扣。现在全部收进 measureResourceGap，
// 计划页展示、下发记账、迁移回填、班组待办读到的都是这一份，口径不再分叉。

// 扣减顺序：机位 → 车辆 → 人员。
// 依据：机位是保障的物理入口，机位不落实，车辆、人员无处展开；车辆到位后
// 人员才能上岗作业；人员弹性最大、可跨班组调配，放最后扣。顺序与页面上
// 三列的排列一致，核对台账不用倒查。合计是加法，顺序不改变合计数值，
// 固定顺序是为了分解明细在计划页、台账、班组待办三处的呈现口径统一。
export const DEDUCT_ORDER = ['机位需求', '车辆需求', '人员需求'] as const

export type GapBreakdown = {
  机位缺口: number
  车辆缺口: number
  人员缺口: number
  合计缺口: number
}

// 需求字段历史上是自由文本（"2"、"2台"、样例说明都出现过）：
// 抽出首个整数，抽不到按 0，绝不让脏文本把缺口算成 NaN。
function parseDemand(value: unknown): number {
  const match = String(value ?? '').match(/-?\d+/)
  return match ? Number(match[0]) : 0
}

// 缺口为负（富余、回冲）按 0 记，不做跨类抵销。
// 依据：缺口的语义是"还差多少要补"，富余不是缺口；机位、车辆、人员物理上
// 不可互换，机位富余顶不了车辆，允许抵销会低估真实缺口；待办清单里出现
// 负数没有可执行含义。原始负值留在需求字段里不丢，需要追查时还能看到。
function clampGap(demand: number): number {
  return demand > 0 ? demand : 0
}

export function measureResourceGap(row: EntryRow): GapBreakdown {
  const [机位缺口, 车辆缺口, 人员缺口] = DEDUCT_ORDER.map((field) =>
    clampGap(parseDemand(row[field])),
  )
  return { 机位缺口, 车辆缺口, 人员缺口, 合计缺口: 机位缺口 + 车辆缺口 + 人员缺口 }
}

export function hasResourceGap(row: EntryRow): boolean {
  return measureResourceGap(row).合计缺口 > 0
}
