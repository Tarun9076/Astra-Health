import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, CheckCircle2, Eye, ChevronRight, CircleDashed, ClipboardCheck, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EnvironmentCard } from '../../components/health/EnvironmentCard'
import { MeasurementCard, MissingMeasurementCard } from '../../components/health/MeasurementCard'
import { ProgressSummary } from '../../components/health/ProgressCard'
import { readingStatus } from '../../lib/readingStatus'
import { ObservationCard, ReadingObservation } from '../../components/health/ObservationCard'
import { InstructionsBanner } from '../../components/ui/InstructionsBanner'
import { ErrorNote, LinkButton, Loading, Panel } from '../../components/ui/Panel'
import { WellnessCard } from '../../components/ui/WellnessCard'
import { CHECKIN_TASK } from '../../app/sections'
import { api, unwrap, type Dashboard, type Task, type Vital } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { infoFor } from '../../lib/indicators'
import { timeAgo } from '../../lib/mission'
import { useDashboard, useGuidance, useMission, useProgress } from '../../lib/queries'
import { useNow } from '../../lib/useNow'

/** Key measurements in priority order; blood pressure is one card with two numbers. */
const KEY_MEASUREMENTS: { key: string; label: string; codes: string[]; how: string; checkin: boolean }[] = [
  { key: 'resting_hr', label: 'Resting heart rate', codes: ['resting_hr'], how: 'Measured by the wearable each morning, or enter it in the daily check-in.', checkin: true },
  { key: 'bp', label: 'Blood pressure', codes: ['bp_sys', 'bp_dia'], how: 'Take it with the blood-pressure cuff during the daily check-in.', checkin: true },
  { key: 'glucose', label: 'Blood sugar', codes: ['glucose'], how: 'Measure it with the glucose meter in the daily check-in.', checkin: true },
  { key: 'body_temp', label: 'Body temperature', codes: ['body_temp'], how: 'Take it with the thermometer during the daily check-in.', checkin: true },
  { key: 'spo2', label: 'Oxygen saturation', codes: ['spo2'], how: 'Use the pulse oximeter during the daily check-in.', checkin: true },
  { key: 'sleep_hours', label: 'Sleep last night', codes: ['sleep_hours'], how: 'From the wearable, or answer in the daily check-in.', checkin: true },
  { key: 'mood', label: 'Mood', codes: ['mood'], how: 'Answer in the daily check-in.', checkin: true },
  { key: 'stress', label: 'Stress', codes: ['stress'], how: 'Answer in the daily check-in.', checkin: true },
  { key: 'fatigue', label: 'Fatigue', codes: ['fatigue'], how: 'Answer in the daily check-in.', checkin: true },
]

