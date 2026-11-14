import { ChevronDown, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { AlertSummary, Vital } from '../../lib/api'
import { evidenceLines, mainIndicator } from '../../lib/alertText'
import { decimalsFor, infoFor, unitLabel } from '../../lib/indicators'
import { formatValue, timeAgo } from '../../lib/mission'
import { useAlert, useCatalog } from '../../lib/queries'
import { Loading } from '../ui/Panel'
import { SeverityBadge } from '../ui/Status'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{title}</h4>
      <div className="mt-1 text-sm text-ink">{children}</div>
    </div>
  )
}

/**
 * One health observation explained in full: what changed, which measurement and how it compares with
 * the astronaut's normal, why it matters, what to do, and when to get medical help.
 */
export function ObservationCard({ alert, open = false, detailHref }: { alert: AlertSummary; open?: boolean; detailHref?: string }) {
  const urgent = alert.severity === 'Urgent'
  return (
    <details open={open}
      className={`group rounded-xl border bg-surface ${urgent ? 'border-2 border-status-red' : 'border-status-yellow/60'}`}>
      <summary className="flex min-h-14 cursor-pointer list-none items-start gap-3 p-4">
        <SeverityBadge severity={alert.severity} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink">{alert.title}</span>
          <span className="mt-0.5 block text-xs text-ink-muted">
            First noticed {timeAgo(alert.firstTriggeredAt)} · seen {alert.triggerCount} time{alert.triggerCount === 1 ? '' : 's'}
            {alert.escalationRequired && ' · flight surgeon notified'}
          </span>
        </span>
        <span className="mt-1 hidden text-xs font-medium text-accent sm:inline group-open:hidden">Explain</span>
        <ChevronDown className="mt-1 h-5 w-5 shrink-0 text-ink-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <ObservationBody alert={alert} detailHref={detailHref} />
    </details>
  )
}

/**
 * A reading outside the astronaut's normal with no open alert about it: shown honestly, with
 * why there is no alert and what to do.
 */
export function ReadingObservation({ vital }: { vital: Vital }) {
  const info = infoFor(vital.indicator)
  const label = info?.label ?? vital.name
  const dec = decimalsFor(vital.unit)
  const u = unitLabel(vital.unit)
  const fmt = (v: number) => `${formatValue(v, dec)}${u.startsWith('/') ? '' : ' '}${u}`
  const higher = vital.deviation === 'above'
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex min-h-14 cursor-pointer list-none items-start gap-3 p-4">
        <span className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2.5 py-0.5 text-xs font-semibold text-ink">
          <TriangleAlert className="h-3.5 w-3.5 text-status-yellow" aria-hidden /> Watch
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink">{label} is {higher ? 'higher' : 'lower'} than your normal</span>
          <span className="mt-0.5 block text-xs text-ink-muted">Latest reading {timeAgo(vital.measuredAt)} · no open alert</span>
        </span>
        <ChevronDown className="mt-1 h-5 w-5 shrink-0 text-ink-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="grid gap-4 border-t border-line p-4 md:grid-cols-2">
        <Section title="What changed">
          {fmt(vital.value)}
          {vital.baseline != null && <> — your normal is {fmt(vital.baseline)}</>}
          {vital.baseline != null && vital.sigma != null && <> (usual {fmt(vital.baseline - 2 * vital.sigma)} to {fmt(vital.baseline + 2 * vital.sigma)})</>}.
        </Section>
        <Section title="Why there is no alert">
          A reading outside your range can happen for ordinary reasons (time of day, exercise, a poor measurement). The
          rules raise an alert when a change repeats or a safety limit is crossed.</Section>
        {info && <Section title="Why it matters">{info.why}</Section>}
        <Section title="What to do">
          Measure again at your next check-in{info?.how ? `: ${info.how.charAt(0).toLowerCase()}${info.how.slice(1)}` : '.'}
        </Section>
        <Section title="When to get medical help">{info?.help ?? 'If you feel unwell, contact the crew medical officer.'}</Section>
      </div>
    </details>
  )
}

function ObservationBody({ alert, detailHref }: { alert: AlertSummary; detailHref?: string }) {
  const { data: detail, isPending } = useAlert(alert.id)
  const { data: catalog } = useCatalog()
  if (isPending || !detail) return <div className="border-t border-line p-4"><Loading /></div>
  const lines = evidenceLines(detail, catalog)
  const main = mainIndicator(detail)
  const info = main ? infoFor(main) : undefined
  const urgent = detail.severity === 'Urgent'
  const tasks = detail.recommendations.filter((t) => t.status === 'Pending')

  return (
    <div className="grid gap-4 border-t border-line p-4 md:grid-cols-2">
      <Section title="What changed">{detail.reason}</Section>
      <Section title="The measurement">
        {lines.length === 0 ? '—' : (
          <ul className="space-y-1">
            {lines.map((l, i) => (
              <li key={i}><span className="font-medium">{l.label}:</span> {l.text}</li>
            ))}
          </ul>
        )}
      </Section>
      {info && <Section title="What it means">{info.what}</Section>}
      {info && <Section title="Why it matters">{info.why}</Section>}
      <Section title="What to do">
        {urgent && detail.emergencyProtocol ? (
          <Link to="/astronaut/emergency" className="inline-flex items-center gap-1.5 font-semibold text-status-red underline">
            <ShieldAlert className="h-4 w-4" aria-hidden /> Follow the emergency procedure: {detail.emergencyProtocol.title}
          </Link>
        ) : tasks.length > 0 ? (
          <ol className="list-decimal space-y-1 pl-5">
            {tasks.map((t) => (
              <li key={t.id}>
                <span className="font-medium">{t.title}</span>
                {t.dueAt && <span className="text-ink-muted"> · by {new Date(t.dueAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
              </li>
            ))}
          </ol>
        ) : (
          'No action needed beyond your normal routine. Keep doing your daily check-in so changes are noticed early.'
        )}
      </Section>
      <Section title="When to get medical help">
        {urgent ? (
          <strong className="text-status-red">Now. Call the crew medical officer; the flight surgeon has been alerted.</strong>
        ) : (
          <>
            {info?.help ?? 'If it gets worse, or you feel unwell, contact the crew medical officer.'}
            {detail.escalationRequired && ' The flight surgeon has been notified because this keeps happening.'}
          </>
        )}
      </Section>
      {detailHref && (
        <p className="md:col-span-2">
          <Link to={detailHref} className="text-sm font-medium text-accent hover:underline">
            Full details, evidence and history
          </Link>
        </p>
      )}
    </div>
  )
}
