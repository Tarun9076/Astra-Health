// Chart colours and data shaping, shared by charts.tsx and AnalyticsPage.tsx (kept out of the component file for fast refresh).
import type { Analytics } from '../../lib/api'
import { dayOf } from '../../lib/mission'

// Light clinical surface. series1/series2 validated with the dataviz palette checker (light mode):
// CVD ΔE 14.1, normal-vision ΔE 26.3, both ≥ 3:1 on white. Status colours are the app tokens.
export const VIZ = {
  series1: '#1f6fd1',
  series2: '#c2417a',
  band: 'rgba(20, 110, 184, 0.08)',
  bandEdge: 'rgba(20, 110, 184, 0.35)',
  grid: '#e2e8f0',
  axis: '#5b6b80',
  text: '#172033',
  surface: '#ffffff',
  attention: '#9a4507',
  urgent: '#b91c1c',
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

