import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, CheckCheck, ChevronRight, Clock, FileText, MessageSquareText } from 'lucide-react'
import { lazy, Suspense, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { StatusBadge } from '../../components/ui/Status'
import { api, unwrap, type CrewStatus } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { timeAgo } from '../../lib/mission'
import { useCrewSummary, useDashboard, useInstructions } from '../../lib/queries'
import { AlertsPage } from '../alerts/AlertsPage'
import { OverviewPage } from '../overview/OverviewPage'
import { ReportsPage } from '../reports/ReportsPage'
import { SpaceWeatherCard } from '../../components/ui/SpaceWeatherCard'

const BodyExplorerPage = lazy(() => import('../body/BodyExplorerPage').then((m) => ({ default: m.BodyExplorerPage })))
const AnalyticsPage = lazy(() => import('../analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })))

/** Crew grid (Step 8): live status of every astronaut. Mission control sees status only (LLD §17). */
export function CrewPage() {
  const role = useAuth((s) => s.user?.role)
  const { data, error, isPending } = useCrewSummary()
  const medical = role === 'FlightSurgeon'
  return (
    <div className="max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Crew</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {medical
            ? 'Live health status of every crew member. Open an astronaut to review alerts, trends and reports, and to send instructions.'
            : 'Crew status only. Health details are visible to the flight surgeon.'}
        </p>
      </div>
      <SpaceWeatherCard />
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((c) => <CrewCard key={c.code} crew={c} medical={medical} />)}
      </ul>
    </div>
  )
}

function CrewCard({ crew, medical }: { crew: CrewStatus; medical: boolean }) {
  const ring = crew.status === 'RED' ? 'border-status-red/70' : crew.status === 'YELLOW' ? 'border-status-yellow/60' : 'border-space-700'
  const body = (
    <section className={`h-full rounded-xl border-2 bg-space-800 p-4 ${ring}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{crew.displayName}</p>
          <p className="text-xs text-ink-muted">{crew.code} · {crew.roleTitle}</p>
        </div>
        <StatusBadge status={crew.status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-ink-muted">Alerts</dt>
          <dd className="font-mono">{crew.urgentAlerts > 0 && <span className="text-status-red">{crew.urgentAlerts} urgent · </span>}{crew.attentionAlerts} attention</dd></div>
        {medical && <div><dt className="text-xs text-ink-muted">Wellness index</dt><dd className="font-mono">{crew.wellnessIndex ?? '—'}</dd></div>}
        <div className="col-span-2"><dt className="text-xs text-ink-muted">Data as of</dt>
          <dd className="flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-ink-muted" aria-hidden />{crew.lastReadingAt ? timeAgo(crew.lastReadingAt) : 'no data'}</dd></div>
      </dl>
      {medical && (
        <div className="mt-3 space-y-1 border-t border-space-700 pt-3 text-xs">
          {crew.topAlert && <p className="flex items-center gap-1"><AlertOctagon className="h-3.5 w-3.5 text-status-yellow" aria-hidden /> {crew.topAlert}</p>}
          {!!crew.alertsAwaitingReview && <p className="text-accent">{crew.alertsAwaitingReview} alert(s) awaiting your review</p>}
          {!!crew.unacknowledgedInstructions && <p className="text-ink-muted">{crew.unacknowledgedInstructions} instruction(s) not yet acknowledged</p>}
          {crew.latestReport && (
            <p className="flex items-center gap-1 text-ink-muted"><FileText className="h-3.5 w-3.5" aria-hidden />
              Latest report: {crew.latestReport.type === 'OnDemand' ? 'on demand' : crew.latestReport.type === 'AlertTriggered' ? 'alert' : crew.latestReport.type.toLowerCase()} · {timeAgo(crew.latestReport.generatedAt)}</p>
          )}
        </div>
      )}
      {medical && <p className="mt-3 flex items-center justify-end gap-1 text-xs text-accent">Open <ChevronRight className="h-4 w-4" aria-hidden /></p>}
    </section>
  )
  return <li>{medical ? <Link to={`/staff/astronaut/${crew.code}`} className="block h-full">{body}</Link> : body}</li>
}

const VIEWS = [
  { id: 'summary', label: 'Summary' },
  { id: 'body', label: 'Body' },
  { id: 'alerts', label: 'Alerts review' },
  { id: 'trends', label: 'Trends' },
  { id: 'reports', label: 'Reports' },
  { id: 'instructions', label: 'Instructions' },
] as const
type View = (typeof VIEWS)[number]['id']

/** One astronaut, for the flight surgeon (Step 8). */
export function StaffAstronautPage() {
  const { code = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const view = (VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'summary') as View
  const dash = useDashboard(code)
  const setView = (v: View) => setParams(v === 'summary' ? {} : { view: v })
  return (
    <div className="max-w-6xl space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/staff" className="text-xs text-accent">← Crew</Link>
          <h1 className="text-2xl font-semibold">{dash.data?.displayName ?? code}</h1>
          <p className="text-sm text-ink-muted">{code}{dash.data?.missionDay != null && ` · mission day ${dash.data.missionDay}`}</p>
        </div>
        {dash.data && <StatusBadge status={dash.data.status} large />}
      </div>
      <div className="no-print flex flex-wrap gap-1 border-b border-space-700" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}
            className={`min-h-10 rounded-t-lg px-4 text-sm ${view === v.id ? 'bg-space-700 text-ink' : 'text-ink-muted hover:bg-space-800'}`}>
            {v.label}
          </button>
        ))}
      </div>
      {view === 'summary' && <OverviewPage code={code} readOnly />}
      {view === 'body' && <Suspense fallback={<Loading />}><BodyExplorerPage code={code} staff /></Suspense>}
      {view === 'alerts' && <AlertsPage code={code} staff />}
      {view === 'trends' && (
        <Suspense fallback={<Loading />}><AnalyticsPage code={code} embedded /></Suspense>
      )}
      {view === 'reports' && <ReportsPage code={code} embedded />}
      {view === 'instructions' && <InstructionsPanel code={code} />}
    </div>
  )
}

function InstructionsPanel({ code }: { code: string }) {
  const { data, error, isPending } = useInstructions(code)
  const [text, setText] = useState('')
  const queryClient = useQueryClient()
  const send = useMutation({
    mutationFn: () => unwrap(api.POST('/api/instructions', { body: { astronautId: code, text: text.trim() } })),
    onSuccess: () => {
      setText('')
      void queryClient.invalidateQueries({ queryKey: ['instructions', code] })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (text.trim().length >= 3) send.mutate()
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Send an instruction">
        <form onSubmit={submit} className="space-y-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000}
            placeholder="e.g. Please rest today, skip the resistance session and recheck resting heart rate at wake-up."
            className="w-full rounded-lg border border-space-600 bg-space-900 px-3 py-2 text-sm outline-none focus:border-accent" />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={send.isPending || text.trim().length < 3}>
              <MessageSquareText className="h-4 w-4" aria-hidden /> Send to {code}
            </Button>
            <span className="text-xs text-ink-muted">Shown to the astronaut live; they acknowledge it.</span>
          </div>
          {send.isError && <ErrorNote error={send.error} />}
        </form>
      </Panel>
      <Panel title="Sent">
        {isPending && <Loading />}
        {error && <ErrorNote error={error} />}
        {data?.length === 0 && <p className="text-sm text-ink-muted">No instructions yet.</p>}
        <ul className="space-y-3">
          {data?.map((i) => (
            <li key={i.id} className="rounded-lg border border-space-700 p-3 text-sm">
              <p>{i.text}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                {i.fromName} · {timeAgo(i.createdAt)} ·
                {i.acknowledgedAt
                  ? <span className="inline-flex items-center gap-1 text-status-green"><CheckCheck className="h-3.5 w-3.5" aria-hidden /> acknowledged {timeAgo(i.acknowledgedAt)}</span>
                  : i.deliveredAt ? <span>delivered, not yet acknowledged</span> : <span>queued</span>}
              </p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
