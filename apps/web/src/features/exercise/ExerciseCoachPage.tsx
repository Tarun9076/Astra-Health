import { useQueryClient } from '@tanstack/react-query'
import {
  Camera, CheckCircle2, Clapperboard, Dumbbell, HeartPulse, Lock, MonitorPlay, Moon, RotateCcw, SkipForward, Square, Volume2, VolumeX,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, ErrorNote, LinkButton, Loading, Panel } from '../../components/ui/Panel'
import type { ExercisePlan, ExerciseSession, ExerciseSessionIn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { sendOrQueue } from '../../lib/outbox'
import { useExercisePlan } from '../../lib/queries'
import { useNow } from '../../lib/useNow'
import { liveBpm, useWatch } from '../../lib/watch'
import { spoken, TIPS, Workout, type CoachEvent, type CoachState, type ExerciseId, type ExerciseSummary, type PlanItem } from './coach'
import { BONES, toBody, type Landmark } from './pose'
import { cameraError, loadPoseLandmarker } from './poseEngine'
import { DemoPerson } from './synthetic'
import { SessionList } from './SessionList'

type Source = 'camera' | 'demo'

const LEVEL: Record<ExercisePlan['level'], string> = {
  standard: 'Standard plan',
  lighter: 'Lighter today',
  more: 'Extra strength work',
  adjusted: 'Adjusted today',
  rest: 'Rest day',
}

const VOICE_KEY = 'astra-coach-voice'
const DEMO_STEP = 1000 / 30

function readVoice(): boolean {
  try {
    return localStorage.getItem(VOICE_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Wellness → Exercise coach (Step 13): today's plan, then a coached workout with the camera. */
export function ExerciseCoachPage() {
  const code = useAuth((s) => s.user?.astronautCode)
  const plan = useExercisePlan(code)
  const [params] = useSearchParams()
  const speed = Math.max(1, Math.min(20, Number(params.get('speed')) || 1)) // demo playback speed (rehearsals, tests)
  const [run, setRun] = useState<{ source: Source; startedAt: Date; key: number } | null>(null)
  const [done, setDone] = useState<{ source: Source; startedAt: Date; finishedAt: Date; results: ExerciseSummary[] } | null>(null)

  if (plan.isPending) return <Loading label="Loading today’s plan…" />
  if (plan.error) return <ErrorNote error={plan.error} />
  const data = plan.data
  const items: PlanItem[] = data.items.map((i) => ({ exercise: i.exercise as ExerciseId, name: i.name, sets: i.sets, reps: i.reps }))

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <p className="text-sm"><Link to="/astronaut/wellness#activity" className="text-accent hover:underline">← Wellness</Link></p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Exercise coach</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Today’s resistance plan, adjusted to how you are. The coach watches through the camera, counts your reps and sets, and gives
          posture tips out loud.
        </p>
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-subtle px-3 py-1 text-xs text-ink-muted">
          <Lock className="h-3.5 w-3.5" aria-hidden /> The video stays on this device. Only counts and form scores are saved.
        </p>
      </header>

      {done ? (
        <WorkoutSummary {...done} level={data.level} onAgain={() => setDone(null)} />
      ) : run ? (
        <WorkoutView key={run.key} items={items} restSeconds={data.restSeconds} source={run.source} speed={run.source === 'demo' ? speed : 1}
          onStop={() => setRun(null)}
          onSwitchToDemo={() => setRun({ source: 'demo', startedAt: new Date(), key: run.key + 1 })}
          onFinish={(results) => {
            setDone({ source: run.source, startedAt: run.startedAt, finishedAt: new Date(), results })
            setRun(null)
          }} />
      ) : (
        <PlanView plan={data} onStart={(source) => setRun({ source, startedAt: new Date(), key: Date.now() })} />
      )}
    </div>
  )
}

function PlanView({ plan, onStart }: { plan: ExercisePlan; onStart: (source: Source) => void }) {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Today’s plan" className="lg:col-span-2"
          action={<span className={`rounded-full px-3 py-1 text-xs font-semibold ${plan.restDay ? 'bg-status-yellow/15 text-status-yellow' : 'bg-accent/10 text-accent'}`}>{LEVEL[plan.level]}</span>}>
          {plan.adjustments.length > 0 && (
            <ul className="mb-4 space-y-2">
              {plan.adjustments.map((a) => (
                <li key={a.id} className="rounded-lg border border-line bg-subtle px-3 py-2 text-sm">
                  {a.reason}
                  {a.because.length > 0 && <span className="mt-0.5 block text-xs text-ink-muted">Because of: {a.because.join(', ')}</span>}
                </li>
              ))}
            </ul>
          )}
          {plan.restDay ? (
            <div className="flex items-start gap-3 text-sm">
              <Moon className="mt-0.5 h-5 w-5 shrink-0 text-status-yellow" aria-hidden />
              <div>
                <p className="font-medium">No resistance exercise today.</p>
                <p className="text-ink-muted">Rest, drink well and follow your guidance. The plan comes back when the alert is resolved.</p>
                <LinkButton to="/astronaut/guidance" variant="ghost" className="mt-3">Open my guidance</LinkButton>
              </div>
            </div>
          ) : (
            <>
              <ol className="divide-y divide-line">
                {plan.items.map((i, n) => (
                  <li key={i.exercise} className="flex gap-4 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">{n + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-semibold">{i.name}</span>
                        <span className="text-sm font-medium">{i.sets} sets × {i.reps} reps</span>
                      </p>
                      <p className="mt-0.5 text-sm">{i.howTo}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">{i.loads} In flight: on the {i.device}.</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-sm text-ink-muted">Rest {plan.restSeconds} s between sets.</p>
            </>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="This week">
            <p className="text-3xl font-semibold">{plan.sessionsWeek ?? 0}<span className="ml-1 text-base font-normal text-ink-muted">of {plan.targetPerWeek ?? 5} sessions</span></p>
            <p className="mt-1 text-sm text-ink-muted">{plan.doneToday > 0 ? `Done today: ${plan.doneToday} session${plan.doneToday > 1 ? 's' : ''}.` : 'Nothing recorded today yet.'}</p>
          </Panel>
          {!plan.restDay && (
            <Panel title="Before you start">
              <ul className="list-disc space-y-1 pl-5 text-sm">
                <li>Put the laptop 2–3 m away, at hip height.</li>
                <li>Stand <strong>side-on</strong> to the camera: your whole body, head to feet, in the picture.</li>
                <li>Good light from the front; nobody else in view.</li>
                <li>Stop if anything hurts, and tell the flight surgeon.</li>
              </ul>
              <div className="mt-4 grid gap-2">
                <Button onClick={() => onStart('camera')}><Camera className="h-4 w-4" aria-hidden /> Start with the camera</Button>
                <Button variant="ghost" onClick={() => onStart('demo')}>
                  <MonitorPlay className="h-4 w-4" aria-hidden /> Demo playback (simulated person)
                </Button>
              </div>
              <p className="mt-2 text-xs text-ink-muted">Demo playback is for rehearsals: a simulated person does the plan with a few mistakes. It is saved as simulated data.</p>
            </Panel>
          )}
        </div>
      </div>

      <Panel title="Recent sessions">
        <SessionList sessions={plan.recent} empty="No coached sessions yet." />
      </Panel>
      <p className="text-xs text-ink-muted">{plan.disclaimer} The coach gives general posture tips; it is not a medical device.</p>
    </>
  )
}

// --- the workout ------------------------------------------------------------------------------

const keyOf = (s: CoachState) =>
  [s.state, s.exerciseIndex, s.set, s.reps, s.restLeft, s.lastTips.join(','), s.setScore, s.frame?.phase, Math.round((s.frame?.progress ?? 0) * 20)].join('|')

function WorkoutView({ items, restSeconds, source, speed, onFinish, onStop, onSwitchToDemo }: {
  items: PlanItem[]
  restSeconds: number
  source: Source
  speed: number
  onFinish: (results: ExerciseSummary[]) => void
  onStop: () => void
  onSwitchToDemo: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [workout] = useState(() => new Workout(items, restSeconds))
  const clock = useRef({ t0: 0, speed })
  const [status, setStatus] = useState<{ kind: 'starting' | 'running' | 'error'; text: string }>({
    kind: source === 'camera' ? 'starting' : 'running',
    text: source === 'camera' ? 'Starting the camera…' : '',
  })
  const [snap, setSnap] = useState<CoachState>(() => workout.snapshot(0))
  const [message, setMessage] = useState('Get into position.')
  const [aspect, setAspect] = useState(16 / 9)
  const [voice, setVoice] = useState(readVoice)
  const voiceRef = useRef(voice)
  const finish = useRef(onFinish)
  const finished = useRef(false)
  useEffect(() => {
    finish.current = (results) => {
      if (finished.current) return
      finished.current = true
      onFinish(results)
    }
  }, [onFinish])

  useEffect(() => {
    voiceRef.current = voice
    try {
      localStorage.setItem(VOICE_KEY, voice ? 'on' : 'off')
    } catch {
      /* private window: not remembered */
    }
    if (!voice && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [voice])

  const sim = useRef(0) // demo playback: the simulated person's own clock (ms)
  const now = () => (source === 'demo' ? sim.current : (performance.now() - clock.current.t0) * clock.current.speed)

  const handle = (events: CoachEvent[]) => {
    for (const e of events) {
      const text = spoken(e)
      if (!text) continue
      setMessage(text)
      if (voiceRef.current && 'speechSynthesis' in window) {
        if (e.kind === 'rep') window.speechSynthesis.cancel() // keep the count current
        const u = new SpeechSynthesisUtterance(text)
        u.rate = 1.05
        window.speechSynthesis.speak(u)
      }
    }
  }
  const act = (events: CoachEvent[]) => {
    handle(events)
    const s = workout.snapshot(now())
    setSnap(s)
    if (s.state === 'done') finish.current(workout.summary())
  }

  useEffect(() => {
    let raf = 0
    let stopped = false
    let stream: MediaStream | null = null
    let lastKey = ''
    let lastVideoTime = -1
    let lastDemo: Landmark[] | null = null
    const person = new DemoPerson({ aspect: 16 / 9 })
    clock.current = { t0: performance.now(), speed }

    const loop = (landmarker: import('@mediapipe/tasks-vision').PoseLandmarker | null) => {
      const tick = () => {
        if (stopped) return
        const t = (performance.now() - clock.current.t0) * clock.current.speed
        let points: Landmark[] | null = null
        let ratio = 16 / 9
        let fresh = true
        if (landmarker) {
          const video = videoRef.current!
          fresh = video.readyState >= 2 && video.currentTime !== lastVideoTime
          if (fresh) {
            lastVideoTime = video.currentTime
            points = landmarker.detectForVideo(video, performance.now()).landmarks[0] ?? null
            ratio = video.videoWidth / video.videoHeight || 16 / 9
          }
        } else {
          // the simulated person moves in fixed 1/30 s steps of its own time, so a slow screen or a
          // higher playback speed never skips the bottom of a rep
          const target = Math.min(t, sim.current + 600 * DEMO_STEP)
          while (sim.current + DEMO_STEP <= target) {
            sim.current += DEMO_STEP
            const s = workout.snapshot(sim.current)
            points = person.pose(sim.current, s.item?.exercise ?? null, s.state === 'active')
            handle(workout.update(toBody(points, ratio), sim.current, ratio))
          }
          if (points) lastDemo = points
          else points = lastDemo // no step due yet: draw the last position again
          clock.current.t0 = performance.now() - sim.current / clock.current.speed // stay in step after a pause
        }
        if (fresh) {
          if (landmarker) handle(workout.update(points ? toBody(points, ratio) : null, t, ratio))
          const s = workout.snapshot(landmarker ? t : sim.current)
          draw(canvasRef.current, points, s.frame?.watch ?? [], !landmarker)
          const key = keyOf(s)
          if (key !== lastKey) {
            lastKey = key
            setSnap(s)
          }
          if (s.state === 'done') {
            finish.current(workout.summary())
            return
          }
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    if (source === 'demo') {
      loop(null)
    } else {
      void (async () => {
        let stage: 'camera' | 'tracking' = 'camera'
        try {
          if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('no camera API', 'NotFoundError')
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
          if (stopped) return
          const video = videoRef.current!
          video.srcObject = stream
          await video.play()
          setAspect(video.videoWidth / video.videoHeight || 16 / 9)
          stage = 'tracking'
          setStatus({ kind: 'starting', text: 'Loading body tracking (the first time takes a few seconds)…' })
          const landmarker = await loadPoseLandmarker()
          if (stopped) return
          setStatus({ kind: 'running', text: '' })
          clock.current = { t0: performance.now(), speed: 1 }
          loop(landmarker)
        } catch (e) {
          if (!stopped) setStatus({ kind: 'error', text: cameraError(e, stage) })
        }
      })()
    }
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((track) => track.stop())
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    }
    // the workout runs once per mount (the parent remounts it with a new key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const item = snap.item
  const frame = snap.frame
  const resting = snap.state === 'rest'
  const hidden = frame?.phase === 'hidden'

  if (status.kind === 'error') {
    return (
      <Panel title="Camera">
        <p role="alert" className="text-sm">{status.text}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={onStop} variant="ghost"><RotateCcw className="h-4 w-4" aria-hidden /> Back to the plan</Button>
          <Button onClick={onSwitchToDemo}><MonitorPlay className="h-4 w-4" aria-hidden /> Use demo playback</Button>
        </div>
      </Panel>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-label="Camera view" className="relative overflow-hidden rounded-xl border border-line bg-[#0b1020]" style={{ aspectRatio: source === 'camera' ? aspect : 16 / 9 }}>
        {source === 'camera' && <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />}
        <canvas ref={canvasRef} className={`absolute inset-0 h-full w-full ${source === 'camera' ? '-scale-x-100' : ''}`} aria-hidden />
        <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
          {source === 'camera'
            ? <><Camera className="h-3.5 w-3.5" aria-hidden /> Camera · stays on this device</>
            : <><Clapperboard className="h-3.5 w-3.5" aria-hidden /> Demo playback · simulated person{speed > 1 ? ` · ${speed}×` : ''}</>}
        </span>
        {status.kind === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white"><Loading label={status.text} /></div>
        )}
        {resting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-center text-white">
            <p className="text-sm uppercase tracking-wider text-white/70">Rest</p>
            <p className="text-6xl font-semibold tabular-nums" aria-hidden>{Math.floor(snap.restLeft / 60)}:{String(snap.restLeft % 60).padStart(2, '0')}</p>
            {snap.next && <p className="mt-2 text-sm">Next: {snap.next}</p>}
          </div>
        )}
        {hidden && !resting && status.kind === 'running' && (
          <p className="absolute inset-x-3 bottom-3 rounded-lg bg-status-yellow/90 px-3 py-2 text-center text-sm font-medium text-black">{TIPS.step_back}</p>
        )}
      </section>

      <aside className="space-y-4" aria-label="Coach">
        <Panel title={item ? item.name : 'Workout'}>
          {item && (
            <>
              <p className="text-sm text-ink-muted">Set {snap.set} of {item.sets}</p>
              <p className="mt-1 text-5xl font-semibold tabular-nums" aria-label={`${snap.reps} of ${item.reps} reps`}>
                {snap.reps}<span className="text-2xl font-normal text-ink-muted"> / {item.reps}</span>
              </p>
              <div className="mt-3">
                <p className="mb-1 flex justify-between text-xs text-ink-muted">
                  <span>{item.exercise === 'heel_raise' ? 'Heel lift' : 'Depth'}</span>
                  <span>{snap.setScore != null ? `Form this set: ${snap.setScore}%` : ''}</span>
                </p>
                <div className="h-2 overflow-hidden rounded-full bg-subtle" aria-hidden>
                  <div className={`h-full rounded-full transition-[width] duration-100 ${(frame?.progress ?? 0) >= 1 ? 'bg-status-green' : 'bg-accent'}`}
                    style={{ width: `${Math.round((frame?.progress ?? 0) * 100)}%` }} />
                </div>
              </div>
              <WatchHeartRate />
            </>
          )}
          <p className="mt-4 min-h-12 rounded-lg bg-subtle px-3 py-2 text-sm" role="status" aria-live="polite" aria-label="Coach says">{message}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {resting
              ? <Button variant="ghost" onClick={() => act(workout.skipRest(now()))}><SkipForward className="h-4 w-4" aria-hidden /> Skip rest</Button>
              : <Button variant="ghost" onClick={() => act(workout.finishSet(now()))} disabled={status.kind !== 'running'}>Finish set</Button>}
            <Button variant="ghost" aria-pressed={voice} onClick={() => setVoice((v) => !v)}>
              {voice ? <Volume2 className="h-4 w-4" aria-hidden /> : <VolumeX className="h-4 w-4" aria-hidden />} Voice
            </Button>
          </div>
          <Button variant="ghost" className="mt-2 w-full" onClick={() => act(workout.end(now()))}>
            <Square className="h-4 w-4" aria-hidden /> End workout
          </Button>
        </Panel>
        <Panel title="Plan">
          <ol className="space-y-1 text-sm">
            {items.map((i, n) => (
              <li key={i.exercise} className={`flex items-center justify-between gap-2 ${n === snap.exerciseIndex ? 'font-semibold' : n < snap.exerciseIndex ? 'text-ink-muted' : ''}`}>
                <span className="flex items-center gap-1.5">
                  {n < snap.exerciseIndex ? <CheckCircle2 className="h-4 w-4 text-status-green" aria-label="done" /> : <Dumbbell className="h-4 w-4 text-ink-muted" aria-hidden />}
                  {i.name}
                </span>
                <span className="text-ink-muted">{i.sets} × {i.reps}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </aside>
    </div>
  )
}

/** Body points and bones over the picture; joints with a tip are drawn larger, in amber. */
function draw(canvas: HTMLCanvasElement | null, points: Landmark[] | null, watch: number[], demo: boolean) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  if (demo) {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, '#16203a')
    g.addColorStop(1, '#0b1020')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    ctx.moveTo(0, 0.935 * h)
    ctx.lineTo(w, 0.935 * h)
    ctx.stroke()
  }
  if (!points) return
  const seen = (i: number) => (points[i]?.visibility ?? 0) > 0.5
  ctx.lineCap = 'round'
  ctx.lineWidth = (demo ? 9 : 4) * dpr
  ctx.strokeStyle = demo ? 'rgba(125, 211, 252, 0.9)' : 'rgba(255, 255, 255, 0.85)'
  for (const [a, b] of BONES) {
    if (!seen(a) || !seen(b)) continue
    ctx.beginPath()
    ctx.moveTo(points[a].x * w, points[a].y * h)
    ctx.lineTo(points[b].x * w, points[b].y * h)
    ctx.stroke()
  }
  if (demo && seen(0)) {
    ctx.fillStyle = 'rgba(125, 211, 252, 0.9)'
    ctx.beginPath()
    ctx.arc(points[0].x * w - 0.01 * w, points[0].y * h, 0.045 * h, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = 11; i < 33; i++) {
    if (!seen(i) || (i >= 17 && i <= 22)) continue
    const flagged = watch.includes(i)
    ctx.fillStyle = flagged ? '#f59e0b' : demo ? '#e0f2fe' : '#22d3ee'
    ctx.beginPath()
    ctx.arc(points[i].x * w, points[i].y * h, (flagged ? 9 : 4.5) * dpr, 0, Math.PI * 2)
    ctx.fill()
  }
}

// --- after the workout -------------------------------------------------------------------------

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `ex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function WorkoutSummary({ source, startedAt, finishedAt, results, level, onAgain }: {
  source: Source
  startedAt: Date
  finishedAt: Date
  results: ExerciseSummary[]
  level: ExercisePlan['level']
  onAgain: () => void
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<{ kind: 'saving' } | { kind: 'saved'; session: ExerciseSession } | { kind: 'queued' } | { kind: 'error'; error: unknown } | { kind: 'empty' }>(
    results.length ? { kind: 'saving' } : { kind: 'empty' },
  )
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current || !results.length) return
    sent.current = true
    const body: ExerciseSessionIn = {
      id: newId(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      source,
      planLevel: level,
      exercises: results.map((r) => ({ exercise: r.exercise, sets: r.sets, tips: r.tips })),
    }
    sendOrQueue<ExerciseSession>('/api/exercise/sessions', body)
      .then((out) => {
        setState(out.queued ? { kind: 'queued' } : { kind: 'saved', session: out.data })
        for (const key of ['exercise-plan', 'exercise-sessions', 'wellness-center', 'dashboard', 'progress', 'guidance']) {
          void queryClient.invalidateQueries({ queryKey: [key] })
        }
      })
      .catch((error: unknown) => setState({ kind: 'error', error }))
  }, [finishedAt, level, queryClient, results, source, startedAt])

  const reps = results.reduce((sum, r) => sum + r.sets.reduce((s, x) => s + x.reps, 0), 0)
  return (
    <div className="space-y-4">
      <Panel title="Workout complete">
        {state.kind === 'saving' && <Loading label="Saving…" />}
        {state.kind === 'saved' && (
          <p className="flex items-start gap-2 text-sm" role="status">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-green" aria-hidden />
            <span><strong>Saved.</strong> {state.session.summary} It goes to the flight surgeon with the next link pass.</span>
          </p>
        )}
        {state.kind === 'queued' && (
          <p className="text-sm" role="status">Saved on this device: the Habitat server is not reachable. It is sent automatically when it is back.</p>
        )}
        {state.kind === 'empty' && <p className="text-sm" role="status">No reps were counted, so there is nothing to save.</p>}
        {state.kind === 'error' && <ErrorNote error={state.error} />}
        {source === 'demo' && <p className="mt-2 text-xs text-ink-muted">Demo playback: saved as simulated data.</p>}

        {results.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Sets, reps and form by exercise ({reps} reps in total)</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-muted">
                  <th scope="col" className="py-2 pr-3">Exercise</th>
                  <th scope="col" className="py-2 pr-3">Sets (reps of planned)</th>
                  <th scope="col" className="py-2">Form</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const scored = r.sets.filter((s) => s.formScore != null)
                  const form = scored.length ? Math.round(scored.reduce((a, s) => a + (s.formScore ?? 0) * s.reps, 0) / Math.max(1, scored.reduce((a, s) => a + s.reps, 0))) : null
                  return (
                    <tr key={r.exercise} className="border-b border-line align-top">
                      <th scope="row" className="py-2 pr-3 font-medium">{r.name}</th>
                      <td className="py-2 pr-3">{r.sets.map((s) => `${s.reps}/${s.target}`).join(' · ')}</td>
                      <td className="py-2">{form != null ? `${form}%` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {results.some((r) => r.tips.length) && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Tips for next time</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
              {results.flatMap((r) => r.tips.map((t) => <li key={`${r.exercise}-${t.tip}`}>{r.name}: {t.tip} <span className="text-ink-muted">({t.count}×)</span></li>))}
            </ul>
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={onAgain}><RotateCcw className="h-4 w-4" aria-hidden /> Back to the plan</Button>
          <LinkButton to="/astronaut/wellness" variant="ghost">Wellness</LinkButton>
        </div>
      </Panel>
    </div>
  )
}

/** Live heart rate from the astronaut's watch during the workout (Step 15); hidden without a watch. */
function WatchHeartRate() {
  const watch = useWatch()
  const now = useNow(2000)
  const bpm = liveBpm(watch, now)
  if (bpm == null) return null
  return (
    <p className="mt-3 flex items-center gap-2 text-sm" aria-live="off">
      <HeartPulse className="h-4 w-4 text-status-red motion-safe:animate-pulse" aria-hidden />
      Heart rate <span className="font-semibold tabular-nums">{bpm} bpm</span>
      <span className="text-ink-muted">· your watch</span>
    </p>
  )
}
