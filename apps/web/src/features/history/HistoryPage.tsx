import {
  Activity, BellRing, Camera, CheckCircle2, ClipboardCheck, FileText, ListChecks, MessageSquareText, Search, Sparkles, Stethoscope,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PhotoImage } from '../../components/health/PhotoImage'
import { ErrorNote, Loading } from '../../components/ui/Panel'
import { MoreDetail } from '../../components/ui/Simple'
import { SeverityBadge } from '../../components/ui/Status'
import type { TimelineEvent } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { missionDay } from '../../lib/mission'
import { useTimeline } from '../../lib/queries'
import { useNow } from '../../lib/useNow'

type Kind = TimelineEvent['kind']

const KIND: Record<Kind, { icon: LucideIcon; label: string; group: Group }> = {
  Readings: { icon: Activity, label: 'Measurements', group: 'measurements' },
  Checkin: { icon: ClipboardCheck, label: 'Check-in', group: 'checkins' },
  Symptom: { icon: Stethoscope, label: 'Symptom', group: 'checkins' },
  Alert: { icon: BellRing, label: 'Alert', group: 'alerts' },
  AlertClosed: { icon: CheckCircle2, label: 'Alert closed', group: 'alerts' },
  Recommendation: { icon: ListChecks, label: 'Recommendation', group: 'guidance' },
  RecommendationDone: { icon: CheckCircle2, label: 'Done', group: 'guidance' },
  Insight: { icon: Sparkles, label: 'ML pattern', group: 'guidance' },
  Instruction: { icon: MessageSquareText, label: 'Flight surgeon', group: 'care' },
  Report: { icon: FileText, label: 'Medical report', group: 'care' },
  Photo: { icon: Camera, label: 'Photo', group: 'checkins' },
}

type Group = 'measurements' | 'checkins' | 'alerts' | 'guidance' | 'care'
const GROUPS: { id: Group | 'all'; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'measurements', label: 'Measurements' },
  { id: 'checkins', label: 'Check-ins, symptoms and photos' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'guidance', label: 'Recommendations' },
  { id: 'care', label: 'Medical care and reports' },
]
const PERIODS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 400, label: 'Whole mission' },
]

function dayKey(iso: string) {
  return new Date(iso).toDateString()
}

