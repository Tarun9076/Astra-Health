import { BookOpen, ChevronRight, ListChecks, Stethoscope, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Panel } from '../../components/ui/Panel'
import { SeverityBadge } from '../../components/ui/Status'
import { infoFor } from '../../lib/indicators'
import { formatValue, timeAgo } from '../../lib/mission'
import type { BodyMetric, BodyRegion } from '../../lib/queries'
import { STATUS_ICON, STATUS_LABEL, SYSTEM_INFO, type RegionStatus } from './regions'

const STATUS_TEXT: Record<RegionStatus, string> = {
  GREEN: 'text-status-green',
  YELLOW: 'text-status-yellow',
  RED: 'text-status-red',
  GREY: 'text-ink-muted',
}

/** 14-day line with the personal normal range (±2σ) as a shaded band; values are read out in text. */
function Sparkline({ metric }: { metric: BodyMetric }) {
  const pts = metric.spark
  if (pts.length < 2) return null
  const values = pts.map((p) => p.value)
  const band = metric.baseline != null && metric.sigma != null ? [metric.baseline - 2 * metric.sigma, metric.baseline + 2 * metric.sigma] : null
  const lo = Math.min(...values, ...(band ? [band[0]] : []))
  const hi = Math.max(...values, ...(band ? [band[1]] : []))
  const w = 160, h = 40, pad = 4
  const x = (i: number) => pad + (i / (pts.length - 1)) * (w - 2 * pad)
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - 2 * pad)
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-36 shrink-0" aria-hidden>
      {band && <rect x={pad} width={w - 2 * pad} y={y(band[1])} height={Math.max(1, y(band[0]) - y(band[1]))} fill="#146eb8" opacity={0.1} />}
      <path d={path} fill="none" stroke="#146eb8" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3} fill="#146eb8" />
    </svg>
  )
}

function Metric({ m, historyHref }: { m: BodyMetric; historyHref?: (indicator: string) => string }) {
  const unit = m.unit === 'score' ? '/10' : ` ${m.unit}`
  const dec = m.unit === 'mSv' ? 3 : Math.abs(m.value) >= 20 ? 0 : 1
  const off = m.z != null && Math.abs(m.z) >= 2
  const first = m.spark[0]
  const change = first && m.spark.length > 1 ? m.value - first.value : null
  const label = infoFor(m.indicator)?.label ?? m.name
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xl font-semibold">{formatValue(m.value, dec)}<span className="text-sm font-normal text-ink-muted">{unit}</span></p>
        <p className={`text-xs ${off ? 'font-semibold text-status-yellow' : 'text-ink-muted'}`}>
          {off && <TriangleAlert className="mr-1 inline h-3.5 w-3.5" aria-hidden />}
          {m.baseline != null ? `Your normal ${formatValue(m.baseline, dec)}${unit}${off ? (m.z! > 0 ? ' · higher than normal' : ' · lower than normal') : ' · within normal'}` : 'No personal normal yet'}
          {' · '}{timeAgo(m.measuredAt)}
        </p>
        {change != null && (
          <p className="text-xs text-ink-muted">
            14-day change: {change === 0 ? 'no change' : `${change > 0 ? '+' : '−'}${formatValue(Math.abs(change), dec)}${unit}`}
          </p>
        )}
      </div>
      <div className="flex flex-col items-end gap-1">
        <Sparkline metric={m} />
        {historyHref && <Link to={historyHref(m.indicator)} className="text-xs font-medium text-accent hover:underline">History<span className="sr-only"> of {label}</span></Link>}
      </div>
    </li>
  )
}

function Block({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[11px] text-accent" aria-hidden>{n}</span>
        {title}
      </h3>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  )
}

/** One body system explained: what it does, space effects, what is monitored, readings, change, symptoms, prevention. */
export function RegionPanel({ region, alertsHref, historyHref, readOnly = false }: {
  region: BodyRegion
  alertsHref?: (id: string) => string
  historyHref?: (indicator: string) => string
  readOnly?: boolean
}) {
  const sys = SYSTEM_INFO[region.id]
  const Icon = STATUS_ICON[region.status]
  const k = region.knowledge[0]
  return (
    <Panel>
      <div className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">{sys?.name ?? region.title}</h2>
          <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${STATUS_TEXT[region.status]}`}>
            <Icon className="h-4 w-4" aria-hidden /> {STATUS_LABEL[region.status]}
          </span>
        </header>

        {region.alerts.length > 0 && (
          <ul className="space-y-2" aria-label="Alerts for this system">
            {region.alerts.map((a) => (
              <li key={a.id}>
                <Link to={alertsHref ? alertsHref(a.id) : '#'} className="flex items-start gap-2 rounded-lg border border-status-yellow/50 p-3 hover:bg-subtle">
                  <SeverityBadge severity={a.severity as 'Attention' | 'Urgent'} />
                  <span className="min-w-0 flex-1 text-sm"><span className="font-medium">{a.title}</span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{a.reason}</span></span>
                  <ChevronRight className="mt-1 h-4 w-4 text-ink-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Block n={1} title="What this system does">{sys?.does ?? '—'}</Block>
        <Block n={2} title="How spaceflight affects it">
          {k ? (
            <>
              <p className="leading-relaxed">{k.whatHappens}</p>
              <a href={k.source} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink">
                <BookOpen className="h-3 w-3" aria-hidden /> Source: {new URL(k.source).hostname}
              </a>
            </>
          ) : 'No notes for this system yet.'}
        </Block>
        <Block n={3} title="What is monitored">
          <ul className="flex flex-wrap gap-1.5">
            {(sys?.monitored ?? []).map((m) => <li key={m} className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs">{m}</li>)}
          </ul>
        </Block>
        <Block n={4} title="Latest measurements and 14-day change">
          {region.metrics.length > 0 ? (
            <ul aria-label="Readings vs your normal">{region.metrics.map((m) => <Metric key={m.indicator} m={m} historyHref={historyHref} />)}</ul>
          ) : (
            <p className="text-ink-muted">No readings for this system yet{region.id === 'eyes' ? ' — vision checks are recorded by the crew medical officer.' : '.'} Missing data is not the same as normal.</p>
          )}
        </Block>
        <Block n={5} title="Symptoms to watch for">
          <ul className="list-disc space-y-0.5 pl-5">{(sys?.symptoms ?? []).map((s) => <li key={s}>{s}</li>)}</ul>
          {!readOnly && (
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <Link to="/astronaut/checkin" className="font-medium text-accent hover:underline">Report a symptom in your check-in</Link>
              <Link to="/astronaut/emergency" className="font-medium text-status-red hover:underline">Emergency procedures</Link>
            </p>
          )}
        </Block>
        <Block n={6} title="How to protect it">
          {k?.whatYouCanDo ? <p className="leading-relaxed">{k.whatYouCanDo}</p> : <p className="text-ink-muted">Follow your daily exercise, sleep and hydration plan.</p>}
          {region.tasks.length > 0 && (
            <div className="mt-2 rounded-lg bg-accent-soft p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-accent"><ListChecks className="h-4 w-4" aria-hidden /> Your next steps</p>
              <ul className="mt-1 list-disc pl-5">{region.tasks.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
              {!readOnly && <Link to="/astronaut/guidance" className="mt-1 inline-block text-xs font-medium text-accent hover:underline">Open My Guidance</Link>}
            </div>
          )}
          <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-muted">
            <Stethoscope className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> General information, not a diagnosis. Your flight surgeon can advise on your own situation.
          </p>
        </Block>
      </div>
    </Panel>
  )
}
