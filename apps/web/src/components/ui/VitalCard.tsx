import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { Vital } from '../../lib/api'
import { formatValue, timeAgo } from '../../lib/mission'

function isConcerning(v: Vital): boolean {
  return (
    (v.deviation === 'above' && v.worseWhen !== 'low') || (v.deviation === 'below' && v.worseWhen !== 'high')
  )
}

/** One reading compared with the astronaut's own normal ("vs your normal" chip). */
export function VitalCard({ vital }: { vital: Vital }) {
  const concerning = isConcerning(vital)
  const decimals = vital.unit === 'mSv' ? 3 : vital.unit === 'h' || vital.unit === '°C' ? 1 : 0
  const chip =
    vital.baseline == null || vital.deviation === 'unknown'
      ? { text: vital.baseline == null ? 'No personal normal yet' : `Normal ${formatValue(vital.baseline, decimals)}`, icon: Minus, cls: 'text-ink-muted' }
      : vital.deviation === 'normal'
        ? { text: `Within your normal (${formatValue(vital.baseline, decimals)})`, icon: Minus, cls: 'text-status-green' }
        : {
            text: `${Math.abs(vital.z ?? 0).toFixed(1)}σ ${vital.deviation} your normal (${formatValue(vital.baseline, decimals)})`,
            icon: vital.deviation === 'above' ? ArrowUp : ArrowDown,
            cls: concerning ? 'text-status-yellow' : 'text-ink',
          }
  const Icon = chip.icon
  return (
    <div
      className={`rounded-xl border p-4 ${concerning ? 'border-status-yellow/50 bg-status-yellow/5' : 'border-space-700 bg-space-800'}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">{vital.name}</p>
      <p className="mt-1 font-mono text-3xl font-semibold">
        {formatValue(vital.value, decimals)}
        <span className="ml-1 text-sm font-normal text-ink-muted">{vital.unit === 'score' ? '/10' : vital.unit}</span>
      </p>
      <p className={`mt-2 flex items-center gap-1 text-xs ${chip.cls}`}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {chip.text}
      </p>
      <p className="mt-1 text-[11px] text-ink-muted">{timeAgo(vital.measuredAt)}</p>
    </div>
  )
}
