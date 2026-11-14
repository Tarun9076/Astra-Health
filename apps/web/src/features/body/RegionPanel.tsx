import { BookOpen, ChevronRight, ListChecks } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Panel } from '../../components/ui/Panel'
import { SeverityBadge } from '../../components/ui/Status'
import { formatValue, timeAgo } from '../../lib/mission'
import type { BodyMetric, BodyRegion } from '../../lib/queries'
import { STATUS_FILL, STATUS_LABEL } from './regions'

/** Small trend line for the last 14 days with the personal normal (±2σ) as a neutral band. */
function Sparkline({ metric }: { metric: BodyMetric }) {
  const pts = metric.spark
  if (pts.length < 2) return null
  const values = pts.map((p) => p.value)
  const band = metric.baseline != null && metric.sigma != null
    ? [metric.baseline - 2 * metric.sigma, metric.baseline + 2 * metric.sigma] : null
  const lo = Math.min(...values, ...(band ? [band[0]] : []))
  const hi = Math.max(...values, ...(band ? [band[1]] : []))
  const w = 120, h = 32, pad = 3
  const x = (i: number) => pad + (i / (pts.length - 1)) * (w - 2 * pad)
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - 2 * pad)
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-28" aria-hidden>
      {band && <rect x={pad} width={w - 2 * pad} y={y(band[1])} height={Math.max(1, y(band[0]) - y(band[1]))} fill="#94a3c4" opacity={0.15} />}
      <path d={path} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.5} fill="#38bdf8" />
    </svg>
  )
}

function Metric({ m }: { m: BodyMetric }) {
  const unit = m.unit === 'score' ? '/10' : ` ${m.unit}`
  const dec = m.unit === 'mSv' ? 3 : Math.abs(m.value) >= 20 ? 0 : 1
  const off = m.z != null && Math.abs(m.z) >= 2
  return (
    <li className="flex items-center justify-between gap-3 border-t border-space-700 py-2 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{m.name}</p>
        <p className="font-mono text-lg">{formatValue(m.value, dec)}<span className="text-sm text-ink-muted">{unit}</span></p>
        <p className={`text-xs ${off ? 'font-semibold text-status-yellow' : 'text-ink-muted'}`}>
          {m.baseline != null
            ? `Your normal ${formatValue(m.baseline, dec)}${unit}${m.z != null ? ` · ${m.z > 0 ? '+' : ''}${m.z.toFixed(1)}σ` : ''}`
            : 'No personal normal yet'} · {timeAgo(m.measuredAt)}
        </p>
      </div>
      <Sparkline metric={m} />
    </li>
  )
}

export function RegionPanel({ region, alertsHref }: { region: BodyRegion; alertsHref?: (id: string) => string }) {
  return (
    <Panel>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{region.title}</h2>
          <span className="inline-flex items-center gap-2 text-sm">
            <span className="h-3 w-3 rounded-full" style={{ background: STATUS_FILL[region.status] }} aria-hidden />
            {STATUS_LABEL[region.status]}
          </span>
        </div>

        {region.metrics.length > 0 ? (
          <ul aria-label="Readings vs your normal">{region.metrics.map((m) => <Metric key={m.indicator} m={m} />)}</ul>
        ) : (
          <p className="text-sm text-ink-muted">No readings for this region yet{region.id === 'eyes' ? ' — vision checks are recorded by the crew medical officer.' : '.'}</p>
        )}

        {region.alerts.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold tracking-wider text-ink-muted uppercase">Alerts</h3>
            <ul className="space-y-2">
              {region.alerts.map((a) => (
                <li key={a.id}>
                  <Link to={alertsHref ? alertsHref(a.id) : '#'} className="flex items-start gap-2 rounded-lg p-2 hover:bg-space-700/50">
                    <SeverityBadge severity={a.severity as 'Attention' | 'Urgent'} />
                    <span className="min-w-0 flex-1 text-sm"><span className="font-medium">{a.title}</span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-ink-muted">{a.reason}</span></span>
                    <ChevronRight className="mt-1 h-4 w-4 text-ink-muted" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {region.tasks.length > 0 && (
          <div>
            <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold tracking-wider text-ink-muted uppercase"><ListChecks className="h-3.5 w-3.5" aria-hidden /> Next steps</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">{region.tasks.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
          </div>
        )}

        {region.knowledge.map((k) => (
          <div key={k.noteId} className="rounded-lg border border-space-700 bg-space-900/50 p-3">
            <h3 className="text-xs font-semibold tracking-wider text-accent uppercase">What changes in space · {k.title}</h3>
            <p className="mt-1 text-sm leading-relaxed">{k.whatHappens}</p>
            {k.whatYouCanDo && <p className="mt-2 text-sm leading-relaxed text-ink-muted"><span className="font-medium text-ink">What you can do: </span>{k.whatYouCanDo}</p>}
            <a href={k.source} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink">
              <BookOpen className="h-3 w-3" aria-hidden /> Source: {new URL(k.source).hostname}
            </a>
          </div>
        ))}
      </div>
    </Panel>
  )
}
