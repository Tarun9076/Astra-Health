// Turns an alert's stored evidence into plain sentences ("91 bpm on average — your normal is 64 bpm").
import type { AlertDetail, Indicator } from './api'
import { infoFor, unitLabel } from './indicators'
import { formatValue } from './mission'

export type EvidenceLine = { indicator: string; label: string; text: string }

const ML: Record<string, string> = {
  ml_anomaly: 'Machine-learning pattern check (supporting information only)',
  ml_trend: 'Recovery-strain trend (supporting information only)',
}

const AGG: Record<string, string> = {
  latest: 'latest reading',
  mean: 'average',
  max: 'highest',
  min: 'lowest',
  sum: 'total',
}

function aggWords(agg: string, window: string): string {
  if (agg.startsWith('count')) return `in the last ${window}`
  const word = AGG[agg] ?? agg.replace(/_/g, ' ')
  return window && window !== 'now' ? `${word} over ${window}` : word
}

function compare(z: number): string {
  const size = Math.abs(z) >= 3 ? 'well' : 'clearly'
  return `${size} ${z > 0 ? 'above' : 'below'} your normal`
}

export function evidenceLines(detail: AlertDetail, catalog: Record<string, Indicator> | undefined): EvidenceLine[] {
  const rows = Object.values(detail.evidence) as Record<string, unknown>[]
  return rows.map((ev) => {
    const indicator = String(ev.indicator)
    if (ML[indicator]) {
      const v = typeof ev.value === 'number' ? ev.value.toFixed(2) : '—'
      return { indicator, label: ML[indicator], text: `Score ${v}. It agrees with the measurements but never decides on its own.` }
    }
    if (ev.agg === 'reported') {
      return { indicator, label: 'Symptom you reported', text: indicator.replace(/_/g, ' ') }
    }
    const meta = catalog?.[indicator]
    const label = infoFor(indicator)?.label ?? meta?.name ?? indicator.replace(/_/g, ' ')
    const unit = meta ? unitLabel(meta.unit) : ''
    const dec = Math.max(meta?.decimals ?? 1, 0)
    const fmt = (v: number) => `${formatValue(v, dec)}${unit.startsWith('/') ? '' : ' '}${unit}`.trim()
    if (ev.missing) return { indicator, label, text: 'No reading in this period.' }
    if (String(ev.agg).startsWith('count')) {
      return { indicator, label, text: `${String(ev.value)} reading(s) outside your normal ${aggWords(String(ev.agg), String(ev.window))}.` }
    }
    const parts: string[] = []
    if (typeof ev.value === 'number') parts.push(`${fmt(ev.value)} (${aggWords(String(ev.agg), String(ev.window))})`)
    if (typeof ev.baseline === 'number') {
      const range = typeof ev.sigma === 'number' ? ` (usual range ${fmt(ev.baseline - 2 * ev.sigma)} to ${fmt(ev.baseline + 2 * ev.sigma)})` : ''
      parts.push(`your normal is ${fmt(ev.baseline)}${range}`)
    }
    if (typeof ev.z === 'number' && Math.abs(ev.z) >= 1) parts.push(compare(ev.z))
    if (typeof ev.ratio === 'number') parts.push(`${ev.ratio.toFixed(1)} times your usual level`)
    return { indicator, label, text: parts.join(' — ') || 'See the alert details.' }
  })
}

/** The first real measurement behind an alert (not ML, not a symptom): used for "what it means". */
export function mainIndicator(detail: AlertDetail): string | undefined {
  const rows = Object.values(detail.evidence) as Record<string, unknown>[]
  return rows.map((r) => String(r.indicator)).find((i) => !ML[i] && infoFor(i))
}
