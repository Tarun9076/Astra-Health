import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain, Camera, CheckCircle2, Droplets, Dumbbell, HeartHandshake, Moon, Pause, Play, Trophy, Utensils, Wind } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ProgressDetails } from '../../components/health/ProgressCard'
import { Button, ErrorNote, LinkButton, Loading, Panel } from '../../components/ui/Panel'
import { MoreDetail, PageHeader } from '../../components/ui/Simple'
import { wordFor } from '../../lib/plain'
import { api, unwrap, type Vital, type WellnessCenter } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useDashboard, useProgress, useWellnessCenter } from '../../lib/queries'

// Box breathing: 4 s in, 4 s hold, 4 s out, 4 s hold — a common, simple calming exercise.
const PHASES = [
  { label: 'Breathe in', seconds: 4, scale: 1 },
  { label: 'Hold', seconds: 4, scale: 1 },
  { label: 'Breathe out', seconds: 4, scale: 0.55 },
  { label: 'Hold', seconds: 4, scale: 0.55 },
]
const ROUNDS = 4

function phaseAt(second: number) {
  let left = second % PHASES.reduce((sum, p) => sum + p.seconds, 0)
  for (const phase of PHASES) {
    if (left < phase.seconds) return phase
    left -= phase.seconds
  }
  return PHASES[0]
}

