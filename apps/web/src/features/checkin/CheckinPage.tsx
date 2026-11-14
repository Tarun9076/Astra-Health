import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, Timer } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorNote, Panel } from '../../components/ui/Panel'
import { SeverityBadge } from '../../components/ui/Status'
import { type CheckinIn, type CheckinOut, type VitalIn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { sendOrQueue } from '../../lib/outbox'

const STEPS = ['Sleep', 'How you feel', 'Vitals', 'Review'] as const
const TARGET_SECONDS = 60

type Scores = { sleepHours: number; sleepQuality: number; mood: number; stress: number; fatigue: number }
type Vitals = { restingHr: string; bpSys: string; bpDia: string; bodyTemp: string; spo2: string }

function Slider({ label, value, onChange, min, max, step = 1, low, high, format }: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  low: string
  high: string
  format?: (v: number) => string
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-3xl font-semibold text-accent">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        className="big-range mt-3 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={format ? format(value) : String(value)}
      />
      <span className="mt-1 flex justify-between text-xs text-ink-muted">
        <span>{low}</span>
        <span>{high}</span>
      </span>
    </label>
  )
}

function NumberField({ label, unit, value, onChange, min, max, step = 1 }: {
  label: string
  unit: string
  value: string
  onChange: (v: string) => void
  min: number
  max: number
  step?: number
}) {
  return (
    <label className="block text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="mt-1 flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="skip"
          className="block min-h-12 w-full rounded-lg border border-space-600 bg-space-900 px-3 font-mono text-lg outline-none focus:border-accent"
        />
        <span className="w-12 text-xs text-ink-muted">{unit}</span>
      </span>
    </label>
  )
}

function useElapsedSeconds(running: boolean): number {
  const startedAt = useRef<number | null>(null)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) return
    startedAt.current ??= Date.now()
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - (startedAt.current ?? Date.now())) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [running])
  return seconds
}

