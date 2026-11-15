import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Camera, Check, Clock, Flame, Info, Pencil, RotateCcw, ShieldAlert, Timer, TriangleAlert, Watch } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PhotoCapture, type DraftPhoto } from '../../components/health/PhotoCapture'
import { EmergencyProtocolCard } from '../../components/ui/EmergencyProtocolCard'
import { Button, ErrorNote, LinkButton, Panel } from '../../components/ui/Panel'
import { SeverityBadge } from '../../components/ui/Status'
import type { CheckinIn, CheckinOut, Photo, SymptomIn, SymptomOption, Vital, VitalIn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { infoFor } from '../../lib/indicators'
import { formatValue } from '../../lib/mission'
import { sendOrQueue } from '../../lib/outbox'
import { useDashboard, useProgress, useSymptomCatalog } from '../../lib/queries'
import { useNow } from '../../lib/useNow'

const TARGET_SECONDS = 120

// --- what is measured -----------------------------------------------------------------------------

type FieldKey = 'resting_hr' | 'bp_sys' | 'bp_dia' | 'body_temp' | 'spo2' | 'glucose' | 'body_weight'
type Field = { key: FieldKey; label: string; unit: string; min: number; max: number; step: number; dec: number }

const FIELDS: Record<FieldKey, Field> = {
  resting_hr: { key: 'resting_hr', label: 'Resting heart rate', unit: 'bpm', min: 30, max: 150, step: 1, dec: 0 },
  bp_sys: { key: 'bp_sys', label: 'Upper number (systolic)', unit: 'mmHg', min: 60, max: 260, step: 1, dec: 0 },
  bp_dia: { key: 'bp_dia', label: 'Lower number (diastolic)', unit: 'mmHg', min: 30, max: 160, step: 1, dec: 0 },
  body_temp: { key: 'body_temp', label: 'Temperature', unit: '°C', min: 30, max: 43, step: 0.1, dec: 1 },
  spo2: { key: 'spo2', label: 'Oxygen saturation', unit: '%', min: 50, max: 100, step: 1, dec: 0 },
  glucose: { key: 'glucose', label: 'Blood sugar', unit: 'mg/dL', min: 20, max: 600, step: 1, dec: 0 },
  body_weight: { key: 'body_weight', label: 'Body mass', unit: 'kg', min: 30, max: 200, step: 0.1, dec: 1 },
}

/** A group of fields measured together; skipping is per group and always explicit. */
type GroupKey = 'hr' | 'bp' | 'temp' | 'spo2' | 'glucose' | 'weight'
const GROUPS: Record<GroupKey, { label: string; fields: FieldKey[]; info: string }> = {
  hr: { label: 'Resting heart rate', fields: ['resting_hr'], info: 'resting_hr' },
  bp: { label: 'Blood pressure', fields: ['bp_sys', 'bp_dia'], info: 'bp_sys' },
  temp: { label: 'Body temperature', fields: ['body_temp'], info: 'body_temp' },
  spo2: { label: 'Oxygen saturation', fields: ['spo2'], info: 'spo2' },
  glucose: { label: 'Blood sugar', fields: ['glucose'], info: 'glucose' },
  weight: { label: 'Body mass', fields: ['body_weight'], info: 'body_weight' },
}
const GROUP_OF = Object.fromEntries(
  (Object.keys(GROUPS) as GroupKey[]).flatMap((g) => GROUPS[g].fields.map((f) => [f, g])),
) as Record<FieldKey, GroupKey>
/** The step where each group is entered (used by Review → Edit). */
const STEP_OF: Record<GroupKey, StepId> = { hr: 'hr', bp: 'bp', temp: 'temp', spo2: 'temp', glucose: 'metabolic', weight: 'metabolic' }

type StepId = 'hr' | 'bp' | 'temp' | 'metabolic' | 'sleep' | 'feel' | 'stress' | 'symptoms' | 'review'
const STEPS: { id: StepId; title: string }[] = [
  { id: 'hr', title: 'Heart rate' },
  { id: 'bp', title: 'Blood pressure' },
  { id: 'temp', title: 'Temperature and oxygen' },
  { id: 'metabolic', title: 'Blood sugar and body mass' },
  { id: 'sleep', title: 'Sleep' },
  { id: 'feel', title: 'Mood and energy' },
  { id: 'stress', title: 'Stress' },
  { id: 'symptoms', title: 'Symptoms' },
  { id: 'review', title: 'Review and send' },
]

type Scores = { sleepHours: number; sleepQuality: number; mood: number; stress: number; fatigue: number }
type Problem = { kind: 'error' | 'unusual' | 'safety'; text: string }

/** Validation: impossible values block; values far from the astronaut's normal ask to re-measure or confirm. */
function check(field: Field, raw: string, vital: Vital | undefined): Problem | null {
  if (raw.trim() === '') return null
  const v = Number(raw)
  if (!Number.isFinite(v)) return { kind: 'error', text: 'Enter a number.' }
  if (v < field.min || v > field.max) {
    return { kind: 'error', text: `${formatValue(v, field.dec)} ${field.unit} is outside the possible range (${field.min}–${field.max} ${field.unit}). Check the device and the unit, then measure again.` }
  }
  if (field.key === 'spo2' && v < 90) return { kind: 'safety', text: 'Below 90 % can be an emergency. If you feel short of breath, follow the low-oxygen procedure now.' }
  if (field.key === 'glucose' && v < 54) return { kind: 'safety', text: 'Very low blood sugar. Take 15 g of fast sugar now (juice or glucose tablets), tell the crew medical officer and follow the low blood sugar procedure.' }
  if (field.key === 'glucose' && v < 70) return { kind: 'safety', text: 'Low blood sugar. Take 15 g of fast sugar and measure again in 15 minutes. If you feel shaky, sweaty or confused, follow the low blood sugar procedure.' }
  if (field.key === 'glucose' && v >= 250) return { kind: 'safety', text: 'Very high blood sugar. Wash and dry your finger and measure again. If it stays above 250 mg/dL, tell the crew medical officer.' }
  if (field.key === 'body_temp' && v >= 39.5) return { kind: 'safety', text: 'This is a high fever. Tell the crew medical officer after sending.' }
  if (vital?.baseline != null && vital.sigma) {
    const z = (v - vital.baseline) / vital.sigma
    if (Math.abs(z) >= 3) {
      return { kind: 'unusual', text: `This is much ${z > 0 ? 'higher' : 'lower'} than your normal (${formatValue(vital.baseline, field.dec)} ${field.unit}). If it is correct, keep it — otherwise measure again.` }
    }
  }
  return null
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

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()
const fromDevice = (v: Vital | undefined) => v != null && v.source !== 'Manual' && isToday(v.measuredAt)

// --- page -----------------------------------------------------------------------------------------

export function CheckinPage() {
  const user = useAuth((s) => s.user)
  const queryClient = useQueryClient()
  const dashboard = useDashboard(user?.astronautCode)
  const catalog = useSymptomCatalog()
  const vitals = useMemo(
    () => Object.fromEntries((dashboard.data?.vitals ?? []).map((v) => [v.indicator, v])) as Record<string, Vital | undefined>,
    [dashboard.data],
  )

  const [step, setStep] = useState(0)
  const [values, setValues] = useState<Record<FieldKey, string>>({ resting_hr: '', bp_sys: '', bp_dia: '', body_temp: '', spo2: '', glucose: '', body_weight: '' })
  const [skipped, setSkipped] = useState<Set<GroupKey>>(new Set())
  const [confirmed, setConfirmed] = useState<Set<FieldKey>>(new Set())
  const [useWearableHr, setUseWearableHr] = useState(false)
  const [scores, setScores] = useState<Scores>({ sleepHours: 7, sleepQuality: 7, mood: 7, stress: 3, fatigue: 3 })
  const [symptoms, setSymptoms] = useState<Record<string, { severity: number; note: string }>>({})
  const [noSymptoms, setNoSymptoms] = useState(false)
  const [note, setNote] = useState('')
  const [photos, setPhotos] = useState<DraftPhoto[]>([])

  const [clientId] = useState(() => crypto.randomUUID())
  const submit = useMutation({
    // Offline-first: if the habitat server is unreachable the check-in is kept on this device and
    // sent later with the same id, so it is never stored twice.
    mutationFn: async (body: CheckinIn) => {
      const result = await sendOrQueue<CheckinOut>('/api/checkins', { ...body, id: clientId })
      // photos follow the check-in (each with its own id, so a re-send is stored once)
      for (const p of photos) {
        await sendOrQueue<Photo>('/api/photos', {
          id: p.id, kind: p.kind, note: p.note || null, checkinId: clientId, takenAt: p.takenAt, dataUrl: p.dataUrl,
        })
      }
      return result
    },
    onSuccess: () => {
      for (const key of ['dashboard', 'alerts', 'guidance', 'timeline', 'progress', 'photos']) void queryClient.invalidateQueries({ queryKey: [key] })
    },
  })
  const seconds = useElapsedSeconds(!submit.isSuccess)

  const problems = useMemo(() => {
    const out = {} as Record<FieldKey, Problem | null>
    for (const f of Object.values(FIELDS)) out[f.key] = check(f, values[f.key], vitals[f.key])
    if (!out.bp_sys && !out.bp_dia && values.bp_sys && values.bp_dia && Number(values.bp_sys) <= Number(values.bp_dia)) {
      out.bp_dia = { kind: 'error', text: 'The lower number must be smaller than the upper number. Measure again.' }
    }
    return out
  }, [values, vitals])

  /** A group is complete when skipped, taken from the wearable, or every field is filled and acceptable. */
  const groupDone = (g: GroupKey) =>
    skipped.has(g) || (g === 'hr' && useWearableHr) ||
    GROUPS[g].fields.every((f) => values[f].trim() !== '' && problems[f]?.kind !== 'error' && (problems[f]?.kind !== 'unusual' || confirmed.has(f)))

  const stepId = STEPS[step].id
  const canContinue =
    stepId === 'hr' ? groupDone('hr')
      : stepId === 'bp' ? groupDone('bp')
        : stepId === 'temp' ? groupDone('temp') && groupDone('spo2')
        : stepId === 'metabolic' ? groupDone('glucose') && groupDone('weight')
          : stepId === 'symptoms' ? noSymptoms || Object.keys(symptoms).length > 0
            : true

  const vitalList: VitalIn[] = (Object.keys(GROUPS) as GroupKey[])
    .filter((g) => !skipped.has(g) && !(g === 'hr' && useWearableHr))
    .flatMap((g) => GROUPS[g].fields)
    .filter((f) => values[f].trim() !== '')
    .map((f) => ({ indicator: f, value: Number(values[f]), unit: FIELDS[f].unit }))
  const symptomList: SymptomIn[] = Object.entries(symptoms).map(([code, s]) => ({
    code: code as SymptomIn['code'], severity: s.severity, note: s.note.trim() || null,
  }))
  const body: CheckinIn = { ...scores, vitals: vitalList, symptoms: symptomList, privateNote: note.trim() || null, completedInSeconds: seconds, id: null }

  if (submit.isSuccess && submit.data.queued) return <SavedOffline />
  if (submit.isSuccess && !submit.data.queued) {
    const missing = (Object.keys(GROUPS) as GroupKey[]).filter((g) => skipped.has(g)).map((g) => GROUPS[g].label)
    return <Result result={submit.data.data} seconds={seconds} missing={missing} photos={photos.length} code={user?.astronautCode} />
  }

  const setValue = (f: FieldKey, v: string) => {
    setValues((s) => ({ ...s, [f]: v }))
    setConfirmed((c) => { const n = new Set(c); n.delete(f); return n })
  }
  const remeasure = (f: FieldKey) => {
    setValue(f, '')
    window.setTimeout(() => document.getElementById(`field-${f}`)?.focus(), 0)
  }
  const toggleSkip = (g: GroupKey) => {
    setSkipped((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n })
    for (const f of GROUPS[g].fields) setValue(f, '')
  }
  const fieldProps = (f: FieldKey) => ({
    field: FIELDS[f], value: values[f], vital: vitals[f], problem: problems[f], confirmed: confirmed.has(f), disabled: skipped.has(GROUP_OF[f]),
    onChange: (v: string) => setValue(f, v), onRemeasure: () => remeasure(f),
    onConfirm: () => setConfirmed((c) => new Set(c).add(f)),
  })
  const set = (k: keyof Scores) => (v: number) => setScores((s) => ({ ...s, [k]: v }))

  const wearableHr = vitals.resting_hr
  const wearableSleep = vitals.sleep_hours

  const pages: Record<StepId, ReactNode> = {
    hr: (
      <MeasurementStep group="hr" skipped={skipped.has('hr')} onSkip={() => toggleSkip('hr')}>
        {fromDevice(wearableHr) && (
          <DeviceOffer active={useWearableHr} onToggle={() => setUseWearableHr((u) => !u)}
            text={`Your wearable recorded ${formatValue(wearableHr!.value, 0)} bpm at ${new Date(wearableHr!.measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} today.`} />
        )}
        {!useWearableHr && <NumberField {...fieldProps('resting_hr')} />}
      </MeasurementStep>
    ),
    bp: (
      <MeasurementStep group="bp" skipped={skipped.has('bp')} onSkip={() => toggleSkip('bp')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField {...fieldProps('bp_sys')} />
          <NumberField {...fieldProps('bp_dia')} />
        </div>
      </MeasurementStep>
    ),
    temp: (
      <div className="space-y-8">
        <MeasurementStep group="temp" skipped={skipped.has('temp')} onSkip={() => toggleSkip('temp')}>
          <NumberField {...fieldProps('body_temp')} />
        </MeasurementStep>
        <MeasurementStep group="spo2" skipped={skipped.has('spo2')} onSkip={() => toggleSkip('spo2')}>
          <NumberField {...fieldProps('spo2')} />
        </MeasurementStep>
      </div>
    ),
    metabolic: (
      <div className="space-y-8">
        <MeasurementStep group="glucose" skipped={skipped.has('glucose')} onSkip={() => toggleSkip('glucose')}>
          <NumberField {...fieldProps('glucose')} />
        </MeasurementStep>
        <MeasurementStep group="weight" skipped={skipped.has('weight')} onSkip={() => toggleSkip('weight')}>
          <NumberField {...fieldProps('body_weight')} />
        </MeasurementStep>
      </div>
    ),
    sleep: (
      <div className="space-y-8">
        <StepIntro info="sleep_hours" />
        {fromDevice(wearableSleep) && (
          <p className="flex items-start gap-2 rounded-lg bg-accent-soft p-3 text-sm">
            <Watch className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            Your wearable measured {formatValue(wearableSleep!.value, 1)} h last night.
            <button type="button" className="font-semibold text-accent underline" onClick={() => set('sleepHours')(Math.round(wearableSleep!.value * 2) / 2)}>
              Use this
            </button>
          </p>
        )}
        <Slider label="Hours slept last night" value={scores.sleepHours} onChange={set('sleepHours')} min={0} max={12} step={0.5}
          low="0 h" high="12 h" format={(v) => `${v} h`} vital={vitals.sleep_hours} />
        <Slider label="Sleep quality" value={scores.sleepQuality} onChange={set('sleepQuality')} min={1} max={10}
          low="1 · very poor" high="10 · excellent" vital={vitals.sleep_quality} />
      </div>
    ),
    feel: (
      <div className="space-y-8">
        <StepIntro info="mood" />
        <Slider label="Mood" value={scores.mood} onChange={set('mood')} min={1} max={10} low="1 · very low" high="10 · great" vital={vitals.mood} />
        <Slider label="Fatigue" value={scores.fatigue} onChange={set('fatigue')} min={1} max={10} low="1 · fresh" high="10 · exhausted" vital={vitals.fatigue} />
      </div>
    ),
    stress: (
      <div className="space-y-8">
        <StepIntro info="stress" />
        <Slider label="Stress" value={scores.stress} onChange={set('stress')} min={1} max={10} low="1 · calm" high="10 · extreme" vital={vitals.stress} />
      </div>
    ),
    symptoms: (
      <div className="space-y-6">
        <SymptomStep options={catalog.data ?? []} symptoms={symptoms} setSymptoms={(s) => { setSymptoms(s); setNoSymptoms(false) }}
          none={noSymptoms} setNone={(n) => { setNoSymptoms(n); if (n) setSymptoms({}) }} />
        <PhotoCapture photos={photos} onChange={setPhotos} />
      </div>
    ),
    review: (
      <Review values={values} skipped={skipped} useWearableHr={useWearableHr} wearableHr={wearableHr} scores={scores}
        symptoms={symptoms} options={catalog.data ?? []} problems={problems} vitals={vitals} onEdit={setStep} photos={photos.length}
        note={note} setNote={setNote} error={submit.isError ? submit.error : null} />
    ),
  }

  const last = step === STEPS.length - 1
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Daily check-in</h1>
          <p className="text-sm text-ink-muted">
            Step {step + 1} of {STEPS.length}: <span className="font-medium text-ink">{STEPS[step].title}</span>
            <span className="ml-2 text-accent">· +10 points when you send it</span>
          </p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${seconds <= TARGET_SECONDS ? 'border-line-strong text-ink' : 'border-status-yellow/50 text-status-yellow'}`}>
          <Timer className="h-4 w-4" aria-hidden /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          <span className="sr-only">elapsed, about 2 minutes expected</span>
        </span>
      </header>
      <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }} aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s.id} title={s.title} aria-current={i === step ? 'step' : undefined}
            className={`h-1.5 rounded-full ${i < step ? 'bg-status-green' : i === step ? 'bg-accent' : 'bg-line'}`}>
            <span className="sr-only">{s.title}{i < step ? ' (done)' : i === step ? ' (current)' : ''}</span>
          </li>
        ))}
      </ol>
      <Panel>{pages[stepId]}</Panel>
      <div className="flex justify-between gap-3">
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0 || submit.isPending}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Button>
        {last ? (
          <Button onClick={() => submit.mutate(body)} disabled={submit.isPending}>
            <Check className="h-4 w-4" aria-hidden /> {submit.isPending ? 'Saving…' : 'Submit check-in'}
          </Button>
        ) : (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canContinue}>
            Next <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
      {!canContinue && (stepId === 'hr' || stepId === 'bp' || stepId === 'temp' || stepId === 'metabolic') && (
        <p className="text-right text-xs text-ink-muted">Enter the reading (if it looks unusual, measure again or keep it), or choose “Not measured today”.</p>
      )}
      {!canContinue && stepId === 'symptoms' && <p className="text-right text-xs text-ink-muted">Choose your symptoms, or “No symptoms today”.</p>}
    </div>
  )
}

// --- building blocks ------------------------------------------------------------------------------

function StepIntro({ info }: { info: string }) {
  const i = infoFor(info)
  if (!i) return null
  return (
    <details className="rounded-lg bg-canvas p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-accent">
        <Info className="h-4 w-4" aria-hidden /> Why we ask
      </summary>
      <p className="mt-1 text-ink">{i.why}</p>
    </details>
  )
}

function MeasurementStep({ group, skipped, onSkip, children }: { group: GroupKey; skipped: boolean; onSkip: () => void; children: ReactNode }) {
  const g = GROUPS[group]
  const info = infoFor(g.info)
  return (
    <section aria-labelledby={`h-${group}`} className="space-y-4">
      <h2 id={`h-${group}`} className="text-lg font-semibold">{g.label}</h2>
      {info?.how && (
        <div className="rounded-lg bg-canvas p-3 text-sm">
          <p className="font-medium">How to measure</p>
          <p className="mt-0.5 text-ink">{info.how}</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-accent">Why it matters</summary>
            <p className="mt-1 text-ink-muted">{info.why}</p>
          </details>
        </div>
      )}
      {skipped ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong p-3 text-sm text-ink-muted">
          <Clock className="h-4 w-4" aria-hidden /> Marked as not measured today. It will show as missing, not as normal.
        </p>
      ) : children}
      <button type="button" onClick={onSkip} aria-pressed={skipped}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-subtle">
        {skipped ? <><RotateCcw className="h-4 w-4" aria-hidden /> Enter a reading instead</> : <>Not measured today <span className="sr-only">: {g.label}</span></>}
      </button>
    </section>
  )
}

function DeviceOffer({ text, active, onToggle }: { text: string; active: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft p-3 text-sm">
      <Watch className="h-5 w-5 shrink-0 text-accent" aria-hidden />
      <p className="flex-1">{text} {active && 'It is already recorded, so it will not be entered again.'}</p>
      <button type="button" onClick={onToggle} aria-pressed={active}
        className="min-h-11 rounded-lg bg-accent px-3 font-semibold text-on-accent">
        {active ? 'Enter my own reading' : 'Use wearable reading'}
      </button>
    </div>
  )
}

function NumberField({ field, value, vital, problem, confirmed, disabled, onChange, onRemeasure, onConfirm }: {
  field: Field; value: string; vital: Vital | undefined; problem: Problem | null; confirmed: boolean; disabled: boolean
  onChange: (v: string) => void; onRemeasure: () => void; onConfirm: () => void
}) {
  const id = `field-${field.key}`
  const hintId = `${id}-hint`
  const errId = `${id}-problem`
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{field.label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input id={id} type="number" inputMode="decimal" min={field.min} max={field.max} step={field.step} value={value}
          disabled={disabled} onChange={(e) => onChange(e.target.value)}
          aria-invalid={problem?.kind === 'error' || undefined} aria-describedby={`${hintId}${problem ? ` ${errId}` : ''}`}
          className={`block min-h-14 w-40 rounded-lg border bg-surface px-3 text-2xl font-semibold outline-none focus:border-accent ${problem?.kind === 'error' ? 'border-status-red' : 'border-line-strong'}`} />
        <span className="text-base text-ink-muted">{field.unit}</span>
      </div>
      <p id={hintId} className="mt-1 text-xs text-ink-muted">
        {vital?.baseline != null ? `Your normal: ${formatValue(vital.baseline, field.dec)} ${field.unit}` : 'No personal normal yet'}
        {vital && ` · last: ${formatValue(vital.value, field.dec)} ${field.unit} (${new Date(vital.measuredAt).toLocaleDateString([], { weekday: 'short' })})`}
      </p>
      {problem && (
        <div id={errId} role={problem.kind === 'error' ? 'alert' : 'status'}
          className={`mt-2 rounded-lg border p-3 text-sm ${problem.kind === 'error' || problem.kind === 'safety' ? 'border-status-red/50 bg-status-red/[0.05]' : 'border-status-yellow/60 bg-status-yellow/[0.05]'}`}>
          <p className="flex items-start gap-2">
            {problem.kind === 'safety' ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-red" aria-hidden /> : <TriangleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${problem.kind === 'error' ? 'text-status-red' : 'text-status-yellow'}`} aria-hidden />}
            <span>{problem.text}</span>
          </p>
          {problem.kind === 'safety' && <Link to="/astronaut/emergency" className="mt-1 inline-block font-semibold text-status-red underline">Open emergency procedures</Link>}
          {problem.kind === 'unusual' && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={onRemeasure} className="min-h-10 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium">
                <RotateCcw className="mr-1 inline h-4 w-4" aria-hidden />Measure again
              </button>
              <button type="button" onClick={onConfirm} disabled={confirmed} aria-pressed={confirmed}
                className="min-h-10 rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent disabled:opacity-70">
                {confirmed ? 'Kept — it will be checked by the rules' : 'Keep this value'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const WORDS: Record<string, string[]> = {
  Mood: ['', 'very low', 'very low', 'low', 'low', 'okay', 'okay', 'good', 'good', 'great', 'great'],
  Stress: ['', 'calm', 'calm', 'low', 'low', 'moderate', 'moderate', 'high', 'high', 'extreme', 'extreme'],
  Fatigue: ['', 'fresh', 'fresh', 'a little tired', 'a little tired', 'tired', 'tired', 'very tired', 'very tired', 'exhausted', 'exhausted'],
  'Sleep quality': ['', 'very poor', 'very poor', 'poor', 'poor', 'fair', 'fair', 'good', 'good', 'excellent', 'excellent'],
}

function Slider({ label, value, onChange, min, max, step = 1, low, high, format, vital }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number
  low: string; high: string; format?: (v: number) => string; vital?: Vital
}) {
  const word = WORDS[label]?.[value]
  const shown = format ? format(value) : `${value} / 10`
  const id = `slider-${label.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-base font-medium">{label}</label>
        <output htmlFor={id} className="text-right">
          <span className="text-3xl font-semibold text-accent">{shown}</span>
          {word && <span className="ml-2 text-sm text-ink-muted">{word}</span>}
        </output>
      </div>
      <input id={id} type="range" className="big-range mt-3 w-full" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} aria-valuetext={`${shown}${word ? `, ${word}` : ''}`}
        aria-describedby={`${id}-scale`} />
      <div id={`${id}-scale`} className="mt-1 flex justify-between text-xs text-ink-muted">
        <span>{low}</span>
        {vital?.baseline != null && <span>your normal: {formatValue(vital.baseline, label.startsWith('Hours') ? 1 : 0)}</span>}
        <span>{high}</span>
      </div>
    </div>
  )
}

function SymptomStep({ options, symptoms, setSymptoms, none, setNone }: {
  options: SymptomOption[]; symptoms: Record<string, { severity: number; note: string }>
  setSymptoms: (s: Record<string, { severity: number; note: string }>) => void; none: boolean; setNone: (n: boolean) => void
}) {
  const toggle = (code: string) => {
    const next = { ...symptoms }
    if (next[code]) delete next[code]
    else next[code] = { severity: 3, note: '' }
    setSymptoms(next)
  }
  const redSelected = options.filter((o) => o.redFlag && symptoms[o.code])
  return (
    <section aria-labelledby="h-symptoms" className="space-y-4">
      <div>
        <h2 id="h-symptoms" className="text-lg font-semibold">Any symptoms today?</h2>
        <p className="text-sm text-ink-muted">Choose everything you notice. Symptoms are recorded in your health history and shared with the flight surgeon.</p>
      </div>
      <button type="button" aria-pressed={none} onClick={() => setNone(!none)}
        className={`flex min-h-12 w-full items-center gap-2 rounded-lg border px-4 text-left font-medium ${none ? 'border-status-green bg-status-green/[0.06]' : 'border-line-strong hover:bg-subtle'}`}>
        <Check className={`h-5 w-5 ${none ? 'text-status-green' : 'text-ink-muted'}`} aria-hidden /> No symptoms today
      </button>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Common symptoms</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.filter((o) => !o.redFlag).map((o) => <SymptomToggle key={o.code} option={o} on={Boolean(symptoms[o.code])} onToggle={() => toggle(o.code)} />)}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium text-status-red">
          <ShieldAlert className="h-4 w-4" aria-hidden /> Possible emergency symptoms
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.filter((o) => o.redFlag).map((o) => <SymptomToggle key={o.code} option={o} on={Boolean(symptoms[o.code])} onToggle={() => toggle(o.code)} />)}
        </div>
      </fieldset>
      {redSelected.map((o) => o.protocol && <EmergencyProtocolCard key={o.code} id={o.protocol} />)}
      {Object.keys(symptoms).length > 0 && (
        <div className="space-y-4 border-t border-line pt-4">
          <p className="text-sm font-medium">How strong is each one?</p>
          {options.filter((o) => symptoms[o.code]).map((o) => (
            <div key={o.code} className="space-y-2">
              <label className="block">
                <span className="flex justify-between text-sm"><span>{o.label}</span><span className="font-semibold">{symptoms[o.code].severity} / 10</span></span>
                <input type="range" min={1} max={10} value={symptoms[o.code].severity} className="big-range mt-2 w-full"
                  aria-label={`${o.label}: severity`} aria-valuetext={`${symptoms[o.code].severity} out of 10`}
                  onChange={(e) => setSymptoms({ ...symptoms, [o.code]: { ...symptoms[o.code], severity: Number(e.target.value) } })} />
                <span className="flex justify-between text-xs text-ink-muted"><span>1 · barely noticeable</span><span>10 · worst imaginable</span></span>
              </label>
              <label className="block text-xs">
                <span className="text-ink-muted">Anything to add? (optional)</span>
                <input type="text" maxLength={300} value={symptoms[o.code].note}
                  onChange={(e) => setSymptoms({ ...symptoms, [o.code]: { ...symptoms[o.code], note: e.target.value } })}
                  className="mt-1 block min-h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm" />
              </label>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SymptomToggle({ option, on, onToggle }: { option: SymptomOption; on: boolean; onToggle: () => void }) {
  const tone = option.redFlag ? (on ? 'border-status-red bg-status-red/[0.06]' : 'border-status-red/40') : on ? 'border-accent bg-accent-soft' : 'border-line-strong'
  return (
    <label className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm ${tone} hover:bg-subtle`}>
      <input type="checkbox" checked={on} onChange={onToggle} className="h-5 w-5 accent-[var(--color-accent)]" />
      {option.label}
    </label>
  )
}

function Review({ values, skipped, useWearableHr, wearableHr, scores, symptoms, options, problems, vitals, onEdit, note, setNote, error, photos }: {
  values: Record<FieldKey, string>; skipped: Set<GroupKey>; useWearableHr: boolean; wearableHr: Vital | undefined; scores: Scores
  symptoms: Record<string, { severity: number; note: string }>; options: SymptomOption[]; problems: Record<FieldKey, Problem | null>
  vitals: Record<string, Vital | undefined>; onEdit: (step: number) => void; note: string; setNote: (s: string) => void; error: unknown
  photos: number
}) {
  const now = useNow()
  const at = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const stepOf = (id: StepId) => STEPS.findIndex((s) => s.id === id)
  const measured = (g: GroupKey): { value: ReactNode; source: string; flag?: string } => {
    if (g === 'hr' && useWearableHr && wearableHr) {
      return { value: `${formatValue(wearableHr.value, 0)} bpm`, source: `Wearable, ${new Date(wearableHr.measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (already recorded)` }
    }
    if (skipped.has(g)) return { value: <span className="inline-flex items-center gap-1 text-ink-muted"><Clock className="h-4 w-4" aria-hidden />Not measured today</span>, source: '—' }
    const f = GROUPS[g].fields
    const flag = f.map((k) => problems[k]).find((p) => p && p.kind !== 'error')?.kind
    return {
      value: `${f.map((k) => values[k]).join('/')} ${FIELDS[f[0]].unit}`,
      source: `Entered by you, ${at}`,
      flag: flag === 'unusual' ? 'Unusual — you kept it' : flag === 'safety' ? 'Safety limit' : undefined,
    }
  }
  const rows: { label: string; step: StepId; value: ReactNode; source: string; normal?: string; flag?: string }[] = [
    ...(Object.keys(GROUPS) as GroupKey[]).map((g) => {
      const m = measured(g)
      const v = vitals[GROUPS[g].fields[0]]
      const v2 = g === 'bp' ? vitals.bp_dia : undefined
      const normal = v?.baseline != null ? `${formatValue(v.baseline, FIELDS[GROUPS[g].fields[0]].dec)}${v2?.baseline != null ? `/${formatValue(v2.baseline, 0)}` : ''}` : undefined
      return { label: GROUPS[g].label, step: STEP_OF[g], normal, ...m }
    }),
    { label: 'Sleep', step: 'sleep', value: `${scores.sleepHours} h · quality ${scores.sleepQuality}/10`, source: `Entered by you, ${at}` },
    { label: 'Mood', step: 'feel', value: `${scores.mood}/10`, source: `Entered by you, ${at}` },
    { label: 'Fatigue', step: 'feel', value: `${scores.fatigue}/10`, source: `Entered by you, ${at}` },
    { label: 'Stress', step: 'stress', value: `${scores.stress}/10`, source: `Entered by you, ${at}` },
  ]
  const chosen = options.filter((o) => symptoms[o.code])
  return (
    <section aria-labelledby="h-review" className="space-y-4">
      <h2 id="h-review" className="text-lg font-semibold">Check your answers</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Your check-in answers</caption>
          <thead className="text-xs text-ink-muted">
            <tr className="border-b border-line">
              <th scope="col" className="py-2 pr-3 font-medium">Measurement</th>
              <th scope="col" className="py-2 pr-3 font-medium">Value</th>
              <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">Recorded</th>
              <th scope="col" className="py-2 font-medium"><span className="sr-only">Change</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-line align-top">
                <th scope="row" className="py-2 pr-3 font-medium">{r.label}</th>
                <td className="py-2 pr-3">
                  <span className="font-semibold">{r.value}</span>
                  {r.normal && <span className="block text-xs text-ink-muted">your normal {r.normal}</span>}
                  {r.flag && <span className="block text-xs text-status-yellow">{r.flag}</span>}
                </td>
                <td className="hidden py-2 pr-3 text-xs text-ink-muted sm:table-cell">{r.source}</td>
                <td className="py-1 text-right">
                  <button type="button" onClick={() => onEdit(stepOf(r.step))} className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs font-medium text-accent hover:bg-subtle">
                    <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit<span className="sr-only"> {r.label}</span>
                  </button>
                </td>
              </tr>
            ))}
            <tr className="align-top">
              <th scope="row" className="py-2 pr-3 font-medium">Symptoms</th>
              <td className="py-2 pr-3" colSpan={2}>
                {chosen.length === 0 ? 'None today' : chosen.map((o) => (
                  <span key={o.code} className={`block ${o.redFlag ? 'font-semibold text-status-red' : ''}`}>{o.label} · {symptoms[o.code].severity}/10</span>
                ))}
              </td>
              <td className="py-1 text-right">
                <button type="button" onClick={() => onEdit(stepOf('symptoms'))} className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs font-medium text-accent hover:bg-subtle">
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit<span className="sr-only"> symptoms</span>
                </button>
              </td>
            </tr>
            <tr className="border-t border-line align-top">
              <th scope="row" className="py-2 pr-3 font-medium">Photos</th>
              <td className="py-2 pr-3" colSpan={2}>{photos === 0 ? 'None' : `${photos} photo${photos === 1 ? '' : 's'} for the flight surgeon`}</td>
              <td className="py-1 text-right">
                <button type="button" onClick={() => onEdit(stepOf('symptoms'))} className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs font-medium text-accent hover:bg-subtle">
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit<span className="sr-only"> photos</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <label className="block text-sm">
        <span className="font-medium">Private note</span> <span className="text-ink-muted">(only you can see this)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2}
          className="mt-1 block w-full rounded-lg border border-line-strong bg-surface p-3 outline-none focus:border-accent" />
      </label>
      <p className="text-xs text-ink-muted">Sending compares each value with your normal using the medical rules. Nothing is decided by AI.</p>
      {error != null && <ErrorNote error={error} />}
    </section>
  )
}

