import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Droplets, Dumbbell, Flame, Moon, Pause, Play, Trophy, Wind } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { api, unwrap, type WellnessCenter } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useWellnessCenter } from '../../lib/queries'

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
        <div className="absolute inset-0 rounded-full bg-accent/20 transition-transform duration-[4000ms] ease-in-out"
          style={{ transform: `scale(${running ? phase.scale : 0.7})` }} aria-hidden />
        <p className="relative text-center text-lg font-semibold">{running ? phase.label : 'Box breathing'}
          <span className="block text-xs font-normal text-ink-muted">{running ? `${total - tick} s left` : `${ROUNDS} rounds · ${total} s`}</span></p>
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
      <div className="flex h-20 items-end gap-1.5" aria-label={`Last 7 days (${unit})`}>
        {days.map((d) => (
          <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.value ?? 'no data'} ${unit}`}>
            <div className="relative w-full rounded-t bg-space-700" style={{ height: `${((d.value ?? 0) / max) * 64}px` }}>
              <div className={`h-full w-full rounded-t ${(d.value ?? 0) >= target ? 'bg-accent' : 'bg-accent/40'}`} />
            </div>
            <span className="text-[10px] text-ink-muted">{new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">Bright bars reach the target ({target} {unit}).</p>
    </div>
  )
}

function Ring({ value, goal, label }: { value: number; goal: number; label: string }) {
  const pct = Math.min(1, goal ? value / goal : 0)
  const r = 34, c = 2 * Math.PI * r
  return (
    <div className="relative h-24 w-24" role="img" aria-label={`${label}: ${value} of ${goal}`}>
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="#1c2742" strokeWidth="8" />
        <circle cx="40" cy="40" r={r} fill="none" stroke="#38bdf8" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${pct * c} ${c}`} />
      </svg>
      <p className="absolute inset-0 flex flex-col items-center justify-center font-mono text-lg">{value}<span className="text-[10px] text-ink-muted">of {goal}</span></p>
    </div>
  )
}

/** Wellness Center (Step 10): breathing, hydration, sleep, exercise and missions with streaks. */
export function WellnessCenterPage() {
  const code = useAuth((s) => s.user?.astronautCode)
  const { data, error, isPending } = useWellnessCenter(code)
  const queryClient = useQueryClient()
  const log = useMutation({
    mutationFn: (body: { kind: 'fluid' | 'breathing'; amount: number }) => unwrap(api.POST('/api/wellness/activity', { body })),
    onSuccess: (out: WellnessCenter) => {
      queryClient.setQueryData(['wellness-center', code], out)
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
  return (
    <div className="max-w-6xl space-y-4">
      <div>
        <p className="font-mono text-sm text-accent">05</p>
        <h1 className="text-2xl font-semibold">Wellness Center</h1>
        <p className="mt-1 text-sm text-ink-muted">Small daily habits that protect sleep, heart, muscles and mood on a long mission.</p>
      </div>
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {log.isError && <ErrorNote error={log.error} />}
      {data && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Breathing exercise">
              <Breathing onDone={(seconds) => log.mutate({ kind: 'breathing', amount: seconds })} />
              <p className="mt-3 text-center text-xs text-ink-muted"><Wind className="mr-1 inline h-3.5 w-3.5" aria-hidden />{data.breathingSessionsWeek} session(s), {data.breathingMinutesWeek} min this week</p>
            </Panel>
            <Panel title="Hydration">
              <p className="flex items-baseline gap-2"><Droplets className="h-5 w-5 text-accent" aria-hidden />
                <span className="font-mono text-2xl">{data.hydrationTodayMl.toFixed(0)}</span><span className="text-sm text-ink-muted">/ {data.hydrationTargetMl.toFixed(0)} mL today</span></p>
              <div className="my-2 h-2 overflow-hidden rounded-full bg-space-700"><div className="h-full bg-accent" style={{ width: `${Math.min(100, (100 * data.hydrationTodayMl) / data.hydrationTargetMl)}%` }} /></div>
              <div className="mb-3 flex gap-2">
                {[250, 500].map((ml) => (
                  <Button key={ml} variant="ghost" disabled={log.isPending} onClick={() => log.mutate({ kind: 'fluid', amount: ml })}>+ {ml} mL</Button>
                ))}
              </div>
              <Bars days={data.hydrationDays.map((d) => ({ day: d.day, value: d.value ?? null }))} target={data.hydrationTargetMl} unit="mL" />
            </Panel>
            <Panel title="Exercise plan">
              <div className="flex items-center gap-4">
                <Ring value={data.exerciseSessionsWeek ?? 0} goal={data.exerciseTarget ?? 5} label="Resistance sessions this week" />
                <div className="text-sm">
                  <p className="flex items-center gap-1 font-medium"><Dumbbell className="h-4 w-4 text-accent" aria-hidden /> Resistance sessions</p>
                  <p className="text-ink-muted">Target {data.exerciseTarget ?? 5} per week to protect bones and muscles.</p>
                  {data.strengthIndex != null && <p className="mt-1 text-ink-muted">Strength: {data.strengthIndex.toFixed(0)} % of pre-flight</p>}
                </div>
              </div>
            </Panel>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Sleep routine">
              <p className="mb-2 flex items-center gap-1 text-sm"><Moon className="h-4 w-4 text-accent" aria-hidden />
                Your normal: {data.sleepNormalHours != null ? `${data.sleepNormalHours.toFixed(1)} h` : '—'} · aim for at least 7 h</p>
              <Bars days={data.sleepDays.map((d) => ({ day: d.day, value: d.value ?? null }))} target={7} unit="h" />
              <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
                <li>Keep fixed sleep and wake times, even on rest days.</li>
                <li>Dim lights and screens 30 minutes before your sleep period.</li>
                <li>No caffeine in the 6 hours before sleep; try the breathing exercise to wind down.</li>
              </ul>
            </Panel>
            <Panel title="Wellness missions">
              <ul className="space-y-3">
                {data.missions.map((m) => (
                  <li key={m.id}>
                    <p className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-1 font-medium">{m.done ? <Trophy className="h-4 w-4 text-status-green" aria-hidden /> : null}{m.title}</span>
                      <span className="font-mono text-xs text-ink-muted">{m.progress}/{m.goal} {m.unit}{m.streak ? <span className="ml-2 inline-flex items-center gap-0.5 text-accent"><Flame className="h-3.5 w-3.5" aria-hidden />{m.streak}-day streak</span> : null}</span>
                    </p>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-space-700"><div className={`h-full ${m.done ? 'bg-status-green' : 'bg-accent'}`} style={{ width: `${Math.min(100, (100 * m.progress) / m.goal)}%` }} /></div>
                    <p className="mt-0.5 text-xs text-ink-muted">{m.description}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}
