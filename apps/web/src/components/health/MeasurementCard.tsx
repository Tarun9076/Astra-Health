import { Clock, Info } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Vital } from '../../lib/api'
import { decimalsFor, infoFor, unitLabel } from '../../lib/indicators'
import { formatValue, timeAgo } from '../../lib/mission'
import { readingStatus } from '../../lib/readingStatus'

const SOURCE: Record<string, string> = {
  Manual: 'Entered by you',
  Wearable: 'Wearable',
  Device: 'Medical device',
  Simulated: 'Simulated device',
}

const TONE = {
  ok: { text: 'text-status-green', card: 'border-line' },
  warn: { text: 'text-status-yellow', card: 'border-status-yellow/60 bg-status-yellow/[0.04]' },
  neutral: { text: 'text-ink-muted', card: 'border-line' },
}

function joined(vitals: Vital[], pick: (v: Vital) => number | null | undefined, dec: number): string | null {
  const values = vitals.map(pick)
  if (values.some((x) => x == null)) return null
  return values.map((x) => formatValue(x as number, dec)).join('/')
}

/**
 * One measurement explained: value + unit, status in words, personal normal, change since the previous
 * reading, when and how it was recorded, and a link to its history.
 */
export function MeasurementCard({ label, vitals, historyHref }: { label: string; vitals: Vital[]; historyHref?: string }) {
  const unit = vitals[0].unit
  const dec = decimalsFor(unit)
  const status = readingStatus(vitals)
  const tone = TONE[status.tone]
  const Icon = status.icon
  const value = joined(vitals, (v) => v.value, dec)
  const normal = joined(vitals, (v) => v.baseline, dec)
  const low = joined(vitals, (v) => (v.baseline != null && v.sigma != null ? v.baseline - 2 * v.sigma : null), dec)
  const high = joined(vitals, (v) => (v.baseline != null && v.sigma != null ? v.baseline + 2 * v.sigma : null), dec)
  const previous = joined(vitals, (v) => v.previousValue, dec)
  const delta = vitals.length === 1 && vitals[0].previousValue != null ? vitals[0].value - vitals[0].previousValue : null
  const u = unitLabel(unit)
  const info = infoFor(vitals[0].indicator)
  const source = vitals[0].source ? (SOURCE[vitals[0].source] ?? vitals[0].source) : null

  return (
    <article className={`flex flex-col rounded-xl border bg-surface p-4 ${tone.card}`} aria-label={label}>
      <h3 className="text-sm font-semibold text-ink">{label}</h3>
      <p className="mt-1 text-3xl font-semibold tracking-tight text-ink">
        {value}
        <span className="ml-1 text-base font-normal text-ink-muted">{u}</span>
      </p>
      <p className={`mt-1 flex items-start gap-1.5 text-sm font-medium ${tone.text}`}>
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {status.text}
      </p>
      <dl className="mt-3 space-y-1 text-xs text-ink-muted">
        {normal && (
          <div>
            <dt className="inline">Your normal: </dt>
            <dd className="inline text-ink">
              {normal} {u}
              {low && high && <span className="text-ink-muted"> (usual {low}–{high})</span>}
            </dd>
          </div>
        )}
        {previous && (
          <div>
            <dt className="inline">Previous: </dt>
            <dd className="inline text-ink">
              {previous} {u}
              {delta != null && Math.abs(delta) > 0 && (
                <span className="text-ink-muted"> ({delta > 0 ? '+' : '−'}{formatValue(Math.abs(delta), dec)} since then)</span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt className="sr-only">Recorded</dt>
          <dd>
            <time dateTime={vitals[0].measuredAt} title={new Date(vitals[0].measuredAt).toLocaleString()}>
              {timeAgo(vitals[0].measuredAt)}
            </time>
            {source && ` · ${source}`}
          </dd>
        </div>
      </dl>
      {info && (
        <details className="group mt-3 text-xs">
          <summary className="inline-flex min-h-8 cursor-pointer items-center gap-1 font-medium text-accent">
            <Info className="h-3.5 w-3.5" aria-hidden /> What this means
          </summary>
          <p className="mt-1 text-ink">{info.what}</p>
          <p className="mt-1 text-ink-muted">{info.why}</p>
        </details>
      )}
      {historyHref && (
        <Link to={historyHref} className="mt-auto pt-3 text-sm font-medium text-accent hover:underline">
          View history <span className="sr-only">of {label}</span>
        </Link>
      )}
    </article>
  )
}

/** Placeholder for a key measurement with no reading: missing data is never shown as normal. */
export function MissingMeasurementCard({ label, how, href }: { label: string; how: string; href?: string }) {
  return (
    <article className="flex flex-col rounded-xl border border-dashed border-line-strong bg-surface p-4" aria-label={label}>
      <h3 className="text-sm font-semibold text-ink">{label}</h3>
      <p className="mt-1 text-3xl font-semibold text-ink-muted">—</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-muted">
        <Clock className="h-4 w-4" aria-hidden /> No reading yet
      </p>
      <p className="mt-3 text-xs text-ink-muted">{how}</p>
      {href && (
        <Link to={href} className="mt-auto pt-3 text-sm font-medium text-accent hover:underline">
          Measure now
        </Link>
      )}
    </article>
  )
}