function Result({ result, seconds, missing, photos, code }: { result: CheckinOut; seconds: number; missing: string[]; photos: number; code?: string | null }) {
  const alerts = [...result.newAlerts, ...result.updatedAlerts]
  const progress = useProgress(code).data
  const streak = progress?.streaks.find((s) => s.id === 'checkin')
  const protocols = result.newAlerts.filter((a) => a.severity === 'Urgent' && a.protocol).map((a) => a.protocol as string)
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {protocols.map((p) => <EmergencyProtocolCard key={p} id={p} reported />)}
      <Panel>
        <p className="flex items-center gap-2 text-lg font-semibold text-status-green">
          <Check className="h-5 w-5" aria-hidden /> Check-in saved in {seconds} s
        </p>
        <p className="mt-1 text-sm">
          {result.accepted} readings recorded and compared with your personal normal.
          {result.rejected.length > 0 && ` ${result.rejected.length} value(s) were rejected as implausible or inconsistent.`}
          {result.questionable.length > 0 && ` ${result.questionable.length} value(s) were marked “check this reading”.`}
        </p>
        {missing.length > 0 && (
          <p className="mt-2 flex items-start gap-2 text-sm text-ink-muted">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Not measured today: {missing.join(', ')}. These are shown as missing, not as normal.
          </p>
        )}
        {photos > 0 && (
          <p className="mt-2 flex items-start gap-2 text-sm">
            <Camera className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            {photos} photo{photos === 1 ? '' : 's'} added to your health record for the flight surgeon.
          </p>
        )}
        {streak && streak.current > 0 && (
          <p className="mt-2 flex items-start gap-2 text-sm">
            <Flame className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            Check-in streak: {streak.current} day{streak.current === 1 ? '' : 's'} in a row · +10 points.{' '}
            <Link to="/astronaut/wellness#progress" className="font-medium text-accent underline">See your progress</Link>
          </p>
        )}
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
        <LinkButton to="/astronaut/home">Go to Home</LinkButton>
        {alerts.length > 0 && <LinkButton to="/astronaut/guidance/alerts" variant="ghost">Open health alerts</LinkButton>}
        {alerts.length > 0 && <LinkButton to="/astronaut/guidance" variant="ghost">See what to do</LinkButton>}
      </div>
    </div>
  )
}

function SavedOffline() {
  return (
    <div className="mx-auto max-w-xl space-y-4">
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