/** Chronological health timeline (newest first), grouped by day, with filters and search. */
export function HistoryPage({ code: forCode, staff = false }: { code?: string; staff?: boolean } = {}) {
  const user = useAuth((s) => s.user)
  const code = forCode ?? user?.astronautCode
  const [days, setDays] = useState(staff ? 30 : 7)
  const [group, setGroup] = useState<Group | 'all'>('all')
  const [query, setQuery] = useState('')
  const { data, error, isPending } = useTimeline(code, days)
  const now = useNow()

  const events = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.events ?? []).filter(
      (e) => (group === 'all' || KIND[e.kind].group === group) && (!q || `${e.title} ${e.detail ?? ''}`.toLowerCase().includes(q)),
    )
  }, [data, group, query])

  const byDay = useMemo(() => {
    const out: { key: string; at: string; events: TimelineEvent[] }[] = []
    for (const e of events) {
      const k = dayKey(e.at)
      if (out.at(-1)?.key !== k) out.push({ key: k, at: e.at, events: [] })
      out.at(-1)!.events.push(e)
    }
    return out
  }, [events])

  const today = new Date(now).toDateString()
  const yesterday = new Date(now - 86_400_000).toDateString()
  const dayTitle = (at: string) => {
    const k = dayKey(at)
    const name = k === today ? 'Today' : k === yesterday ? 'Yesterday' : new Date(at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
    return user?.missionStart ? `${name} · mission day ${missionDay(user.missionStart, new Date(at))}` : name
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Period" className="flex flex-wrap gap-1">
            {PERIODS.map((p) => (
              <button key={p.days} type="button" aria-pressed={days === p.days} onClick={() => setDays(p.days)}
                className={`min-h-10 rounded-lg px-3 text-sm font-medium ${days === p.days ? 'bg-accent text-on-accent' : 'text-ink hover:bg-subtle'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <label className="relative min-w-56 flex-1">
            <span className="sr-only">Search the timeline</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, e.g. headache, sleep, fever"
              className="min-h-10 w-full rounded-lg border border-line-strong bg-surface pr-3 pl-9 text-sm" />
          </label>
        </div>
        {(() => {
          const chips = (
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
              {GROUPS.map((g) => (
                <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)}
                  className={`min-h-9 rounded-full border px-3 text-xs font-medium ${group === g.id ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-ink hover:bg-subtle'}`}>
                  {g.label}
                </button>
              ))}
            </div>
          )
          return staff ? chips : <MoreDetail label="Show only one kind">{chips}</MoreDetail>
        })()}
      </div>

      {isPending && <Loading label="Loading your history…" />}
      {error && <ErrorNote error={error} />}
      {data && byDay.length === 0 && <p className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-muted">Nothing recorded for this selection.</p>}
      {data && (
        <p className="text-xs text-ink-muted" aria-live="polite">
          {events.length} event{events.length === 1 ? '' : 's'} since {new Date(`${data.since}T00:00:00`).toLocaleDateString()}
        </p>
      )}

      <ol className="space-y-6">
        {byDay.map((d) => (
          <li key={d.key}>
            <h2 className="sticky top-0 z-10 -mx-1 bg-canvas/95 px-1 py-1 text-sm font-semibold text-ink">{dayTitle(d.at)}</h2>
            {(() => {
              // astronauts, everything shown: the day's actions become one line; the main events stay
              const fold = !staff && group === 'all'
              const actions = fold ? d.events.filter((e) => e.kind === 'Recommendation' || e.kind === 'RecommendationDone') : []
              const main = fold ? d.events.filter((e) => !actions.includes(e)) : d.events
              const added = actions.filter((e) => e.kind === 'Recommendation').length
              const done = actions.length - added
              return (
                <ol className="mt-2 space-y-2 border-l-2 border-line pl-4">
                  {main.map((e) => <EventRow key={e.id} event={e} code={code} base={staff ? `/staff/astronaut/${code}` : null} />)}
                  {actions.length > 0 && (
                    <li className="rounded-lg border border-line bg-surface p-3">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <ListChecks className="h-4 w-4 text-accent" aria-hidden />
                        {[added && `${added} new action${added === 1 ? '' : 's'}`, done && `${done} done`].filter(Boolean).join(' · ')}
                      </p>
                      <MoreDetail label="Show them">
                        <ul className="list-disc space-y-0.5 pl-5 text-ink">
                          {actions.map((e) => <li key={e.id}>{e.title}</li>)}
                        </ul>
                      </MoreDetail>
                    </li>
                  )}
                </ol>
              )
            })()}
          </li>
        ))}
      </ol>
    </div>
  )
}

function EventRow({ event: e, base, code }: { event: TimelineEvent; base: string | null; code?: string | null }) {
  const k = KIND[e.kind]
  const Icon = k.icon
  const isAlert = e.refId && (e.kind === 'Alert' || e.kind === 'AlertClosed')
  const href = base
    ? isAlert ? `${base}?view=alerts&id=${e.refId}` : e.refId && e.kind === 'Report' ? `${base}?view=reports&report=${e.refId}` : undefined
    : isAlert ? `/astronaut/guidance/alerts?id=${e.refId}`
      : e.refId && e.kind === 'Report' ? `/astronaut/history/reports?report=${e.refId}`
        : e.kind === 'Recommendation' ? '/astronaut/guidance' : undefined
  return (
    <li className={`relative rounded-lg border bg-surface p-3 ${e.severity === 'Urgent' ? 'border-status-red/60' : 'border-line'}`}>
      <span className="absolute top-4 -left-[1.4rem] h-2.5 w-2.5 rounded-full border-2 border-surface bg-line-strong" aria-hidden />
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {href ? <Link to={href} className="hover:underline">{e.title}</Link> : e.title}
          </p>
          {e.detail && <p className="mt-0.5 text-sm text-ink-muted">{e.detail}</p>}
          {e.kind === 'Photo' && e.refId && code && (
            <div className="mt-2"><PhotoImage code={code} id={e.refId} alt={`${e.title}${e.detail ? `: ${e.detail}` : ''}`} className="h-32 w-32" /></div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {e.severity && <SeverityBadge severity={e.severity} />}
          <span className="text-xs text-ink-muted">
            {k.label} · <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </span>
        </div>
      </div>
    </li>
  )
}
