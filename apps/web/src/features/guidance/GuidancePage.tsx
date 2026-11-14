import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpen, CheckCircle2, CircleDashed, Search, Stethoscope } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorNote, LinkButton, Loading } from '../../components/ui/Panel'
import { SeverityBadge } from '../../components/ui/Status'
import { api, unwrap, type GuidanceItem, type LibraryItem } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useGuidance } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { CHECKIN_TASK } from '../../app/sections'

/** Recommendation categories (protocols/recommendations.json) grouped into the areas astronauts think in. */
const AREAS: { id: string; label: string; categories: string[]; why: string }[] = [
  { id: 'heart', label: 'Heart and circulation', categories: ['Cardiovascular'], why: 'Reduced gravity changes how the heart and blood vessels work; early changes are easier to correct.' },
  { id: 'bones', label: 'Bones and muscles', categories: ['Exercise'], why: 'Without gravity, bones and muscles weaken quickly; daily exercise is the main protection.' },
  { id: 'sleep', label: 'Sleep', categories: ['Sleep'], why: 'Short or broken sleep lowers alertness, mood and performance in critical tasks.' },
  { id: 'mind', label: 'Mental wellness', categories: ['Behavioral'], why: 'Isolation, confinement and workload affect mood and stress; small steps help early.' },
  { id: 'nutrition', label: 'Nutrition and hydration', categories: ['Hydration'], why: 'Thirst is weaker in space; enough water and food protect the kidneys, energy and recovery.' },
  { id: 'radiation', label: 'Radiation exposure', categories: ['Radiation'], why: 'Radiation adds up over the mission; shielding during solar storms keeps your dose low.' },
  { id: 'general', label: 'General health', categories: ['Thermal', 'General'], why: 'Temperature, infection and everyday health checks.' },
]
const areaOf = (category: string) => AREAS.find((a) => a.categories.includes(category)) ?? AREAS[AREAS.length - 1]

type Filter = 'todo' | 'done' | 'all'

