import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Activity, Award, Brain, CheckCircle2, ChevronRight, ClipboardCheck, Droplets, Dumbbell, Flame, Globe2, HeartPulse, Moon,
  ShieldAlert, Sparkles, Thermometer, Wind,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { InstructionsBanner } from '../../components/ui/InstructionsBanner'
import { ErrorNote, LinkButton, Loading } from '../../components/ui/Panel'
import { AnswerCard, MoreDetail } from '../../components/ui/Simple'
import { CHECKIN_TASK } from '../../app/sections'
import { api, unwrap, type Progress, type Task, type Vital } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { summarise, wordFor, type TileTone } from '../../lib/plain'
import { useDashboard, useMission, useProgress } from '../../lib/queries'
import { useNow } from '../../lib/useNow'

function greeting(now: number): string {
  const h = new Date(now).getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/**
 * Astronaut Home (Step 14): one answer to "how am I?", today's quests, the body at a glance and the
 * level. Every number and explanation is one tap away; nothing on this page needs medical knowledge.
 */
export function HomePage() {
  const code = useAuth((s) => s.user?.astronautCode)
  const dash = useDashboard(code)
  const progress = useProgress(code)
  const now = useNow()
  if (dash.isPending) return <Loading label="Loading how you are…" />
  if (dash.error) return <ErrorNote error={dash.error} />
  const d = dash.data
  const s = summarise(d, now)
  const checkinDue = d.tasks.some((t) => t.code === CHECKIN_TASK)
  const name = d.displayName.replace(' (simulated)', '')

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting(now)}, {name}</h1>
        <p className="mt-1 text-base text-ink-muted">Here is how you are today, and what to do next.</p>
      </header>
      <InstructionsBanner code={d.astronautCode} />

      <AnswerCard level={s.level} headline={s.headline} role={s.level === 'help' ? 'alert' : undefined}
        actions={
          s.level === 'help' ? (
            <>
              <LinkButton to="/astronaut/emergency" variant="danger"><ShieldAlert className="h-4 w-4" aria-hidden /> Open emergency steps</LinkButton>
              <LinkButton to="/astronaut/guidance" variant="ghost">What to do</LinkButton>
            </>
          ) : (
            <>
              {checkinDue && <LinkButton to="/astronaut/checkin"><ClipboardCheck className="h-4 w-4" aria-hidden /> Do my check-in</LinkButton>}
              {s.level === 'care' && <LinkButton to="/astronaut/guidance" variant={checkinDue ? 'ghost' : 'primary'}>What should I do?</LinkButton>}
              <LinkButton to="/astronaut/assistant" variant="ghost"><Sparkles className="h-4 w-4" aria-hidden /> Ask the assistant</LinkButton>
            </>
          )
        }>
        <p>{s.sentence}</p>
      </AnswerCard>

      <Quests progress={progress.data} tasks={d.tasks} code={d.astronautCode} checkinDue={checkinDue} />
      <BodyToday vitals={d.vitals} now={now} />
      {progress.data && <LevelStrip progress={progress.data} />}
      <MissionNote />
    </div>
  )
}

// --- today's quests -----------------------------------------------------------------------------

const QUESTS: { id: string; title: string; how: string; icon: typeof Moon; href: string }[] = [
  { id: 'checkin', title: 'Daily check-in', how: '2 minutes of measurements', icon: ClipboardCheck, href: '/astronaut/checkin' },
  { id: 'active', title: 'Move 30 minutes', how: 'A coached workout counts', icon: Dumbbell, href: '/astronaut/wellness/exercise' },
  { id: 'hydration', title: 'Drink your water', how: 'Log each drink', icon: Droplets, href: '/astronaut/wellness#nutrition' },
  { id: 'sleep', title: 'Sleep 7 hours', how: 'Counted from last night', icon: Moon, href: '/astronaut/wellness#sleep' },
]
const POINTS: Record<string, number> = { checkin: 10, active: 5, hydration: 5, sleep: 5 }
const HABIT_TASKS = new Set([CHECKIN_TASK, 'REC-HYDRATION', 'REC-EXERCISE-SESSION'])

