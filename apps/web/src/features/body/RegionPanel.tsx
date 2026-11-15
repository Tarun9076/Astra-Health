import { BookOpen, ChevronRight, ListChecks, Stethoscope, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Panel } from '../../components/ui/Panel'
import { MoreDetail } from '../../components/ui/Simple'
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
      {band && <rect x={pad} width={w - 2 * pad} y={y(band[1])} height={Math.max(1, y(band[0]) - y(band[1]))} fill="var(--color-viz-band)" />}
      <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3} fill="var(--color-accent)" />
    </svg>
  )
}

/** Plain word for one reading against the person's usual value (no statistics shown). */
function word(m: BodyMetric): { text: string; off: boolean } {
  if (m.baseline == null || m.z == null) return { text: 'No usual value yet', off: false }
  if (Math.abs(m.z) < 2) return { text: 'Normal for you', off: false }
  return { text: `${Math.abs(m.z) >= 3 ? 'Much' : 'A bit'} ${m.z > 0 ? 'higher' : 'lower'} than usual`, off: true }
}

function Metric({ m, historyHref }: { m: BodyMetric; historyHref?: (indicator: string) => string }) {
  const unit = m.unit === 'score' ? '/10' : ` ${m.unit}`
  const dec = m.unit === 'mSv' ? 3 : Math.abs(m.value) >= 20 ? 0 : 1
  const w = word(m)
  const first = m.spark[0]
  const change = first && m.spark.length > 1 ? m.value - first.value : null
  const label = infoFor(m.indicator)?.label ?? m.name
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xl font-semibold">{formatValue(m.value, dec)}<span className="text-sm font-normal text-ink-muted">{unit}</span></p>
        <p className={`text-sm ${w.off ? 'font-semibold text-status-yellow' : 'text-status-green'}`}>
          {w.off && <TriangleAlert className="mr-1 inline h-3.5 w-3.5" aria-hidden />}{w.text}
        </p>
        <p className="text-xs text-ink-muted">
          {m.baseline != null && <>Your usual: {formatValue(m.baseline, dec)}{unit} · </>}
          {change != null && <>2 weeks ago: {formatValue(first.value, dec)}{unit} · </>}
          {timeAgo(m.measuredAt)}
        </p>
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

function answerFor(region: BodyRegion, name: string): string {
  if (region.status === 'RED') return `${region.alerts[0]?.title ?? 'An urgent alert'}: follow the emergency steps now.`
  if (region.status === 'YELLOW') {
    const off = region.metrics.filter((m) => m.z != null && Math.abs(m.z) >= 2).map((m) => (infoFor(m.indicator)?.label ?? m.name).toLowerCase())
    return off.length ? `Something needs care: your ${off.slice(0, 2).join(' and ')} ${off.length > 1 ? 'are' : 'is'} not as usual.` : `${region.alerts[0]?.title ?? 'Something needs care'}.`
  }
  if (region.status === 'GREY') return `No readings for your ${name.toLowerCase()} yet.`
  return `Your ${name.toLowerCase()} readings are all normal for you.`
}

/** One body system: a one-line answer, the readings in plain words, what helps, what to watch for. */
export function RegionPanel({ region, alertsHref, historyHref, readOnly = false }: {
  region: BodyRegion
  alertsHref?: (id: string) => string
  historyHref?: (indicator: string) => string
  readOnly?: boolean
}) {
  const sys = SYSTEM_INFO[region.id]
  const Icon = STATUS_ICON[region.status]
  const k = region.knowledge[0]
  const name = sys?.name ?? region.title
  return (
    <Panel>
      <div className="space-y-5">
        <header>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-semibold">{name}</h2>
            <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${STATUS_TEXT[region.status]}`}>
              <Icon className="h-4 w-4" aria-hidden /> {STATUS_LABEL[region.status]}
            </span>
          </div>
          <p className="mt-1 text-base">{answerFor(region, name)}</p>
        </header>

        {region.alerts.length > 0 && (
          <ul className="space-y-2" aria-label="Alerts for this system">
            {region.alerts.map((a) => (
              <li key={a.id}>
                <Link to={alertsHref ? alertsHref(a.id) : '#'} className="flex items-start gap-2 rounded-lg border border-status-yellow/50 p-3 hover:bg-subtle">
                  <SeverityBadge severity={a.severity as 'Attention' | 'Urgent'} />
                  <span className="min-w-0 flex-1 text-sm font-medium">{a.title}</span>
                  <ChevronRight className="mt-0.5 h-4 w-4 text-ink-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Block n={1} title="Your readings">
          {region.metrics.length > 0 ? (
            <ul aria-label="Readings vs your normal">{region.metrics.map((m) => <Metric key={m.indicator} m={m} historyHref={historyHref} />)}</ul>
          ) : (
            <p className="text-ink-muted">No readings yet{region.id === 'eyes' ? ': the crew medical officer records vision checks.' : '.'} No data does not mean normal.</p>
          )}
        </Block>
        <Block n={2} title="What helps">
          {region.tasks.length > 0 && (
            <ul className="mb-2 space-y-1">
              {region.tasks.map((t) => <li key={t.id} className="flex items-start gap-2"><ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />{t.title}</li>)}
            </ul>
          )}
          {k?.whatYouCanDo ? <p className="leading-relaxed">{firstSentences(k.whatYouCanDo, 2)}</p> : <p>Keep up your daily exercise, sleep and water.</p>}
          {!readOnly && region.tasks.length > 0 && <Link to="/astronaut/guidance" className="mt-1 inline-block text-sm font-medium text-accent hover:underline">Open My Guidance</Link>}
        </Block>
        <Block n={3} title="Watch for">
          <ul className="list-disc space-y-0.5 pl-5">{(sys?.symptoms ?? []).slice(0, 4).map((s) => <li key={s}>{s}</li>)}</ul>
          {!readOnly && (
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link to="/astronaut/checkin" className="font-medium text-accent hover:underline">Report a symptom</Link>
              <Link to="/astronaut/emergency" className="font-medium text-status-red hover:underline">Emergency steps</Link>
            </p>
          )}
        </Block>

        <MoreDetail label="Learn more about this part of the body">
          <div className="space-y-3 text-ink">
            <p><span className="font-semibold">What it does.</span> {sys?.does ?? '—'}</p>
            {k && (
              <p><span className="font-semibold">In space.</span> {k.whatHappens}{' '}
                <a href={k.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink">
                  <BookOpen className="h-3 w-3" aria-hidden /> {new URL(k.source).hostname}
                </a>
              </p>
            )}
            {k?.whatYouCanDo && <p><span className="font-semibold">Protecting it.</span> {k.whatYouCanDo}</p>}
            <p><span className="font-semibold">What is measured.</span> {(sys?.monitored ?? []).join(', ')}</p>
            {(sys?.symptoms.length ?? 0) > 4 && <p><span className="font-semibold">Other signs.</span> {sys!.symptoms.slice(4).join('; ')}</p>}
          </div>
        </MoreDetail>
        <p className="flex items-start gap-1.5 text-xs text-ink-muted">
          <Stethoscope className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> General information, not a diagnosis.
        </p>
      </div>
    </Panel>
  )
}

function firstSentences(text: string, n: number): string {
  return text.split(/(?<=[.!?])\s+/).slice(0, n).join(' ')
}