export function GuidancePage() {
  const code = useAuth((s) => s.user?.astronautCode)
  const { data, error, isPending } = useGuidance(code)
  const [filter, setFilter] = useState<Filter>('todo')
  const [area, setArea] = useState<string>('all')
  const [query, setQuery] = useState('')
  const now = useNow()

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.items ?? []).filter((i) =>
      (filter === 'all' || (filter === 'todo' ? i.status === 'Pending' : i.status !== 'Pending')) &&
      (area === 'all' || areaOf(i.category).id === area) &&
      (!q || `${i.title} ${i.body} ${i.alert?.title ?? ''}`.toLowerCase().includes(q)),
    )
  }, [data, filter, area, query])

  if (isPending) return <Loading />
  if (error) return <ErrorNote error={error} />
  const pending = data.items.filter((i) => i.status === 'Pending')
  const review = pending.filter((i) => i.medicalReview)

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Summary">
        <Stat label="Actions to do" value={pending.length} />
        <Stat label="Need medical review" value={review.length} tone={review.length ? 'warn' : undefined} />
        <Stat label="Done in the last 7 days" value={data.items.length - pending.length} />
      </section>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 lg:flex-row lg:items-center">
        <div role="group" aria-label="Show" className="flex gap-1">
          {(['todo', 'done', 'all'] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className={`min-h-10 rounded-lg px-3 text-sm font-medium ${filter === f ? 'bg-accent text-white' : 'text-ink hover:bg-subtle'}`}>
              {{ todo: 'To do', done: 'Done', all: 'All' }[f]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">Area</span>
          <select value={area} onChange={(e) => setArea(e.target.value)}
            className="min-h-10 rounded-lg border border-line-strong bg-surface px-2 text-sm">
            <option value="all">All areas</option>
            {AREAS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label className="relative flex-1">
          <span className="sr-only">Search recommendations</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, e.g. sleep, water, heart"
            className="min-h-10 w-full rounded-lg border border-line-strong bg-surface pr-3 pl-9 text-sm" />
        </label>
      </div>

      {items.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <CheckCircle2 className="h-5 w-5 text-status-green" aria-hidden />
          {filter === 'todo' && area === 'all' && !query ? 'Nothing to do right now. New recommendations appear here when a measurement needs attention.' : 'No recommendations match.'}
        </p>
      ) : (
        AREAS.filter((a) => items.some((i) => areaOf(i.category).id === a.id)).map((a) => (
          <section key={a.id} aria-labelledby={`area-${a.id}`} className="space-y-3">
            <div>
              <h2 id={`area-${a.id}`} className="text-lg font-semibold">{a.label}</h2>
              <p className="text-sm text-ink-muted">{a.why}</p>
            </div>
            <ul className="space-y-3">
              {items.filter((i) => areaOf(i.category).id === a.id).map((i) => <GuidanceCard key={i.id} item={i} code={code!} now={now} />)}
            </ul>
          </section>
        ))
      )}

      <Library items={data.library} />
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className={`rounded-xl border bg-surface p-4 ${tone ? 'border-status-yellow/60' : 'border-line'}`}>
      <p className="text-sm text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone ? 'text-status-yellow' : ''}`}>{value}</p>
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = { Pending: 'To do', Done: 'Done', Skipped: 'Skipped', Closed: 'Closed — alert resolved' }

function GuidanceCard({ item, code, now }: { item: GuidanceItem; code: string; now: number }) {
  const queryClient = useQueryClient()
  const complete = useMutation({
    mutationFn: () => unwrap(api.POST('/api/tasks/{task_id}/complete', { params: { path: { task_id: item.id } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guidance', code] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard', code] })
    },
  })
  const pending = item.status === 'Pending'
  const due = item.dueAt ? new Date(item.dueAt) : null
  const overdue = pending && due != null && due.getTime() < now
  return (
    <li className={`rounded-xl border bg-surface p-4 ${pending ? 'border-line' : 'border-line opacity-80'}`}>
      <div className="flex flex-wrap items-start gap-3">
        {pending ? <CircleDashed className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-green" aria-hidden />}
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="text-xs text-ink-muted">{STATUS_LABEL[item.status] ?? item.status}{item.completedAt && ` · ${new Date(item.completedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}</p>
        </div>
        {item.alert && <SeverityBadge severity={item.alert.severity} />}
      </div>
      <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold tracking-wide text-ink-muted uppercase">What needs attention</dt>
          <dd className="mt-0.5">
            {item.alert ? (
              <>
                <Link to={`/astronaut/guidance/alerts?id=${item.alert.id}`} className="font-medium text-accent hover:underline">{item.alert.title}</Link>
                <span className="block text-ink-muted">{item.alert.reason}</span>
              </>
            ) : 'Routine care from your daily plan.'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Recommended action</dt>
          <dd className="mt-0.5">{item.body}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold tracking-wide text-ink-muted uppercase">When</dt>
          <dd className="mt-0.5">
            {due ? `${overdue ? 'Overdue — was due' : 'By'} ${due.toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' })}` : 'When convenient'}
            {item.priority === 1 && ' · do this first'}
            {item.alert && pending && <span className="block text-ink-muted">Then repeat the measurement in your next daily check-in to see if it has improved.</span>}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Medical review</dt>
          <dd className="mt-0.5 flex items-start gap-1.5">
            <Stethoscope className={`mt-0.5 h-4 w-4 shrink-0 ${item.medicalReview ? 'text-status-yellow' : 'text-ink-muted'}`} aria-hidden />
            {item.medicalReview
              ? 'Needed — the flight surgeon has been notified and will review.'
              : 'Not needed unless it gets worse or you feel unwell.'}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p className="text-xs text-ink-muted">Source: {item.source}</p>
        {pending && item.code === CHECKIN_TASK && <LinkButton to="/astronaut/checkin">Start check-in</LinkButton>}
        {pending && item.code !== CHECKIN_TASK && (
          <button type="button" onClick={() => complete.mutate()} disabled={complete.isPending}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-60">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Mark as done
          </button>
        )}
      </div>
      {complete.isError && <ErrorNote error={complete.error} />}
    </li>
  )
}

function Library({ items }: { items: LibraryItem[] }) {
  return (
    <details className="rounded-xl border border-line bg-surface">
      <summary className="flex min-h-14 cursor-pointer items-center gap-2 px-4 font-semibold">
        <BookOpen className="h-5 w-5 text-accent" aria-hidden /> All approved guidance ({items.length})
      </summary>
      <div className="space-y-4 border-t border-line p-4">
        <p className="text-xs text-ink-muted">
          Every recommendation the system can give, from the mission’s protocol library. Recommendations above are the ones
          that apply to you now.
        </p>
        {AREAS.map((a) => {
          const rows = items.filter((i) => areaOf(i.category).id === a.id)
          if (rows.length === 0) return null
          return (
            <div key={a.id}>
              <h3 className="text-sm font-semibold">{a.label}</h3>
              <ul className="mt-1 space-y-2">
                {rows.map((r) => (
                  <li key={r.code} className="text-sm">
                    <span className="font-medium">{r.title}.</span> <span className="text-ink-muted">{r.body}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </details>
  )
}
