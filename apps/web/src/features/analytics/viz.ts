// Chart colours and data shaping, shared by charts.tsx and AnalyticsPage.tsx (kept out of the component file for fast refresh).
import type { Analytics } from '../../lib/api'
import { dayOf } from '../../lib/mission'

// Theme tokens (index.css), so charts follow light and dark. series1/series2 validated with the dataviz palette checker (light mode):
// CVD ΔE 14.1, normal-vision ΔE 26.3, both ≥ 3:1 on white. Status colours are the app tokens.
export const VIZ = {
  series1: 'var(--color-viz-1)',
  series2: 'var(--color-viz-2)',
  band: 'var(--color-viz-band)',
  bandEdge: 'var(--color-viz-band-edge)',
  grid: 'var(--color-line)',
  axis: 'var(--color-ink-muted)',
  text: 'var(--color-ink)',
  surface: 'var(--color-surface)',
  attention: 'var(--color-status-yellow)',
  urgent: 'var(--color-status-red)',
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

