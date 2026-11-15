import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, CheckCheck, ChevronRight, Clock, FileText, MessageSquareText, Satellite } from 'lucide-react'
import { lazy, Suspense, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { StatusBadge } from '../../components/ui/Status'
import { api, unwrap, type CrewStatus } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { timeAgo } from '../../lib/mission'
import { useCrewSummary, useDashboard, useInstructions, useSyncStatus } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { AlertsPage } from '../alerts/AlertsPage'
import { OverviewPage } from '../overview/OverviewPage'
import { ExerciseSessionsPanel } from '../exercise/SessionList'
import { ReportsPage } from '../reports/ReportsPage'
import { SpaceWeatherCard } from '../../components/ui/SpaceWeatherCard'

const BodyExplorerPage = lazy(() => import('../body/BodyExplorerPage').then((m) => ({ default: m.BodyExplorerPage })))
const HistoryPage = lazy(() => import('../history/HistoryPage').then((m) => ({ default: m.HistoryPage })))
const AnalyticsPage = lazy(() => import('../analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })))

/** Crew overview for the flight surgeon: communication status, follow-ups, then every astronaut (table or cards). */
export function CrewPage() {
  const role = useAuth((s) => s.user?.role)
  const { data, error, isPending } = useCrewSummary()
  const medical = role === 'FlightSurgeon'
  const [layout, setLayout] = useState<'table' | 'cards'>(medical ? 'table' : 'cards')
  const now = useNow()
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Crew overview</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {medical
            ? 'Live health status of every crew member. Open an astronaut to review alerts, trends, history and reports, and to send instructions.'
            : 'Crew status only. Health details are visible to the flight surgeon.'}
        </p>
      </header>
      <CommsStatus />
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {medical && data && <FollowUps crew={data} now={now} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Astronauts</h2>
        <div className="flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="Layout">
          {(['table', 'cards'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={layout === l} onClick={() => setLayout(l)}
              className={`min-h-9 rounded-md px-3 text-sm ${layout === l ? 'bg-accent text-on-accent' : 'text-ink hover:bg-subtle'}`}>
              {l === 'table' ? 'Table' : 'Cards'}
            </button>
          ))}
        </div>
      </div>
      {data && layout === 'table' && <CrewTable crew={data} medical={medical} />}
      {layout === 'cards' && (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data?.map((c) => <CrewCard key={c.code} crew={c} medical={medical} />)}
        </ul>
      )}
      <SpaceWeatherCard />
    </div>
  )
}

/** Earth link, light-time delay and what is still queued: the surgeon is always looking at a delayed copy. */
function CommsStatus() {
  const sync = useSyncStatus(true)
  const s = sync.data
  if (!s?.link) return null
  const link = s.link
  const up = link.status === 'Up'
  return (
    <section aria-label="Communication status" className={`grid gap-3 rounded-xl border bg-surface p-4 sm:grid-cols-4 ${up ? 'border-line' : 'border-status-red/60'}`}>
      <div>
        <p className="text-xs text-ink-muted">Earth–habitat link</p>
        <p className={`flex items-center gap-1.5 font-semibold ${up ? 'text-status-green' : 'text-status-red'}`}>
          <Satellite className="h-4 w-4" aria-hidden /> {up ? 'Up' : 'Down'}
        </p>
      </div>
      <div>
        <p className="text-xs text-ink-muted">One-way delay</p>
        <p className="font-semibold">{link.realDelayMinutes.toFixed(1)} light-minutes</p>
      </div>
      <div>
        <p className="text-xs text-ink-muted">Waiting to be sent from this node</p>
        <p className="font-semibold">{s.pending + s.inFlight} item(s)</p>
      </div>
      <div>
        <p className="text-xs text-ink-muted">Last data received</p>
        <p className="font-semibold">{s.lastReceivedAt ? timeAgo(s.lastReceivedAt) : 'not yet'}</p>
      </div>
    </section>
  )
}

/** Medical follow-up actions derived from the crew summary. */
function FollowUps({ crew, now }: { crew: CrewStatus[]; now: number }) {
  const items: { code: string; text: string; urgent?: boolean; view?: string }[] = []
  for (const c of crew) {
    if (c.urgentAlerts > 0) items.push({ code: c.code, urgent: true, view: 'alerts', text: `${c.displayName}: ${c.urgentAlerts} urgent alert(s)${c.topAlert ? ` — ${c.topAlert}` : ''}` })
    if (c.alertsAwaitingReview) items.push({ code: c.code, view: 'alerts', text: `${c.displayName}: ${c.alertsAwaitingReview} alert(s) awaiting your review` })
    if (c.unacknowledgedInstructions) items.push({ code: c.code, view: 'instructions', text: `${c.displayName}: ${c.unacknowledgedInstructions} instruction(s) not yet acknowledged` })
    if (!c.lastReadingAt || now - Date.parse(c.lastReadingAt) > 48 * 3_600_000) {
      items.push({ code: c.code, text: `${c.displayName}: no new data for ${c.lastReadingAt ? timeAgo(c.lastReadingAt) : 'the whole mission'}` })
    }
  }
  return (
    <section aria-labelledby="fu-h" className="rounded-xl border border-line bg-surface p-4">
      <h2 id="fu-h" className="text-lg font-semibold">Follow-up needed</h2>
      {items.length === 0 ? (
        <p className="mt-1 flex items-center gap-2 text-sm"><CheckCheck className="h-4 w-4 text-status-green" aria-hidden />Nothing waiting for you.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {items.map((i, n) => (
            <li key={n}>
              <Link to={`/staff/astronaut/${i.code}${i.view ? `?view=${i.view}` : ''}`} className="flex min-h-11 items-center gap-2 py-2 text-sm hover:underline">
                {i.urgent ? <AlertOctagon className="h-4 w-4 shrink-0 text-status-red" aria-label="Urgent" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />}
                <span className={i.urgent ? 'font-semibold text-status-red' : ''}>{i.text}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CrewTable({ crew, medical }: { crew: CrewStatus[]; medical: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[48rem] text-left text-sm">
        <caption className="sr-only">Crew health status</caption>
        <thead className="bg-canvas text-xs text-ink-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Astronaut</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 font-medium">Alerts</th>
            {medical && <th scope="col" className="px-3 py-2 font-medium">Top finding</th>}
            {medical && <th scope="col" className="px-3 py-2 font-medium">To review</th>}
            {medical && <th scope="col" className="px-3 py-2 font-medium">Wellness</th>}
            <th scope="col" className="px-3 py-2 font-medium">Data as of</th>
            {medical && <th scope="col" className="px-3 py-2 font-medium">Latest report</th>}
          </tr>
        </thead>
        <tbody>
          {crew.map((c) => (
            <tr key={c.code} className="border-t border-line align-top">
              <th scope="row" className="px-3 py-2 font-medium">
                {medical ? <Link to={`/staff/astronaut/${c.code}`} className="text-accent hover:underline">{c.displayName}</Link> : c.displayName}
                <span className="block text-xs font-normal text-ink-muted">{c.code} · {c.roleTitle}</span>
              </th>
              <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
              <td className="px-3 py-2">{c.urgentAlerts > 0 && <span className="font-semibold text-status-red">{c.urgentAlerts} urgent · </span>}{c.attentionAlerts} attention</td>
              {medical && <td className="px-3 py-2 text-xs">{c.topAlert ?? '—'}</td>}
              {medical && (
                <td className="px-3 py-2">
                  {c.alertsAwaitingReview ?? 0}
                  {c.unacknowledgedInstructions ? <span className="block text-xs text-ink-muted">{c.unacknowledgedInstructions} instruction(s) unacknowledged</span> : null}
                </td>
              )}
              {medical && <td className="px-3 py-2">{c.wellnessIndex ?? '—'}</td>}
              <td className="px-3 py-2 text-xs">{c.lastReadingAt ? timeAgo(c.lastReadingAt) : 'no data'}</td>
              {medical && (
                <td className="px-3 py-2 text-xs">
                  {c.latestReport
                    ? `${c.latestReport.type === 'AlertTriggered' ? 'Alert' : c.latestReport.type === 'OnDemand' ? 'On demand' : c.latestReport.type} · ${timeAgo(c.latestReport.generatedAt)}`
                    : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CrewCard({ crew, medical }: { crew: CrewStatus; medical: boolean }) {
  const ring = crew.status === 'RED' ? 'border-status-red/70' : crew.status === 'YELLOW' ? 'border-status-yellow/60' : 'border-line'
  const body = (
    <section className={`h-full rounded-xl border-2 bg-surface p-4 ${ring}`}>
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
        <div className="mt-3 space-y-1 border-t border-line pt-3 text-xs">
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
  { id: 'history', label: 'Health history' },
  { id: 'reports', label: 'Reports' },
  { id: 'exercise', label: 'Exercise' },
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
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/staff" className="text-xs text-accent">← Crew</Link>
          <h1 className="text-2xl font-semibold">{dash.data?.displayName ?? code}</h1>
          <p className="text-sm text-ink-muted">{code}{dash.data?.missionDay != null && ` · mission day ${dash.data.missionDay}`}</p>
        </div>
        {dash.data && <StatusBadge status={dash.data.status} large />}
      </div>
      <div className="no-print flex flex-wrap gap-1 border-b border-line" role="group" aria-label="Sections">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)}
            className={`-mb-px min-h-11 border-b-2 px-4 text-sm font-medium ${view === v.id ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink'}`}>
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
      {view === 'history' && <Suspense fallback={<Loading />}><HistoryPage code={code} staff /></Suspense>}
      {view === 'reports' && <ReportsPage code={code} embedded />}
      {view === 'exercise' && <ExerciseSessionsPanel code={code} />}
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
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
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
            <li key={i.id} className="rounded-lg border border-line p-3 text-sm">
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
