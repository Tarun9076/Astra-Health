import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { AlertOctagon, CheckCircle2, CheckSquare, ChevronDown, ChevronRight, ShieldAlert, Square, TriangleAlert } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { INSIGHT_NOTE, InsightList } from '../../components/ui/InsightList'
import { Button, ErrorNote, Loading, Panel, ProtocolSteps } from '../../components/ui/Panel'
import { MoreDetail } from '../../components/ui/Simple'
import { AlertStatusChip, SeverityBadge } from '../../components/ui/Status'
import { api, unwrap, type AlertDetail, type AlertSummary, type Indicator } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { evidenceLines, mainIndicator } from '../../lib/alertText'
import { infoFor } from '../../lib/indicators'
import { dayOf, formatValue } from '../../lib/mission'
import { useAlert, useAlerts, useCatalog } from '../../lib/queries'

export function AlertsPage({ code: forCode, staff = false }: { code?: string; staff?: boolean } = {}) {
  const user = useAuth((s) => s.user)
  const code = forCode ?? user?.astronautCode
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'history' ? 'all' : 'active'
  const openId = params.get('id')
  const { data, error, isPending } = useAlerts(code, tab)

  const setTab = (t: 'active' | 'all') => setParams(t === 'all' ? { tab: 'history' } : {})
  const toggle = (id: string) => {
    const next = new URLSearchParams(params)
    if (openId === id) next.delete('id')
    else next.set('id', id)
    setParams(next)
  }

  return (
    <div className="max-w-4xl space-y-4">
      {!staff && <LevelsLegend />}
      <div className="flex gap-1" role="group" aria-label="Show">
        {(['active', 'all'] as const).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}
            className={`min-h-10 rounded-lg px-4 text-sm font-medium ${tab === t ? 'bg-accent text-on-accent' : 'text-ink hover:bg-subtle'}`}>
            {t === 'active' ? 'Open alerts' : 'All alerts, including closed'}
          </button>
        ))}
      </div>
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && data.length === 0 && (
        <Panel><p className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-status-green" aria-hidden />{tab === 'active' ? 'No open alerts. Your status is Normal.' : 'No alerts yet.'}</p></Panel>
      )}
      <ul className="space-y-3">
        {data?.map((a) => (
          <li key={a.id}>
            <AlertCard alert={a} open={openId === a.id} onToggle={() => toggle(a.id)} missionStart={user?.missionStart} staff={staff} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function AlertCard({ alert, open, onToggle, missionStart, staff }: {
  alert: AlertSummary
  open: boolean
  onToggle: () => void
  missionStart?: string | null
  staff: boolean
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  const urgent = alert.severity === 'Urgent'
  return (
    <div className={`rounded-xl border bg-surface ${urgent && open ? 'border-status-red/60' : 'border-line'}`}>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 p-4 text-left">
        <SeverityBadge severity={alert.severity} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {alert.title} <AlertStatusChip status={alert.status} />
          </p>
          <p className="mt-1 text-sm text-ink-muted">{alert.reason}</p>
          <p className="mt-1 text-xs text-ink-muted">
            {missionStart && `Day ${dayOf(missionStart, alert.firstTriggeredAt)}–${dayOf(missionStart, alert.lastTriggeredAt)} · `}
            seen {alert.triggerCount}×{staff && ` · ${alert.ruleId} v${alert.ruleVersion}`}
            {alert.escalationRequired && ' · flagged for the flight surgeon'}
          </p>
        </div>
        <Chevron className="mt-1 h-5 w-5 text-ink-muted" aria-hidden />
      </button>
      {open && <AlertBody id={alert.id} staff={staff} />}
    </div>
  )
}

function AlertBody({ id, staff }: { id: string; staff: boolean }) {
  const { data, error, isPending } = useAlert(id)
  const missionStart = useAuth((s) => s.user?.missionStart)
  const catalog = useCatalog().data ?? {}
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['alert', id] })
    void queryClient.invalidateQueries({ queryKey: ['alerts'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }
  const acknowledge = useMutation({
    mutationFn: () => unwrap(api.POST('/api/alerts/{alert_id}/acknowledge', { params: { path: { alert_id: id } } })),
    onSuccess: refresh,
  })
  const complete = useMutation({
    mutationFn: (taskId: string) => unwrap(api.POST('/api/tasks/{task_id}/complete', { params: { path: { task_id: taskId } } })),
    onSuccess: refresh,
  })

  if (isPending) return <div className="px-4 pb-4"><Loading /></div>
  if (error) return <div className="px-4 pb-4"><ErrorNote error={error} /></div>

  return (
    <div className="space-y-4 border-t border-line p-4">
      {data.emergencyProtocol && (
        <div className="rounded-lg border-2 border-status-red/70 bg-status-red/10 p-4">
          <p className="mb-2 flex items-center gap-2 font-semibold text-status-red">
            <ShieldAlert className="h-5 w-5" aria-hidden /> {data.emergencyProtocol.title}
          </p>
          <ProtocolSteps markdown={data.emergencyProtocol.body} />
          <p className="mt-3 text-xs text-ink-muted">{data.emergencyProtocol.disclaimer}</p>
        </div>
      )}

      <Explanation detail={data} catalog={catalog} staff={staff} />

      {(() => {
        const technical = (
          <>
            <details open={staff} className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium text-accent">Technical details (rule {data.ruleId} v{data.ruleVersion}, exact values)</summary>
              <div className="mt-3"><EvidenceTable detail={data} catalog={catalog} /></div>
            </details>
            {data.insights && data.insights.length > 0 && (
              <div className="mt-3">
                <h3 className="mb-2 text-xs font-semibold tracking-wider text-ink-muted uppercase">Supporting pattern from machine learning (never decides on its own)</h3>
                <InsightList insights={data.insights} missionStart={missionStart} />
                <p className="mt-2 text-xs text-ink-muted">{INSIGHT_NOTE}</p>
              </div>
            )}
          </>
        )
        // astronauts: the numbers and the machine-learning notes are one tap away; staff see them at once
        return staff ? technical : <MoreDetail label="More detail: the numbers and how it was decided"><div className="text-ink">{technical}</div></MoreDetail>
      })()}

      {data.recommendations.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wider text-ink-muted uppercase">What to do</h3>
          <ul className="space-y-1">
            {data.recommendations.map((t) => (
              <li key={t.id}>
                <button disabled={t.status !== 'Pending' || complete.isPending} onClick={() => complete.mutate(t.id)}
                  className="flex min-h-12 w-full items-start gap-3 rounded-lg p-2 text-left hover:bg-subtle/40 disabled:hover:bg-transparent">
                  {t.status === 'Pending' ? <Square className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden />
                    : <CheckSquare className="mt-0.5 h-5 w-5 shrink-0 text-status-green" aria-hidden />}
                  <span>
                    <span className={`block text-sm font-medium ${t.status !== 'Pending' ? 'text-ink-muted line-through' : ''}`}>{t.title}</span>
                    <span className="block text-xs text-ink-muted">{t.body}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-muted">
        <span>
          {data.acknowledgedBy && `Acknowledged by ${data.acknowledgedBy}. `}
          {data.reviewedBy && `Reviewed by ${data.reviewedBy}. `}
          {data.resolutionNote}
        </span>
        {!staff && data.status === 'Open' && (
          <Button onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>I've seen this — acknowledge</Button>
        )}
      </div>
      {acknowledge.isError && <ErrorNote error={acknowledge.error} />}
      {staff && <SurgeonActions alert={data} onDone={refresh} />}
      <p className="text-[11px] text-ink-muted">{data.disclaimer}</p>
    </div>
  )
}

// Rule leaves that read an ML insight instead of a measurement (LLD §10)
const ML_SOURCES: Record<string, { name: string; unit: string }> = {
  ml_anomaly: { name: 'AI anomaly score', unit: '' },
  ml_trend: { name: 'Recovery strain trend', unit: 'σ' },
}

function EvidenceTable({ detail, catalog }: { detail: AlertDetail; catalog: Record<string, Indicator> }) {
  const rows = Object.entries(detail.evidence) as [string, Record<string, number | string | boolean | null>][]
  return (
    <div className="overflow-x-auto">
      <h3 className="mb-2 text-xs font-semibold tracking-wider text-ink-muted uppercase">Evidence</h3>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-ink-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Reading</th>
            <th className="py-1 pr-3 font-medium">Value</th>
            <th className="py-1 pr-3 font-medium">Your normal</th>
            <th className="py-1 pr-3 font-medium">Difference</th>
            <th className="py-1 font-medium">Window</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map(([key, ev]) => {
            const ml = ML_SOURCES[String(ev.indicator)]
            const reported = ev.agg === 'reported' // red-flag symptom told to the AI assistant
            const meta = ml ? undefined : catalog[String(ev.indicator)]
            const dec = ml ? 2 : (meta?.decimals ?? 1)
            const isCount = String(ev.agg).startsWith('count')
            const unit = ml ? ml.unit : isCount ? 'readings' : meta?.unit === 'score' ? '/10' : (meta?.unit ?? '')
            const num = (v: unknown) => (typeof v === 'number' ? formatValue(v, Math.max(dec, 1)) : '—')
            return (
              <tr key={key} className="border-t border-line">
                <td className="py-1.5 pr-3 font-sans">
                  {reported ? `Symptom: ${String(ev.indicator).replace(/_/g, ' ')}` : (ml?.name ?? meta?.name ?? ev.indicator)}
                  <span className="block text-[11px] text-ink-muted">{ml ? 'machine learning' : String(ev.agg).replace('_', ' ')}</span>
                </td>
                <td className="py-1.5 pr-3">{reported ? 'reported' : ev.missing ? 'no data' : `${num(ev.value)} ${unit}`}</td>
                <td className="py-1.5 pr-3">{typeof ev.baseline === 'number' && !isCount ? `${num(ev.baseline)} ± ${num(ev.sigma)}` : '—'}</td>
                <td className="py-1.5 pr-3">
                  {typeof ev.z === 'number' ? `${ev.z > 0 ? '+' : ''}${ev.z.toFixed(1)}σ`
                    : typeof ev.ratio === 'number' ? `${ev.ratio.toFixed(1)}×` : '—'}
                </td>
                <td className="py-1.5">{String(ev.window)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

type Move = 'review' | 'resolve' | 'dismiss'
const MOVE_PATH = {
  review: '/api/alerts/{alert_id}/review',
  resolve: '/api/alerts/{alert_id}/resolve',
  dismiss: '/api/alerts/{alert_id}/dismiss',
} as const

/** Flight-surgeon review (Step 8): In Review → Resolved / Dismissed (note required), plus an instruction. */
function SurgeonActions({ alert, onDone }: { alert: AlertDetail; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [message, setMessage] = useState('')
  const queryClient = useQueryClient()
  const move = useMutation({
    mutationFn: (to: Move) =>
      unwrap(api.POST(MOVE_PATH[to], { params: { path: { alert_id: alert.id } }, body: { note: note.trim() || null } })),
    onSuccess: () => {
      setNote('')
      onDone()
      void queryClient.invalidateQueries({ queryKey: ['crew-summary'] })
    },
  })
  const send = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/instructions', { body: { astronautId: alert.astronautCode, alertId: alert.id, text: message.trim() } })),
    onSuccess: () => {
      setMessage('')
      void queryClient.invalidateQueries({ queryKey: ['instructions'] })
    },
  })
  const active = ['Open', 'Acknowledged', 'InReview'].includes(alert.status)
  if (!active) return null
  const canReview = alert.status === 'Open' || alert.status === 'Acknowledged'
  const canClose = alert.status === 'InReview'
  return (
    <div className="space-y-3 rounded-lg border border-accent/40 bg-canvas/60 p-3">
      <p className="text-xs font-semibold tracking-wider text-accent uppercase">Flight surgeon review</p>
      <label className="block text-sm">
        <span className="text-xs text-ink-muted">Note {canClose ? '(required to resolve or dismiss)' : '(optional)'}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000}
          className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
      </label>
      <div className="flex flex-wrap gap-2">
        {canReview && <Button onClick={() => move.mutate('review')} disabled={move.isPending}>Start review</Button>}
        {canClose && <Button onClick={() => move.mutate('resolve')} disabled={move.isPending || !note.trim()}>Resolve</Button>}
        {(canClose || alert.status === 'Open') && (
          <Button variant="ghost" onClick={() => move.mutate('dismiss')} disabled={move.isPending || !note.trim()}>Dismiss as false alarm</Button>
        )}
      </div>
      {move.isError && <ErrorNote error={move.error} />}
      <form onSubmit={(e) => { e.preventDefault(); if (message.trim().length >= 3) send.mutate() }} className="space-y-2 border-t border-line pt-3">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Send an instruction to {alert.astronautCode} about this alert (shown to them live)</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} maxLength={2000}
            placeholder="e.g. Rest today, skip the resistance session, recheck resting HR at wake-up."
            className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
        </label>
        <Button type="submit" variant="ghost" disabled={send.isPending || message.trim().length < 3}>Send instruction</Button>
        {send.isSuccess && <span className="ml-2 text-xs text-status-green">Sent and delivered.</span>}
        {send.isError && <ErrorNote error={send.error} />}
      </form>
    </div>
  )
}

/** NORMAL / ATTENTION / URGENT explained once, with icon + word + colour. */
function LevelsLegend() {
  const levels = [
    { icon: CheckCircle2, cls: 'text-status-green', name: 'Normal', text: 'All good.' },
    { icon: TriangleAlert, cls: 'text-status-yellow', name: 'Attention', text: 'Take care: do the steps, no emergency.' },
    { icon: AlertOctagon, cls: 'text-status-red', name: 'Urgent', text: 'Get help now: emergency steps.' },
  ]
  return (
    <ul className="grid gap-2 sm:grid-cols-3" aria-label="Alert levels">
      {levels.map((l) => (
        <li key={l.name} className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3 text-sm">
          <l.icon className={`mt-0.5 h-5 w-5 shrink-0 ${l.cls}`} aria-hidden />
          <span><span className={`font-semibold ${l.cls}`}>{l.name.toUpperCase()}</span><span className="block text-xs text-ink-muted">{l.text}</span></span>
        </li>
      ))}
    </ul>
  )
}

/** Every alert in plain words: what happened, the measurement vs normal, why it matters, what to do, medical help. */
function Explanation({ detail, catalog, staff }: { detail: AlertDetail; catalog: Record<string, Indicator>; staff: boolean }) {
  const lines = evidenceLines(detail, catalog)
  const main = mainIndicator(detail)
  const info = main ? infoFor(main) : undefined
  const urgent = detail.severity === 'Urgent'
  const measurement = lines.length ? (
    <ul className="space-y-0.5">{lines.map((l, i) => <li key={i}><span className="font-medium">{l.label}:</span> {l.text}</li>)}</ul>
  ) : '—'
  const rows: [string, React.ReactNode][] = [
    ['What happened', detail.reason],
    ['Measurement', measurement],
    ...(info ? [['Why it matters', info.why] as [string, React.ReactNode]] : []),
    ['What to do', urgent ? 'Follow the emergency procedure above, then the steps below.' : detail.recommendations.some((t) => t.status === 'Pending') ? 'Do the recommended actions below, then repeat the measurement in your next check-in.' : 'Keep doing your daily check-in so any change is noticed early.'],
    ['Medical help', urgent ? 'Needed now: call the crew medical officer. The flight surgeon has been alerted.' : detail.escalationRequired ? 'The flight surgeon has been notified because this keeps happening and will review it.' : (info?.help ?? 'Not needed unless it gets worse or you feel unwell.')],
  ]
  // astronauts see three things first: what happened, what to do, medical help; the rest is folded
  const shown = staff ? rows : rows.filter(([k]) => k !== 'Measurement' && k !== 'Why it matters')
  const folded = staff ? [] : rows.filter(([k]) => k === 'Measurement' || k === 'Why it matters')
  return (
    <>
    <dl className="grid gap-3 sm:grid-cols-[9rem_1fr]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-xs font-semibold tracking-wide text-ink-muted uppercase sm:pt-0.5">{k}</dt>
          <dd className="text-sm">{v}</dd>
        </div>
      ))}
    </dl>
    {folded.length > 0 && (
      <MoreDetail label="The measurement and why it matters">
        <dl className="space-y-2 text-ink">
          {folded.map(([k, v]) => <div key={k}><dt className="font-semibold">{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </MoreDetail>
    )}
    </>
  )
}