function Breathing({ onDone }: { onDone: (seconds: number) => void }) {
  const [running, setRunning] = useState(false)
  const [tick, setTick] = useState(0) // seconds elapsed
  const total = ROUNDS * PHASES.reduce((s, p) => s + p.seconds, 0)
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  }, [onDone])
  useEffect(() => {
    if (!running) return
    let elapsed = 0
    const id = window.setInterval(() => {
      elapsed += 1
      if (elapsed >= total) {
        window.clearInterval(id)
        setRunning(false)
        setTick(0)
        done.current(total)
      } else {
        setTick(elapsed)
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [running, total])
  const phase = phaseAt(tick)
  const start = () => {
    setTick(0)
    setRunning((r) => !r)
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative flex h-44 w-44 items-center justify-center" aria-live="polite">
        <div className="absolute inset-0 rounded-full bg-accent/15 transition-transform duration-[4000ms] ease-in-out"
          style={{ transform: `scale(${running ? phase.scale : 0.7})` }} aria-hidden />
        <p className="relative text-center text-lg font-semibold">{running ? phase.label : 'Box breathing'}
          <span className="block text-xs font-normal text-ink">{running ? `${total - tick} s left` : `${ROUNDS} rounds · ${total} s`}</span></p>
      </div>
      <Button onClick={start}>
        {running ? <><Pause className="h-4 w-4" aria-hidden /> Stop</> : <><Play className="h-4 w-4" aria-hidden /> Start</>}
      </Button>
    </div>
  )
}

function Bars({ days, target, unit }: { days: { day: string; value: number | null }[]; target: number; unit: string }) {
  const max = Math.max(target, ...days.map((d) => d.value ?? 0)) || 1
  return (
    <div>
      <div className="flex h-20 items-end gap-1.5" role="img"
        aria-label={`Last 7 days: ${days.map((d) => `${d.value ?? 'no data'} ${unit}`).join(', ')}`}>
        {days.map((d) => (
          <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.value ?? 'no data'} ${unit}`}>
            <div className="relative w-full rounded-t bg-subtle" style={{ height: `${((d.value ?? 0) / max) * 64}px` }}>
              <div className={`h-full w-full rounded-t ${(d.value ?? 0) >= target ? 'bg-accent' : 'bg-accent/40'}`} />
            </div>
            <span className="text-[10px] text-ink-muted">{new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">Darker bars reach the target ({target} {unit}). Hover a bar for its value.</p>
    </div>
  )
}

function Ring({ value, goal, label }: { value: number; goal: number; label: string }) {
  const pct = Math.min(1, goal ? value / goal : 0)
  const r = 34, c = 2 * Math.PI * r
  return (
    <div className="relative h-24 w-24 shrink-0" role="img" aria-label={`${label}: ${value} of ${goal}`}>
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--color-subtle)" strokeWidth="8" />
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--color-accent)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${pct * c} ${c}`} />
      </svg>
      <p className="absolute inset-0 flex flex-col items-center justify-center text-lg font-semibold">{value}<span className="text-[10px] font-normal text-ink-muted">of {goal}</span></p>
    </div>
  )
}

const SECTIONS = [
  { id: 'activity', label: 'Physical activity', icon: Dumbbell },
  { id: 'sleep', label: 'Sleep', icon: Moon },
  { id: 'mind', label: 'Mental wellness', icon: Brain },
  { id: 'nutrition', label: 'Nutrition and hydration', icon: Utensils },
  { id: 'progress', label: 'Progress and badges', icon: Trophy },
]

function Section({ id, title, intro, icon: Icon, children }: { id: string; title: string; intro: string; icon: typeof Moon; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4 space-y-3">
      <div>
        <h2 id={`${id}-h`} className="flex items-center gap-2 text-lg font-semibold"><Icon className="h-5 w-5 text-accent" aria-hidden />{title}</h2>
        <p className="text-sm text-ink-muted">{intro}</p>
      </div>
      {children}
    </section>
  )
}

/** Wellness: four supportive areas (activity, sleep, mind, nutrition) with real readings and simple logging. */
export function WellnessCenterPage() {
  const code = useAuth((s) => s.user?.astronautCode)
  const { data, error, isPending } = useWellnessCenter(code)
  const dash = useDashboard(code)
  const progress = useProgress(code)
  const { hash } = useLocation()
  const loaded = Boolean(data)
  useEffect(() => {
    // links like /astronaut/wellness#progress: scroll once the sections exist
    if (loaded && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [loaded, hash])
  const vitals = Object.fromEntries((dash.data?.vitals ?? []).map((v) => [v.indicator, v])) as Record<string, Vital | undefined>
  const queryClient = useQueryClient()
  const log = useMutation({
    mutationFn: (body: { kind: 'fluid' | 'breathing'; amount: number }) => unwrap(api.POST('/api/wellness/activity', { body })),
    onSuccess: (out: WellnessCenter) => {
      queryClient.setQueryData(['wellness-center', code], out)
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
  const card = (indicator: string, label: string) => {
    const v = vitals[indicator]
    if (!v) return null
    const { word, tone } = wordFor([v])
    const unit = v.unit === 'score' ? '/10' : ` ${v.unit}`
    return (
      <Panel title={label}>
        <p className="text-3xl font-semibold">{v.value}<span className="ml-1 text-base font-normal text-ink-muted">{unit.trim()}</span></p>
        <p className={`mt-1 text-sm font-semibold ${tone === 'care' ? 'text-status-yellow' : tone === 'ok' ? 'text-status-green' : 'text-ink-muted'}`}>{word}</p>
        <Link to={`/astronaut/health/trends?indicator=${indicator}`} className="mt-1 inline-block text-sm text-accent hover:underline">
          See the trend<span className="sr-only"> of {label}</span>
        </Link>
      </Panel>
    )
  }
  const sessions = data?.exerciseSessionsWeek ?? 0
  const target = data?.exerciseTarget ?? 5

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Wellness" purpose="Small daily habits that keep you strong. Each one earns points." />
      <nav aria-label="Wellness sections" className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-subtle">
            <s.icon className="h-4 w-4 text-accent" aria-hidden />{s.label}
          </a>
        ))}
      </nav>
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {log.isError && <ErrorNote error={log.error} />}
      {data && (
        <>
          <Section id="activity" title="Physical activity" icon={Dumbbell}
            intro="Without gravity, muscles and bones weaken. Your prescribed resistance exercise is the main protection.">
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Prescribed resistance training">
                <div className="flex items-center gap-4">
                  <Ring value={sessions} goal={target} label="Resistance sessions this week" />
                  <div className="text-sm">
                    <p className="font-medium">{sessions} of {target} sessions this week</p>
                    <p className="text-ink-muted">{sessions >= target ? 'Plan completed for this week.' : `${target - sessions} more to complete this week’s plan.`}</p>
                  </div>
                </div>
                <LinkButton to="/astronaut/wellness/exercise" className="mt-4 w-full">
                  <Camera className="h-4 w-4" aria-hidden /> Start a coached workout
                </LinkButton>
              </Panel>
              <Panel title="Muscle performance">
                {data.strengthIndex != null ? (
                  <>
                    <p className="text-3xl font-semibold">{data.strengthIndex.toFixed(0)}<span className="ml-1 text-base font-normal text-ink-muted">% of pre-flight</span></p>
                    <p className="mt-1 text-sm text-ink-muted">Strength on the exercise device compared with before flight (100 % = the same).</p>
                  </>
                ) : <p className="text-sm text-ink-muted">No strength test recorded yet.</p>}
              </Panel>
              {card('activity_min', 'Exercise today') ?? (
                <Panel title="Exercise today"><p className="text-sm text-ink-muted">No exercise recorded today yet.</p></Panel>
              )}
            </div>
          </Section>

          <Section id="sleep" title="Sleep" icon={Moon}
            intro="Light, noise and workload disrupt sleep in space. Regular sleep keeps you alert and steady.">
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Last 7 nights" className="lg:col-span-2">
                <p className="mb-2 text-sm">Your normal: {data.sleepNormalHours != null ? `${data.sleepNormalHours.toFixed(1)} h` : 'not known yet'} · aim for at least 7 h</p>
                <Bars days={data.sleepDays.map((d) => ({ day: d.day, value: d.value ?? null }))} target={7} unit="h" />
              </Panel>
              {card('sleep_quality', 'Sleep quality')}
            </div>
            <Panel title="Tonight">
              <p className="text-sm">Go to bed at your usual time, with lights and screens dimmed.</p>
              <MoreDetail label="More sleep tips">
                <ul className="list-disc space-y-1 pl-5 text-ink">
                  <li>Keep fixed sleep and wake times, even on rest days.</li>
                  <li>Dim lights and screens 30 minutes before your sleep period.</li>
                  <li>No caffeine in the 6 hours before sleep; try the breathing exercise to wind down.</li>
                </ul>
              </MoreDetail>
            </Panel>
          </Section>

          <Section id="mind" title="Mental wellness" icon={Brain}
            intro="Isolation, confinement and workload affect everyone. Noticing changes early makes them easier to handle.">
            <div className="grid gap-4 sm:grid-cols-3">
              {card('mood', 'Mood')}
              {card('stress', 'Stress')}
              {card('fatigue', 'Fatigue')}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Guided relaxation: box breathing">
                <Breathing onDone={(seconds) => log.mutate({ kind: 'breathing', amount: seconds })} />
                <p className="mt-3 text-center text-xs text-ink-muted">
                  <Wind className="mr-1 inline h-3.5 w-3.5" aria-hidden />{data.breathingSessionsWeek} session(s), {data.breathingMinutesWeek} min this week
                </p>
              </Panel>
              <Panel title="Someone to talk to">
                <p className="flex items-start gap-2 text-sm">
                  <HeartHandshake className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
                  You can ask for a private call with the flight surgeon or the mission psychologist at any time.
                </p>
                <p className="mt-3 text-sm">
                  If you have thoughts of harming yourself, tell the crew medical officer now and open the{' '}
                  <Link to="/astronaut/emergency" className="font-semibold text-status-red underline">emergency steps</Link>.
                </p>
                <MoreDetail label="Other things that help">
                <ul className="list-disc space-y-1 pl-5 text-ink">
                  <li>Talk to a crewmate you trust.</li>
                  <li>Keep regular contact with family during scheduled calls.</li>
                  <li>
                    Ask the <Link to="/astronaut/assistant" className="font-medium text-accent underline">AI assistant</Link> about
                    stress and coping; it explains approved guidance in plain words.
                  </li>
                  <li>Messages to Earth take several minutes each way, so a scheduled private call works best.</li>
                </ul>
                </MoreDetail>
              </Panel>
            </div>
          </Section>

          <Section id="nutrition" title="Nutrition and hydration" icon={Utensils}
            intro="Thirst is weaker in weightlessness. Enough water protects the kidneys and helps energy and recovery.">
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Water today" className="lg:col-span-2">
                <p className="flex items-baseline gap-2">
                  <Droplets className="h-5 w-5 text-accent" aria-hidden />
                  <span className="text-3xl font-semibold">{data.hydrationTodayMl.toFixed(0)}</span>
                  <span className="text-sm text-ink-muted">of {data.hydrationTargetMl.toFixed(0)} mL target</span>
                </p>
                <div className="my-2 h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-label="Water today"
                  aria-valuemin={0} aria-valuemax={data.hydrationTargetMl} aria-valuenow={data.hydrationTodayMl}>
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, (100 * data.hydrationTodayMl) / data.hydrationTargetMl)}%` }} />
                </div>
                <div className="mb-3 flex flex-wrap gap-2">
                  {[250, 500].map((ml) => (
                    <Button key={ml} variant="ghost" disabled={log.isPending} onClick={() => log.mutate({ kind: 'fluid', amount: ml })}>+ {ml} mL</Button>
                  ))}
                </div>
                <Bars days={data.hydrationDays.map((d) => ({ day: d.day, value: d.value ?? null }))} target={data.hydrationTargetMl} unit="mL" />
              </Panel>
              <div className="space-y-4">
                {card('body_weight', 'Body weight')}
                <Panel title="Food">
                  <p className="text-sm text-ink-muted">Follow the mission menu plan. (Meal logging is not built yet.)</p>
                </Panel>
              </div>
            </div>
          </Section>

          <Panel title="Daily habits">
            <ul className="space-y-3">
              {data.missions.map((m) => (
                <li key={m.id}>
                  <p className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-1 font-medium">
                      {m.done && <CheckCircle2 className="h-4 w-4 text-status-green" aria-hidden />}{m.title}
                    </span>
                    <span className="text-xs text-ink-muted">{m.progress} of {m.goal} {m.unit}{m.streak ? ` · ${m.streak} days in a row` : ''}</span>
                  </p>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
                    <div className={`h-full ${m.done ? 'bg-status-green' : 'bg-accent'}`} style={{ width: `${Math.min(100, (100 * m.progress) / m.goal)}%` }} />
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{m.description}</p>
                </li>
              ))}
            </ul>
          </Panel>

          <Section id="progress" title="Progress and badges" icon={Trophy}
            intro="Earn points and badges for the healthy habits you control: checking in, exercising, sleeping and drinking enough, and following your guidance.">
            {progress.data ? <ProgressDetails progress={progress.data} /> : progress.error ? <ErrorNote error={progress.error} /> : <Loading />}
          </Section>
        </>
      )}
    </div>
  )
}