function greeting(now: number): string {
  const h = new Date(now).getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** Overview for one astronaut. `readOnly` = a flight surgeon viewing someone else. */
export function OverviewPage({ code, readOnly = false }: { code?: string; readOnly?: boolean }) {
  const user = useAuth((s) => s.user)
  const astronautCode = code ?? user?.astronautCode
  const { data, error, isPending } = useDashboard(astronautCode)
  const progress = useProgress(readOnly ? null : astronautCode)
  const mission = useMission()
  const now = useNow()
  // indicators already covered by an active alert (same query key as the alert cards, so cached)
  const details = useQueries({
    queries: (data?.activeAlerts ?? []).map((a) => ({
      queryKey: ['alert', a.id],
      queryFn: () => unwrap(api.GET('/api/alerts/{alert_id}', { params: { path: { alert_id: a.id } } })),
    })),
  })
  const covered = new Set(details.flatMap((q) => Object.values(q.data?.evidence ?? {}).map((e) => String(e.indicator))))

  if (isPending) return <Loading label="Loading your health summary…" />
  if (error) return <ErrorNote error={error} />
  const byCode = Object.fromEntries(data.vitals.map((v) => [v.indicator, v])) as Record<string, Vital>
  const urgent = data.activeAlerts.filter((a) => a.severity === 'Urgent')
  const alertBase = readOnly ? undefined : '/astronaut/guidance/alerts'
  // readings outside the normal range with no alert about them yet (the rules wait for a repeat)
  const watch = data.vitals.filter((v) => readingStatus([v], now).tone === 'warn' && v.quality !== 'Questionable' && !covered.has(v.indicator))

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {!readOnly && (
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting(now)}, {data.displayName.replace(' (simulated)', '')}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {data.astronautCode}
            {data.missionCode && ` · ${data.missionCode}`}
            {data.missionDay != null && ` · mission day ${data.missionDay}`}
            {' · '}
            {new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            {data.lastReadingAt && ` · last health update ${timeAgo(data.lastReadingAt)}`}
          </p>
        </header>
      )}
      {!readOnly && <InstructionsBanner code={data.astronautCode} />}

      {urgent.length > 0 && (
        <section role="alert" className="rounded-xl border-2 border-status-red bg-status-red/[0.06] p-4">
          <p className="flex items-center gap-2 text-lg font-semibold text-status-red">
            <AlertOctagon className="h-6 w-6" aria-hidden /> Urgent: act now
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {urgent.map((a) => (
              <li key={a.id}>
                <span className="font-semibold">{a.title}.</span> {a.reason}
              </li>
            ))}
          </ul>
          {!readOnly && (
            <div className="mt-3 flex flex-wrap gap-2">
              <LinkButton to="/astronaut/emergency" variant="danger">
                <ShieldAlert className="h-4 w-4" aria-hidden /> Open emergency procedure
              </LinkButton>
              <LinkButton to={`/astronaut/guidance/alerts?id=${urgent[0].id}`} variant="ghost">Alert details</LinkButton>
            </div>
          )}
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <HealthSummary data={data} vitals={data.vitals} readOnly={readOnly} now={now} />

          <section aria-labelledby="attention-heading">
            <h2 id="attention-heading" className="mb-3 text-lg font-semibold">Something to pay attention to</h2>
            {data.activeAlerts.length === 0 && watch.length === 0 ? (
              <p className="flex items-center gap-2 rounded-xl border border-line bg-surface p-4 text-sm">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-status-green" aria-hidden />
                Nothing needs your attention. Your recent measurements are within your normal range.
              </p>
            ) : (
              <div className="space-y-3">
                {data.activeAlerts.map((a, i) => (
                  <ObservationCard key={a.id} alert={a} open={i === 0} detailHref={alertBase && `${alertBase}?id=${a.id}`} />
                ))}
                {watch.map((v) => <ReadingObservation key={v.indicator} vital={v} />)}
              </div>
            )}
          </section>

          <section aria-labelledby="measurements-heading">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="measurements-heading" className="text-lg font-semibold">Key measurements</h2>
              <p className="text-xs text-ink-muted">Compared with your own normal (your typical values over the last 4 weeks)</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {KEY_MEASUREMENTS.map((m) => {
                const vitals = m.codes.map((c) => byCode[c]).filter(Boolean)
                return vitals.length === m.codes.length ? (
                  <MeasurementCard key={m.key} label={m.label} vitals={vitals}
                    historyHref={readOnly ? undefined : `/astronaut/health/trends?indicator=${m.codes[0]}`} />
                ) : (
                  <MissingMeasurementCard key={m.key} label={m.label} how={m.how}
                    href={!readOnly && m.checkin ? '/astronaut/checkin' : undefined} />
                )
              })}
            </div>
          </section>

          {mission.data?.profile && <EnvironmentCard profile={mission.data.profile} />}
        </div>

        <aside className="space-y-6" aria-label="Today">
          <TodayTasks tasks={data.tasks} code={data.astronautCode} readOnly={readOnly} now={now} />
          {!readOnly && progress.data && <ProgressSummary progress={progress.data} />}
          {data.wellness && <WellnessCard wellness={data.wellness} />}
        </aside>
      </div>
    </div>
  )
}

/** Plain-language summary: never an unexplained score. Each line says what contributed. */
function HealthSummary({ data, vitals, readOnly, now }: { data: Dashboard; vitals: Vital[]; readOnly: boolean; now: number }) {
  const urgent = data.activeAlerts.filter((a) => a.severity === 'Urgent').length
  const attention = data.activeAlerts.length - urgent
  const checkinDue = data.tasks.some((t) => t.code === CHECKIN_TASK)
  const outside = vitals.filter((v) => readingStatus([v], now).tone === 'warn')
  const keyCodes = new Set(KEY_MEASUREMENTS.flatMap((m) => m.codes))
  const stale = vitals.filter((v) => keyCodes.has(v.indicator) && v.indicator !== 'bp_dia' && now - Date.parse(v.measuredAt) > 48 * 3_600_000)

  const headline =
    data.status === 'RED'
      ? { icon: AlertOctagon, cls: 'text-status-red', text: 'Urgent: follow the emergency procedure now' }
      : data.status === 'YELLOW'
        ? { icon: TriangleAlert, cls: 'text-status-yellow', text: `${attention} finding${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} your attention` }
        : outside.length > 0
          ? { icon: Eye, cls: 'text-ink', text: `No alerts — ${outside.length} reading${outside.length === 1 ? '' : 's'} to watch` }
          : { icon: CheckCircle2, cls: 'text-status-green', text: 'No health concerns right now' }
  const Icon = headline.icon

  const lines: { ok: boolean; text: string; href?: string }[] = [
    { ok: urgent === 0, text: urgent === 0 ? 'No urgent alerts' : `${urgent} urgent alert${urgent === 1 ? '' : 's'}`, href: '/astronaut/guidance/alerts' },
    { ok: attention === 0, text: attention === 0 ? 'No alerts to review' : `${attention} alert${attention === 1 ? '' : 's'} to review`, href: '/astronaut/guidance/alerts' },
    {
      ok: outside.length === 0,
      text: outside.length === 0
        ? 'Latest measurements are within your normal'
        : `Outside your normal: ${outside.map((v) => infoFor(v.indicator)?.label ?? v.name).join(', ')}`,
    },
    { ok: !checkinDue, text: checkinDue ? 'Daily check-in not done yet' : 'Daily check-in done', href: '/astronaut/checkin' },
  ]
  if (stale.length > 0) lines.push({ ok: false, text: `${stale.length} reading${stale.length === 1 ? ' is' : 's are'} more than 2 days old`, href: '/astronaut/checkin' })

  return (
    <section aria-labelledby="summary-heading" className="rounded-xl border border-line bg-surface p-5">
      <h2 id="summary-heading" className="text-xs font-semibold tracking-wide text-ink-muted uppercase">How you are right now</h2>
      <p className={`mt-2 flex items-center gap-2 text-xl font-semibold ${headline.cls}`}>
        <Icon className="h-6 w-6 shrink-0" aria-hidden /> {headline.text}
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {lines.map((l) => {
          const LineIcon = l.ok ? CheckCircle2 : CircleDashed
          const content = (
            <>
              <LineIcon className={`mt-0.5 h-4 w-4 shrink-0 ${l.ok ? 'text-status-green' : 'text-status-yellow'}`} aria-hidden />
              <span className="sr-only">{l.ok ? 'OK:' : 'Needs attention:'}</span>
              <span>{l.text}</span>
            </>
          )
          return (
            <li key={l.text} className="text-sm">
              {l.href && !l.ok && !readOnly ? (
                <Link to={l.href} className="flex items-start gap-2 rounded hover:underline">{content}<ChevronRight className="mt-0.5 h-4 w-4 text-ink-muted" aria-hidden /></Link>
              ) : (
                <span className="flex items-start gap-2">{content}</span>
              )}
            </li>
          )
        })}
      </ul>
      <details className="mt-4 text-xs text-ink-muted">
        <summary className="cursor-pointer font-medium text-accent">How is this status decided?</summary>
        <p className="mt-1">
          Fixed medical rules compare each new reading with <em>your own</em> normal range (your typical values over the
          last 4 weeks) and with safety limits. Attention means a rule matched; Urgent means a safety limit or a red-flag
          symptom. Machine learning can add supporting notes but never sets the status, and the AI assistant only explains.
        </p>
      </details>
      {!readOnly && checkinDue && (
        <div className="mt-4">
          <LinkButton to="/astronaut/checkin">
            <ClipboardCheck className="h-4 w-4" aria-hidden /> Start daily check-in
          </LinkButton>
        </div>
      )}
    </section>
  )
}

const TASK_LINK: Record<string, { href: string; label: string }> = {
  [CHECKIN_TASK]: { href: '/astronaut/checkin', label: 'Start' },
  'REC-HYDRATION': { href: '/astronaut/wellness#nutrition', label: 'Log water' },
  'REC-EXERCISE-SESSION': { href: '/astronaut/wellness#activity', label: 'Open' },
}

function TodayTasks({ tasks, code, readOnly, now }: { tasks: Task[]; code: string; readOnly: boolean; now: number }) {
  const queryClient = useQueryClient()
  const guidance = useGuidance(code)
  const complete = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/api/tasks/{task_id}/complete', { params: { path: { task_id: id } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard', code] })
      void queryClient.invalidateQueries({ queryKey: ['guidance', code] })
    },
  })
  const today = new Date(now).toDateString()
  const doneToday = (guidance.data?.items ?? []).filter((i) => i.status === 'Done' && i.completedAt && new Date(i.completedAt).toDateString() === today)
  const total = tasks.length + doneToday.length
  const pct = total === 0 ? 100 : Math.round((doneToday.length / total) * 100)

  return (
    <Panel title="Today's tasks">
      <div className="mb-3">
        <p className="text-sm font-medium">{total === 0 ? 'Nothing scheduled right now' : `${doneToday.length} of ${total} done`}</p>
        <div className="mt-1.5 h-2 rounded-full bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
          aria-label="Today's tasks completed">
          <div className="h-2 rounded-full bg-status-green" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ul className="divide-y divide-line">
        {tasks.map((t) => {
          const link = TASK_LINK[t.code]
          return (
            <li key={t.id} className="flex items-start gap-3 py-3">
              <CircleDashed className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.title}</p>
                <p className="text-xs text-ink-muted">{t.body}</p>
                {!readOnly && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {link && <Link to={link.href} className="inline-flex min-h-9 items-center rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent">{link.label}</Link>}
                    {t.code !== CHECKIN_TASK && (
                      <button type="button" disabled={complete.isPending} onClick={() => complete.mutate(t.id)}
                        className="inline-flex min-h-9 items-center rounded-lg border border-line-strong px-3 text-xs font-semibold hover:bg-subtle">
                        Mark done <span className="sr-only">: {t.title}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
        {doneToday.map((t) => (
          <li key={t.id} className="flex items-start gap-3 py-3 text-ink-muted">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-green" aria-hidden />
            <p className="text-sm"><span className="sr-only">Done: </span><s>{t.title}</s></p>
          </li>
        ))}
      </ul>
      {complete.isError && <ErrorNote error={complete.error} />}
      {!readOnly && (
        <Link to="/astronaut/guidance" className="mt-2 inline-block text-sm font-medium text-accent hover:underline">All recommended actions</Link>
      )}
    </Panel>
  )
}
