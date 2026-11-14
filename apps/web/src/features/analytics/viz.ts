// Chart colours and data shaping, shared by charts.tsx and AnalyticsPage.tsx (kept out of the component file for fast refresh).
import type { Analytics } from '../../lib/api'
import { dayOf } from '../../lib/mission'

export const VIZ = {
  series1: '#3987e5',
  series2: '#d55181',
  band: 'rgba(148, 163, 196, 0.16)',
  bandEdge: 'rgba(148, 163, 196, 0.45)',
  grid: '#1c2742',
  axis: '#94a3c4',
  text: '#e6ecff',
  surface: '#121a2e',
  attention: '#f59e0b',
  urgent: '#ef4444',
}

export interface ValueRow {
  key: string
  label: string
  date: string
  value: number | null
  band: [number, number] | null
  median: number | null
  z: number | null
  flagged: number | null
  flaggedReason: string | null
}

export function dayLabel(missionStart: string | null | undefined, isoDay: string): string {
  return missionStart ? `D${dayOf(missionStart, `${isoDay}T12:00:00Z`)}` : isoDay.slice(5)
}

export function toValueRows(data: Analytics, missionStart?: string | null): ValueRow[] {
  const flaggedByDay = new Map<string, { value: number | null; reason: string | null }>()
  for (const q of data.questionable) flaggedByDay.set(q.t.slice(0, 10), { value: q.value, reason: q.reason })
  return data.days.map((d) => {
    const flagged = flaggedByDay.get(d.day)
    return {
      key: d.day,
      label: dayLabel(missionStart, d.day),
      date: d.day,
      value: d.value ?? null,
      band: d.low != null && d.high != null ? [d.low, d.high] : null,
      median: d.median ?? null,
      z: d.z ?? null,
      flagged: flagged?.value ?? null,
      flaggedReason: flagged?.reason ?? null,
    }
  })
}