function Quests({ progress, tasks, code, checkinDue }: { progress?: Progress; tasks: Task[]; code: string; checkinDue: boolean }) {
  const queryClient = useQueryClient()
  const complete = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/api/tasks/{task_id}/complete', { params: { path: { task_id: id } } })),
    onSuccess: () => {
      for (const key of ['dashboard', 'guidance', 'progress']) void queryClient.invalidateQueries({ queryKey: [key, code] })
    },
  })
  const streaks = Object.fromEntries((progress?.streaks ?? []).map((s) => [s.id, s]))
  const done = (id: string) => (id === 'checkin' ? !checkinDue && (streaks.checkin?.doneToday ?? true) : streaks[id]?.doneToday ?? false)
  const doneCount = QUESTS.filter((q) => done(q.id)).length
  const extras = tasks.filter((t) => !HABIT_TASKS.has(t.code)).slice(0, 3)

  return (
    <section aria-labelledby="quests-heading" className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="quests-heading" className="text-lg font-semibold">Today's quests</h2>
        <p className="text-sm text-ink-muted">{doneCount} of {QUESTS.length} done{progress ? ` · +${progress.pointsToday} points today` : ''}</p>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-label="Today's quests done"
        aria-valuemin={0} aria-valuemax={QUESTS.length} aria-valuenow={doneCount}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(doneCount / QUESTS.length) * 100}%` }} />
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUESTS.map((q) => {
          const ok = done(q.id)
          const Icon = ok ? CheckCircle2 : q.icon
          const streak = streaks[q.id]?.current ?? 0
          return (
            <li key={q.id}>
              <Link to={q.href}
                className={`flex h-full flex-col rounded-xl border p-4 transition-colors ${ok ? 'border-status-green/40 bg-status-green/10' : 'border-line hover:border-accent hover:bg-accent-soft'}`}>
                <Icon className={`h-6 w-6 ${ok ? 'text-status-green' : 'text-accent'}`} aria-hidden />
                <span className="mt-2 font-semibold">{q.title}</span>
                <span className="text-sm text-ink-muted">{ok ? 'Done' : q.how}</span>
                <span className="mt-auto flex items-center justify-between pt-2 text-xs text-ink-muted">
                  <span>{ok ? 'Points earned' : `+${POINTS[q.id]} points`}</span>
                  {streak > 1 && <span className="inline-flex items-center gap-0.5"><Flame className="h-3.5 w-3.5 text-status-yellow" aria-hidden /> {streak} days</span>}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      {extras.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-semibold">Bonus quests from your guidance (+5 points each)</p>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {extras.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm">{t.title}</span>
                <button type="button" disabled={complete.isPending} onClick={() => complete.mutate(t.id)}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-subtle">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Done <span className="sr-only">: {t.title}</span>
                </button>
              </li>
            ))}
          </ul>
          {complete.isError && <ErrorNote error={complete.error} />}
        </div>
      )}
    </section>
  )
}

// --- the body at a glance -----------------------------------------------------------------------

const TILES: { label: string; codes: string[]; icon: typeof Moon; href: string }[] = [
  { label: 'Heart', codes: ['resting_hr', 'bp_sys', 'bp_dia'], icon: HeartPulse, href: '/astronaut/health?region=heart' },
  { label: 'Sleep', codes: ['sleep_hours'], icon: Moon, href: '/astronaut/wellness#sleep' },
  { label: 'Mind and energy', codes: ['mood', 'stress', 'fatigue'], icon: Brain, href: '/astronaut/health?region=brain' },
  { label: 'Blood sugar', codes: ['glucose'], icon: Activity, href: '/astronaut/health?region=digestive' },
  { label: 'Temperature', codes: ['body_temp'], icon: Thermometer, href: '/astronaut/health?region=immune' },
  { label: 'Oxygen', codes: ['spo2'], icon: Wind, href: '/astronaut/health?region=lungs' },
]
const TILE_STYLE: Record<TileTone, string> = {
  ok: 'border-status-green/30 bg-status-green/10 text-status-green',
  care: 'border-status-yellow/40 bg-status-yellow/10 text-status-yellow',
  none: 'border-line bg-subtle text-ink-muted',
}

function BodyToday({ vitals, now }: { vitals: Vital[]; now: number }) {
  const by = Object.fromEntries(vitals.map((v) => [v.indicator, v])) as Record<string, Vital | undefined>
  return (
    <section aria-labelledby="body-heading" className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="body-heading" className="text-lg font-semibold">Your body today</h2>
        <p className="text-sm text-ink-muted">Compared with your own usual values</p>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
        {TILES.map((t) => {
          const found = t.codes.map((c) => by[c]).filter((v): v is Vital => Boolean(v))
          const { word, tone } = wordFor(found, now)
          const Icon = t.icon
          return (
            <li key={t.label}>
              <Link to={t.href} className={`flex items-center gap-3 rounded-xl border p-3 hover:brightness-95 ${TILE_STYLE[tone]}`}>
                <Icon className="h-6 w-6 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{t.label}</span>
                  <span className="block text-sm font-medium">{word}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
              </Link>
            </li>
          )
        })}
      </ul>
      <MoreDetail label="See the numbers" className="mt-3">
        <ul className="grid gap-1 sm:grid-cols-2">
          {vitals.filter((v) => TILES.some((t) => t.codes.includes(v.indicator))).map((v) => (
            <li key={v.indicator}>
              {v.name}: <span className="font-medium text-ink">{v.value} {v.unit}</span>
              {v.baseline != null && <> (your usual {Math.round(v.baseline * 10) / 10})</>}
            </li>
          ))}
        </ul>
        <Link to="/astronaut/health/trends" className="mt-2 inline-block font-medium text-accent hover:underline">Charts of every measurement</Link>
      </MoreDetail>
    </section>
  )
}

// --- level and badges ---------------------------------------------------------------------------

function LevelStrip({ progress }: { progress: Progress }) {
  const { level, points } = progress
  const span = level.nextPoints != null ? level.nextPoints - level.minPoints : 1
  const pct = level.nextPoints != null ? Math.min(100, Math.round(((points - level.minPoints) / span) * 100)) : 100
  const best = Math.max(0, ...progress.streaks.map((s) => s.current))
  const badges = progress.badges.filter((b) => b.earned).length
  return (
    <section aria-label="Your level" className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-lg font-bold text-on-accent">{level.number}</span>
        <div>
          <p className="font-semibold">Level {level.number} · {level.title}</p>
          <p className="text-sm text-ink-muted">{level.nextPoints != null ? `${level.nextPoints - points} points to level ${level.number + 1}` : 'Top level reached'}</p>
        </div>
      </div>
      <div className="min-w-40 flex-1">
        <div className="h-2.5 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-label="Progress to the next level"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <p className="inline-flex items-center gap-1 text-sm"><Flame className="h-4 w-4 text-status-yellow" aria-hidden /> {best > 0 ? `${best}-day streak` : 'Start a streak today'}</p>
      <Link to="/astronaut/wellness#progress" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
        <Award className="h-4 w-4" aria-hidden /> {badges} badge{badges === 1 ? '' : 's'}
      </Link>
    </section>
  )
}

/** The environment in one line; details folded. */
function MissionNote() {
  const profile = useMission().data?.profile
  if (!profile) return null
  return (
    <section aria-label="Your environment" className="rounded-2xl border border-line bg-surface p-5">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Globe2 className="h-5 w-5 text-accent" aria-hidden />
        <span className="font-semibold">{profile.name}</span>
        <span className="text-ink-muted">· {profile.gravityG === 0 ? 'weightless' : `${Math.round(profile.gravityG * 100)} % of Earth's gravity`} · {profile.commsDelayMaxMinutes < 1 ? 'you can talk to Earth live' : `messages to Earth take ${fmtMin(profile.commsDelayMinMinutes)}–${fmtMin(profile.commsDelayMaxMinutes)}`}</span>
      </p>
      <MoreDetail label="What matters for your health here" className="mt-1">
        <ul className="space-y-2">
          {profile.healthFocus.map((f) => (
            <li key={f.title}><span className="font-semibold text-ink">{f.title}.</span> {f.detail}</li>
          ))}
        </ul>
      </MoreDetail>
    </section>
  )
}

function fmtMin(m: number): string {
  return m < 1 ? `${Math.round(m * 60)} s` : `${Math.round(m)} min`
}
