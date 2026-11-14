import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckSquare, ChevronDown, ChevronRight, ShieldAlert, Square } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Button, ErrorNote, Loading, Panel, ProtocolSteps } from '../../components/ui/Panel'
import { AlertStatusChip, SeverityBadge } from '../../components/ui/Status'
import { api, unwrap, type AlertDetail, type AlertSummary, type Indicator } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { dayOf, formatValue } from '../../lib/mission'
import { useAlert, useAlerts, useCatalog } from '../../lib/queries'

export function AlertsPage() {
  const user = useAuth((s) => s.user)
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'history' ? 'all' : 'active'
  const openId = params.get('id')
  const { data, error, isPending } = useAlerts(user?.astronautCode, tab)

  const setTab = (t: 'active' | 'all') => setParams(t === 'all' ? { tab: 'history' } : {})
  const toggle = (id: string) => {
    const next = new URLSearchParams(params)
    if (openId === id) next.delete('id')
    else next.set('id', id)
    setParams(next)
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <p className="font-mono text-sm text-accent">06</p>
        <h1 className="text-2xl font-semibold">Alerts Center</h1>
        <p className="mt-1 text-sm text-ink-muted">Each alert shows exactly which readings triggered it, compared with your own normal.</p>
      </div>
      <div className="flex gap-2" role="tablist">
        {(['active', 'all'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`min-h-10 rounded-lg px-4 text-sm ${tab === t ? 'bg-space-700 text-ink' : 'text-ink-muted hover:bg-space-800'}`}>
            {t === 'active' ? 'Active' : 'History'}
          </button>
        ))}
      </div>
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && data.length === 0 && (
        <Panel><p className="text-sm text-ink-muted">{tab === 'active' ? 'No active alerts. All clear.' : 'No alerts yet.'}</p></Panel>
      )}
      <ul className="space-y-3">
        {data?.map((a) => (
          <li key={a.id}>
            <AlertCard alert={a} open={openId === a.id} onToggle={() => toggle(a.id)} missionStart={user?.missionStart} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function AlertCard({ alert, open, onToggle, missionStart }: {
  alert: AlertSummary
  open: boolean
  onToggle: () => void
  missionStart?: string | null
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  const urgent = alert.severity === 'Urgent'
  return (
    <div className={`rounded-xl border bg-space-800 ${urgent && open ? 'border-status-red/60' : 'border-space-700'}`}>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 p-4 text-left">
        <SeverityBadge severity={alert.severity} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {alert.title} <AlertStatusChip status={alert.status} />
          </p>
          <p className="mt-1 text-sm text-ink-muted">{alert.reason}</p>
          <p className="mt-1 text-xs text-ink-muted">
            {missionStart && `Day ${dayOf(missionStart, alert.firstTriggeredAt)}–${dayOf(missionStart, alert.lastTriggeredAt)} · `}
            seen {alert.triggerCount}× · {alert.ruleId} v{alert.ruleVersion}
            {alert.escalationRequired && ' · flagged for the flight surgeon'}
          </p>
        </div>
        <Chevron className="mt-1 h-5 w-5 text-ink-muted" aria-hidden />
      </button>
      {open && <AlertBody id={alert.id} />}
    </div>
  )
}

function AlertBody({ id }: { id: string }) {
  const { data, error, isPending } = useAlert(id)
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
    <div className="space-y-4 border-t border-space-700 p-4">
      {data.emergencyProtocol && (
        <div className="rounded-lg border-2 border-status-red/70 bg-status-red/10 p-4">
          <p className="mb-2 flex items-center gap-2 font-semibold text-status-red">
            <ShieldAlert className="h-5 w-5" aria-hidden /> {data.emergencyProtocol.title}
          </p>
          <ProtocolSteps markdown={data.emergencyProtocol.body} />
          <p className="mt-3 text-xs text-ink-muted">{data.emergencyProtocol.disclaimer}</p>
        </div>
      )}

      <EvidenceTable detail={data} catalog={catalog} />

      {data.recommendations.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wider text-ink-muted uppercase">What to do</h3>
          <ul className="space-y-1">
            {data.recommendations.map((t) => (
              <li key={t.id}>
                <button disabled={t.status !== 'Pending' || complete.isPending} onClick={() => complete.mutate(t.id)}
                  className="flex min-h-12 w-full items-start gap-3 rounded-lg p-2 text-left hover:bg-space-700/40 disabled:hover:bg-transparent">
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
        {data.status === 'Open' && (
          <Button onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>I've seen this — acknowledge</Button>
        )}
      </div>
      {acknowledge.isError && <ErrorNote error={acknowledge.error} />}
      <p className="text-[11px] text-ink-muted">{data.disclaimer}</p>
    </div>
  )
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
            const meta = catalog[String(ev.indicator)]
            const dec = meta?.decimals ?? 1
            const isCount = String(ev.agg).startsWith('count')
            const unit = isCount ? 'readings' : meta?.unit === 'score' ? '/10' : (meta?.unit ?? '')
            const num = (v: unknown) => (typeof v === 'number' ? formatValue(v, Math.max(dec, 1)) : '—')
            return (
              <tr key={key} className="border-t border-space-700">
                <td className="py-1.5 pr-3 font-sans">
                  {meta?.name ?? ev.indicator}
                  <span className="block text-[11px] text-ink-muted">{String(ev.agg).replace('_', ' ')}</span>
                </td>
                <td className="py-1.5 pr-3">{ev.missing ? 'no data' : `${num(ev.value)} ${unit}`}</td>
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