export function CheckinPage() {
  const user = useAuth((s) => s.user)
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [scores, setScores] = useState<Scores>({ sleepHours: 7, sleepQuality: 7, mood: 7, stress: 3, fatigue: 3 })
  const [vitals, setVitals] = useState<Vitals>({ restingHr: '', bpSys: '', bpDia: '', bodyTemp: '', spo2: '' })
  const [note, setNote] = useState('')

  const [clientId] = useState(() => crypto.randomUUID())
  const submit = useMutation({
    // Offline-first: if the habitat server is unreachable the check-in is kept on this device and
    // sent later with the same id, so it is never stored twice.
    mutationFn: (body: CheckinIn) => sendOrQueue<CheckinOut>('/api/checkins', { ...body, id: clientId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      void queryClient.invalidateQueries({ queryKey: ['alerts'] })
    },
  })
  const seconds = useElapsedSeconds(!submit.isSuccess)

  const vitalList = useMemo(() => {
    const fields: [VitalIn['indicator'], string, string][] = [
      ['resting_hr', vitals.restingHr, 'bpm'],
      ['bp_sys', vitals.bpSys, 'mmHg'],
      ['bp_dia', vitals.bpDia, 'mmHg'],
      ['body_temp', vitals.bodyTemp, '°C'],
      ['spo2', vitals.spo2, '%'],
    ]
    return fields
      .filter(([, raw]) => raw.trim() !== '' && Number.isFinite(Number(raw)))
      .map(([indicator, raw, unit]): VitalIn => ({ indicator, value: Number(raw), unit }))
  }, [vitals])

  const bpIncomplete = (vitals.bpSys === '') !== (vitals.bpDia === '')

  if (submit.isSuccess && submit.data.queued) return <SavedOffline />
  if (submit.isSuccess && !submit.data.queued) return <Result result={submit.data.data} seconds={seconds} />

  const set = (k: keyof Scores) => (v: number) => setScores((s) => ({ ...s, [k]: v }))
  const setV = (k: keyof Vitals) => (v: string) => setVitals((s) => ({ ...s, [k]: v }))
  const body: CheckinIn = {
    ...scores,
    vitals: vitalList,
    privateNote: note.trim() || null,
    completedInSeconds: seconds,
  }

  const pages: ReactNode[] = [
    <div key="sleep" className="space-y-8">
      <Slider label="Hours slept last night" value={scores.sleepHours} onChange={set('sleepHours')} min={0} max={12}
        step={0.25} low="0 h" high="12 h" format={(v) => `${v.toFixed(2).replace(/\.?0+$/, '')} h`} />
      <Slider label="Sleep quality" value={scores.sleepQuality} onChange={set('sleepQuality')} min={1} max={10}
        low="1 · very poor" high="10 · excellent" />
    </div>,
    <div key="feel" className="space-y-8">
      <Slider label="Mood" value={scores.mood} onChange={set('mood')} min={1} max={10} low="1 · very low" high="10 · great" />
      <Slider label="Stress" value={scores.stress} onChange={set('stress')} min={1} max={10} low="1 · calm" high="10 · extreme" />
      <Slider label="Fatigue" value={scores.fatigue} onChange={set('fatigue')} min={1} max={10} low="1 · fresh" high="10 · exhausted" />
    </div>,
    <div key="vitals" className="space-y-4">
      <p className="text-sm text-ink-muted">Optional. Enter what you measured this morning; leave the rest empty.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField label="Resting heart rate" unit="bpm" value={vitals.restingHr} onChange={setV('restingHr')} min={30} max={150} />
        <NumberField label="Temperature" unit="°C" value={vitals.bodyTemp} onChange={setV('bodyTemp')} min={30} max={43} step={0.1} />
        <NumberField label="Blood pressure — systolic" unit="mmHg" value={vitals.bpSys} onChange={setV('bpSys')} min={60} max={260} />
        <NumberField label="Blood pressure — diastolic" unit="mmHg" value={vitals.bpDia} onChange={setV('bpDia')} min={30} max={160} />
        <NumberField label="Oxygen saturation" unit="%" value={vitals.spo2} onChange={setV('spo2')} min={50} max={100} />
      </div>
      {bpIncomplete && <p className="text-sm text-status-yellow">Enter both blood-pressure numbers, or neither.</p>}
    </div>,
    <div key="review" className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Item k="Sleep" v={`${scores.sleepHours} h · quality ${scores.sleepQuality}/10`} />
        <Item k="Mood" v={`${scores.mood}/10`} />
        <Item k="Stress" v={`${scores.stress}/10`} />
        <Item k="Fatigue" v={`${scores.fatigue}/10`} />
        {vitalList.map((v) => (
          <Item key={v.indicator} k={v.indicator.replace('_', ' ')} v={`${v.value} ${v.unit}`} />
        ))}
      </dl>
      <label className="block text-sm">
        <span className="text-ink-muted">Private note (only you can see this)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2}
          className="mt-1 block w-full rounded-lg border border-space-600 bg-space-900 p-3 outline-none focus:border-accent" />
      </label>
      {submit.isError && <ErrorNote error={submit.error} />}
    </div>,
  ]

  const last = step === STEPS.length - 1
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Daily check-in</h1>
          <p className="text-sm text-ink-muted">{user?.displayName} · step {step + 1} of {STEPS.length}: {STEPS[step]}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-sm ${
          seconds <= TARGET_SECONDS ? 'border-space-600 text-ink' : 'border-status-yellow/50 text-status-yellow'}`}>
          <Timer className="h-4 w-4" aria-hidden /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          <span className="text-ink-muted">/ 1:00</span>
        </span>
      </div>
      <ol className="grid grid-cols-4 gap-2" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className={`h-1.5 rounded-full ${i <= step ? 'bg-accent' : 'bg-space-700'}`} aria-current={i === step ? 'step' : undefined} />
        ))}
      </ol>
      <Panel>{pages[step]}</Panel>
      <div className="flex justify-between gap-3">
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0 || submit.isPending}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Button>
        {last ? (
          <Button onClick={() => submit.mutate(body)} disabled={submit.isPending || bpIncomplete}>
            <Check className="h-4 w-4" aria-hidden /> {submit.isPending ? 'Saving…' : 'Submit check-in'}
          </Button>
        ) : (
          <Button onClick={() => setStep((s) => s + 1)} disabled={step === 2 && bpIncomplete}>
            Next <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted capitalize">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  )
}

function Result({ result, seconds }: { result: CheckinOut; seconds: number }) {
  const alerts = [...result.newAlerts, ...result.updatedAlerts]
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Panel>
        <p className="flex items-center gap-2 text-lg font-semibold text-status-green">
          <Check className="h-5 w-5" aria-hidden /> Check-in saved in {seconds} s
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          {result.accepted} readings recorded and compared with your personal normal.
          {result.rejected.length > 0 && ` ${result.rejected.length} value(s) were rejected as implausible or inconsistent.`}
        </p>
      </Panel>
      {alerts.length > 0 ? (
        <Panel title={result.newAlerts.length ? 'New findings' : 'Updated findings'}>
          <ul className="space-y-3">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-start gap-3">
                <SeverityBadge severity={a.severity} />
                <div>
                  <p className="font-medium">{a.title}</p>
                  <p className="text-sm text-ink-muted">{a.reason}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <Panel>
          <p className="text-sm">No concerning changes compared with your normal. Keep it up.</p>
        </Panel>
      )}
      <div className="flex flex-wrap gap-3">
        <Link to="/astronaut/overview"><Button>Go to overview</Button></Link>
        {alerts.length > 0 && <Link to="/astronaut/alerts"><Button variant="ghost">Open Alerts Center</Button></Link>}
      </div>
    </div>
  )
}

function SavedOffline() {
  return (
    <div className="max-w-xl space-y-4">
      <Panel>
        <p className="text-lg font-semibold">Check-in saved on this device</p>
        <p className="mt-2 text-sm text-ink-muted">
          The habitat server can't be reached right now. Your answers are stored on this tablet and will be sent
          automatically as soon as it is back; any alerts are raised then.
        </p>
      </Panel>
    </div>
  )
}
