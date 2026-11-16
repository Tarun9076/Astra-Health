import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, Check, Clock, MapPin, Siren, TriangleAlert, Volume2, VolumeX, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmergencyProtocolCard } from '../../components/ui/EmergencyProtocolCard'
import { Button, ErrorNote, Loading } from '../../components/ui/Panel'
import { MoreDetail } from '../../components/ui/Simple'
import { beep, speak } from '../../lib/alarm'
import { api, unwrap } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { BUNDLED, deviceAssess, medicineById } from '../../lib/treatment/bundled'
import type { AssessmentOut, ProtocolPlanOut, StepOut } from '../../lib/treatment/engine'
import { useNow } from '../../lib/useNow'
import { advanceProtocol, currentProtocol, currentStep, describeEvent, targetAfter, useRunner, type Episode } from './runner'

const UNIT: Record<string, string> = { glucose: 'mg/dL', spo2: '%', body_temp: '°C', heart_rate: 'bpm', bp_sys: 'mmHg' }
const NAME: Record<string, string> = { glucose: 'Blood sugar', spo2: 'Oxygen saturation', body_temp: 'Temperature', heart_rate: 'Heart rate', bp_sys: 'Blood pressure (top number)' }
const OP_WORD: Record<string, string> = { lt: 'below', lte: 'at most', gt: 'above', gte: 'at least' }
const ROUTE: Record<string, string> = { chew: 'Chew', swallow: 'Swallow', injection: 'Inject', spray: 'Spray', skin: 'Put on the skin', drink: 'Drink' }

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function useCrew() {
  return useQuery({
    queryKey: ['treatment-protocols'],
    queryFn: () => unwrap(api.GET('/api/treatment/protocols')),
    staleTime: 60 * 60_000,
  })
}

/**
 * Act Now (Step 21): critical treatment, one step at a time. The plan comes from the protocol files
 * (server, or this device's copy when the server is down). Every action is logged and sent to Earth.
 */
export function ActNowPage() {
  const episode = useRunner((s) => s.episode)
  const [params] = useSearchParams()
  const join = params.get('episode')
  if (episode && !episode.finished) return <Runner episode={episode} />
  if (episode?.finished) return <Finished episode={episode} />
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {join && <JoinEpisode id={join} />}
      <HelpNow />
      <CrewTreatments />
    </div>
  )
}

// --- Help now: who, what ------------------------------------------------------------------------------

function HelpNow() {
  const me = useAuth((s) => s.user)
  const crew = useCrew()
  const queryClient = useQueryClient()
  const start = useRunner((s) => s.start)
  const [who, setWho] = useState(me?.astronautCode ?? '')
  const [forOther, setForOther] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const people = crew.data?.crew ?? (me?.astronautCode ? [{ code: me.astronautCode, name: me.displayName }] : [])
  const protocols = crew.data?.protocols ?? [...BUNDLED.protocols].sort((a, b) => a.priority - b.priority).map((p) => ({ id: p.id, title: p.title, plain: p.plain }))

  const open = async (protocolId: string) => {
    setBusy(protocolId)
    setError(null)
    const name = people.find((p) => p.code === who)?.name ?? who
    try {
      let plan: AssessmentOut
      let source: 'help-now' | 'device' = 'help-now'
      let profileKnown = true
      try {
        // the server has the latest record; if it doesn't answer within 2.5 s, this device decides
        const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(Object.assign(new Error('slow'), { status: 0 })), 2500))
        plan = await Promise.race([
          unwrap(api.POST('/api/astronauts/{astronaut}/treatment/assess', { params: { path: { astronaut: who } }, body: { protocolId } })),
          timeout,
        ])
      } catch (e) {
        if ((e as { status?: number }).status && (e as { status: number }).status < 500 && (e as { status: number }).status !== 0) throw e
        ;({ plan, profileKnown } = deviceAssess(queryClient, who, {}, protocolId)) // server down: this device's copy
        source = 'device'
      }
      await start({ astronautCode: who, astronautName: name, plan, source, profileKnown })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="help-now" className="space-y-4">
      <h1 id="help-now" className="flex items-center gap-2 text-2xl font-bold text-status-red"><Siren className="h-7 w-7" aria-hidden /> Help now</h1>
      <p className="text-base">Tap what is happening. You get the steps at once; the crew and Earth are told automatically.</p>
      {who !== me?.astronautCode && <p className="text-lg font-semibold">For: {people.find((p) => p.code === who)?.name ?? who}</p>}
      <div>
        <h2 className="sr-only">What is happening?</h2>
        <ul className="space-y-2">
          {protocols.map((p) => (
            <li key={p.id}>
              <button type="button" disabled={!who || busy !== null} onClick={() => void open(p.id)}
                className="flex w-full flex-col items-start rounded-xl border-2 border-status-red/60 p-4 text-left hover:bg-status-red/5 disabled:opacity-50">
                <span className="text-xl font-bold">{busy === p.id ? 'Opening…' : p.title}</span>
                <span className="mt-1 text-base text-ink-muted">{p.plain}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {error !== null && <ErrorNote error={error} />}
      {!forOther ? (
        <button type="button" onClick={() => setForOther(true)} className="min-h-11 text-sm text-accent underline">Helping someone else?</button>
      ) : (
        <fieldset>
          <legend className="mb-2 text-base font-semibold">Who needs help?</legend>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => (
              <button key={p.code} type="button" aria-pressed={who === p.code} onClick={() => setWho(p.code)}
                className={`min-h-12 rounded-lg border px-4 text-base font-semibold ${who === p.code ? 'border-ink bg-ink text-surface' : 'border-line-strong'}`}>
                {p.code === me?.astronautCode ? `Me (${p.name})` : p.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {crew.data && <p className="text-xs text-ink-muted">{crew.data.disclaimer}</p>}
    </section>
  )
}

function CrewTreatments() {
  const active = useQuery({
    queryKey: ['treatment-episodes', 'active'],
    queryFn: () => unwrap(api.GET('/api/treatment/episodes', { params: { query: { active: true } } })),
  })
  const [, setParams] = useSearchParams()
  if (!active.data?.length) return null
  return (
    <section aria-labelledby="crew-active" className="space-y-2">
      <h2 id="crew-active" className="text-lg font-semibold">Treatments in progress</h2>
      <ul className="space-y-2">
        {active.data.map((e) => (
          <li key={e.id}>
            <button type="button" onClick={() => setParams({ episode: e.id })} className="w-full rounded-lg border border-line p-3 text-left hover:border-accent">
              <span className="font-semibold">{e.astronautName}: {e.title}</span>
              <span className="block text-sm text-ink-muted">Started {clock(new Date(e.startedAt).getTime())} by {e.startedBy} · {e.events.length} step(s) logged</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A treatment started on another device: what has been done, and "continue on this device". */
function JoinEpisode({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['treatment-episode', id], queryFn: () => unwrap(api.GET('/api/treatment/episodes/{episode_id}', { params: { path: { episode_id: id } } })) })
  const start = useRunner((s) => s.start)
  if (q.isPending) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const e = q.data
  const plan = e.plan as unknown as AssessmentOut
  const resumeAt = () => {
    // the step after the last logged one, in the same protocol
    const last = [...e.events].reverse().find((x) => x.stepId && x.protocolId)
    let protocolIndex = 0
    let stepId = plan.critical[0]?.steps[0]?.id ?? 'done'
    if (last) {
      protocolIndex = Math.max(0, plan.critical.findIndex((p) => p.id === last.protocolId))
      const step = plan.critical[protocolIndex]?.steps.find((s) => s.id === last.stepId)
      if (step) stepId = targetAfter(step, last.kind, last.data)
    }
    void start({ id: e.id, astronautCode: e.astronautCode, astronautName: e.astronautName, plan, source: 'help-now', profileKnown: true,
      resume: { protocolIndex, stepId, startedAt: e.startedAt } })
  }
  return (
    <section className="space-y-3 rounded-xl border-2 border-status-red p-4" aria-label="Treatment in progress">
      <h2 className="text-xl font-bold">{e.astronautName}: {e.title}</h2>
      <p className="text-sm text-ink-muted">Started {clock(new Date(e.startedAt).getTime())} by {e.startedBy} · {e.status}</p>
      <ol className="space-y-1 text-sm">
        {e.events.map((x) => (
          <li key={x.id}>{clock(new Date(x.at).getTime())} · {x.byName}: {describeEvent(x.kind, x.stepId, x.data, plan)}</li>
        ))}
      </ol>
      {e.status === 'Active' && <Button variant="danger" onClick={resumeAt}>Continue this treatment on this device</Button>}
    </section>
  )
}

// --- the runner -----------------------------------------------------------------------------------------

function Runner({ episode }: { episode: Episode }) {
  const { readAloud, setReadAloud, finish } = useRunner()
  const protocol = currentProtocol(episode)
  const step = currentStep(episode)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    if (!readAloud || !step) return
    const dose = step.pick ? ` ${ROUTE[step.pick.route] ?? ''} ${step.pick.doseText} of ${step.pick.name}.` : ''
    speak(`${step.text}.${dose}${step.kind === 'question' && step.question ? ` ${step.question}` : ''}`)
  }, [readAloud, step])

  if (!protocol) return <AllProtocolsDone episode={episode} />
  const index = protocol.steps.findIndex((s) => s.id === episode.stepId)
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-status-red pb-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-status-red">Act now · {episode.astronautName}</p>
          <h1 className="text-2xl font-bold">{protocol.title}</h1>
          <p className="text-sm text-ink-muted">
            {episode.plan.critical.length > 1 && `Problem ${episode.protocolIndex + 1} of ${episode.plan.critical.length} · `}
            {index >= 0 ? `Step ${index + 1} of ${protocol.steps.length}` : 'End of this protocol'}
            {episode.source === 'device' && ' · planned on this device (server not reachable)'}
          </p>
          <p className="mt-1 text-sm font-semibold text-status-green">
            {episode.source === 'device' ? 'Saved on this device; the crew and Earth are told when the server is back.' : 'The crew and Earth have been told automatically.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setReadAloud(!readAloud)} aria-pressed={readAloud}
            className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line-strong px-3 text-sm">
            {readAloud ? <Volume2 className="h-4 w-4" aria-hidden /> : <VolumeX className="h-4 w-4" aria-hidden />} Read aloud
          </button>
          <button type="button" onClick={() => setStopping(true)} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line-strong px-3 text-sm">
            <X className="h-4 w-4" aria-hidden /> Stop
          </button>
        </div>
      </header>
      {stopping && (
        <div role="alertdialog" aria-label="Stop the treatment?" className="rounded-xl border-2 border-line-strong p-4">
          <p className="text-base font-semibold">Stop this treatment? Use this only if it was opened by mistake.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" onClick={() => void finish('cancelled', 'Stopped on the device')}>Yes, stop it</Button>
            <Button variant="ghost" onClick={() => setStopping(false)}>No, continue</Button>
          </div>
        </div>
      )}
      {!episode.profileKnown && (
        <Warning>This device doesn't have {episode.astronautName}'s allergy list. Ask about allergies before giving any medicine.</Warning>
      )}
      {index === 0 && protocol.remeasure.length > 0 && (
        <Warning>
          The {protocol.remeasure.map((i) => NAME[i]?.toLowerCase() ?? i).join(' and ')} reading looked doubtful. Re-measure{' '}
          {protocol.actFirst ? 'while you start: don’t wait for it.' : 'before you start.'}
        </Warning>
      )}
      {episode.stepId === 'done' || episode.stepId === 'escalate'
        ? <ProtocolEnd protocol={protocol} escalate={episode.stepId === 'escalate'} />
        : step && <StepCard key={`${episode.protocolIndex}/${step.id}/${episode.stepAt}`} episode={episode} protocol={protocol} step={step} />}
      <PlanDetails protocol={protocol} />
    </div>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="flex gap-2 rounded-lg border-2 border-status-yellow bg-status-yellow/10 px-3 py-2 text-base">
      <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-status-yellow" aria-hidden /> <span>{children}</span>
    </p>
  )
}

function StepCard({ episode, protocol, step }: { episode: Episode; protocol: ProtocolPlanOut; step: StepOut }) {
  const { log, goto } = useRunner()
  const done = (kind: 'step_done' | 'step_skipped', data: Record<string, unknown>, target: string) => {
    void log(kind, data)
    goto(target)
  }
  return (
    <section aria-live="polite" className="space-y-4 rounded-2xl border-2 border-ink/80 p-5">
      <p className="text-2xl font-bold leading-snug md:text-3xl">{step.text}</p>
      {step.detail && <p className="text-lg">{step.detail}</p>}
      {step.kind === 'action' && (
        <>
          <Big onClick={() => done('step_done', {}, step.next)}><Check className="h-6 w-6" aria-hidden /> Done</Big>
          <Skip onClick={() => done('step_skipped', { reason: 'Could not do it' }, step.next)}>I can't do this: skip</Skip>
        </>
      )}
      {step.kind === 'question' && (
        <>
          <p className="text-2xl font-semibold">{step.question}</p>
          <Choices>
            <Big onClick={() => { void log('answer', { answer: 'yes' }); goto(step.yes!) }}>Yes</Big>
            <Big onClick={() => { void log('answer', { answer: 'no' }); goto(step.no!) }}>No</Big>
          </Choices>
        </>
      )}
      {step.kind === 'medicine' && <MedicineStep episode={episode} protocol={protocol} step={step} />}
      {step.kind === 'measure' && <MeasureStep step={step} onDone={(v) => done('step_done', { indicator: step.indicator, value: v }, step.next)}
        onSkip={() => done('step_skipped', { reason: 'Could not measure' }, step.next)} />}
      {step.kind === 'recheck' && <RecheckStep episode={episode} step={step} />}
      {step.emergency && (
        <MoreDetail label="Show the emergency procedure"><EmergencyProtocolCard id={step.emergency} /></MoreDetail>
      )}
    </section>
  )
}

function Skip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="min-h-11 text-base text-ink-muted underline">{children}</button>
}

function Choices({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>
}

function Big({ children, onClick, variant = 'primary', disabled, type = 'button' }: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'
}) {
  return <Button type={type} variant={variant} disabled={disabled} onClick={onClick} className="min-h-16 w-full text-lg">{children}</Button>
}

function MedicineStep({ episode, protocol, step }: { episode: Episode; protocol: ProtocolPlanOut; step: StepOut }) {
  const { log, goto, given } = useRunner()
  const me = useAuth((s) => s.user?.displayName ?? '')
  const now = useNow(1000)
  const pick = step.pick
  if (!pick) {
    return (
      <>
        <Warning>{step.withheld}</Warning>
        <Big onClick={() => { void log('step_skipped', { reason: step.withheld }); goto(step.ifNone ?? step.next) }}>Next step</Big>
      </>
    )
  }
  // repeats inside this treatment: never sooner than the medicine's interval, never over its 24-hour limit
  const med = medicineById(pick.medicineId)
  const earlier = episode.doses.filter((d) => d.medicineId === pick.medicineId)
  const last = earlier.length ? new Date(earlier[earlier.length - 1].at).getTime() : null
  const readyAt = last !== null && med ? last + med.minIntervalHours * 3_600_000 : null
  const waiting = readyAt !== null && readyAt > now
  const overLimit = med ? earlier.reduce((n, d) => n + d.units, 0) + pick.units > med.maxUnitsPer24h : false
  const taken = () => {
    given({ protocolId: protocol.id, stepId: step.id, medicineId: pick.medicineId, units: pick.units })
    void log('dose_given', { medicineId: pick.medicineId, units: pick.units, givenBy: me, readBackBy: null })
    goto(step.next)
  }
  return (
    <>
      <div className="rounded-xl border-2 border-accent bg-accent-soft p-4">
        <p className="text-3xl font-bold">{ROUTE[pick.route] ?? 'Take'} {pick.doseText}</p>
        <p className="mt-1 text-xl font-semibold">{pick.name} {pick.strength}</p>
        <p className="mt-1 inline-flex items-center gap-1 text-lg font-semibold"><MapPin className="h-5 w-5" aria-hidden /> {pick.kitLocation}</p>
        {pick.appearance && <p className="mt-1 text-base">Looks like: {pick.appearance}</p>}
        <p className="mt-2 text-base">{pick.how}</p>
        {pick.checks.length > 0 && (
          <ul className="mt-2 space-y-1 text-base">
            {pick.checks.map((c) => <li key={c.code + c.text} className="flex gap-1.5"><TriangleAlert className="mt-1 h-4 w-4 shrink-0 text-status-yellow" aria-hidden />{c.text}</li>)}
          </ul>
        )}
      </div>
      {waiting && <Warning>Not yet: the next dose is safe from {clock(readyAt!)}. Wait for the timer.</Warning>}
      {overLimit && <Warning>The 24-hour limit for {pick.name} is reached. Don't take more: go to the next step.</Warning>}
      <Big disabled={waiting || overLimit} onClick={taken}><Check className="h-6 w-6" aria-hidden /> Done</Big>
      <Skip onClick={() => { void log('step_skipped', { reason: overLimit ? 'Limit reached' : 'Could not take it' }); goto(step.ifNone ?? step.next) }}>
        I can't take it: next step
      </Skip>
      {step.rejected.length > 0 && (
        <p className="text-sm text-ink-muted">Not used: {step.rejected.map((r) => `${r.name} (${r.reasons.join(' ')})`).join('; ')}</p>
      )}
    </>
  )
}

function MeasureStep({ step, onDone, onSkip }: { step: StepOut; onDone: (v: number) => void; onSkip: () => void }) {
  const [value, setValue] = useState('')
  const n = Number(value.replace(',', '.'))
  const unit = UNIT[step.indicator ?? ''] ?? ''
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (value && Number.isFinite(n)) onDone(n) }}>
      <label className="block text-lg font-semibold">{NAME[step.indicator ?? ''] ?? step.indicator} ({unit})
        <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus
          className="mt-1 block min-h-14 w-full rounded-lg border-2 border-line-strong bg-surface px-3 text-2xl" />
      </label>
      <Big type="submit" disabled={!value || !Number.isFinite(n)}>Save</Big>
      <Skip onClick={onSkip}>I can't measure it: skip</Skip>
    </form>
  )
}

function RecheckStep({ episode, step }: { episode: Episode; step: StepOut }) {
  const { log, goto, fail } = useRunner()
  const now = useNow(1000)
  const due = new Date(episode.stepAt).getTime() + (step.afterMinutes ?? 0) * 60_000
  const left = Math.max(0, due - now)
  const [early, setEarly] = useState(false)
  const [value, setValue] = useState('')
  const rang = useRef(false)
  useEffect(() => {
    if (left === 0 && !rang.current) {
      rang.current = true
      beep(3)
    }
  }, [left])
  const result = (passed: boolean, data: Record<string, unknown>) => {
    const target = passed ? step.passed! : fail(step)
    void log('recheck', { ...data, result: passed ? 'passed' : 'failed', target })
    goto(target)
  }
  const ready = left === 0 || early
  const n = Number(value.replace(',', '.'))
  const unit = UNIT[step.indicator ?? ''] ?? ''
  return (
    <>
      {!ready && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="inline-flex items-center gap-2 text-3xl font-bold tabular-nums" role="timer" aria-live="off">
            <Clock className="h-7 w-7" aria-hidden /> {Math.floor(left / 60000)}:{String(Math.floor(left / 1000) % 60).padStart(2, '0')}
          </p>
          <p className="text-base">until the check (at {clock(due)}). Stay with the person.</p>
          <Button variant="ghost" onClick={() => setEarly(true)}>Check now (getting worse?)</Button>
        </div>
      )}
      {ready && step.question && (
        <>
          <p className="text-2xl font-semibold">{step.question}</p>
          <Choices>
            <Big onClick={() => result(true, { answer: 'yes' })}>Yes</Big>
            <Big variant="danger" onClick={() => result(false, { answer: 'no' })}>No</Big>
          </Choices>
        </>
      )}
      {ready && !step.question && step.indicator && (
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault()
          if (!value || !Number.isFinite(n)) return
          const ok = { lt: n < step.value!, lte: n <= step.value!, gt: n > step.value!, gte: n >= step.value! }[step.op as 'lt']
          result(ok, { indicator: step.indicator, value: n })
        }}>
          <p className="text-lg">Target: {OP_WORD[step.op ?? ''] ?? step.op} {step.value} {unit}</p>
          <label className="block text-lg font-semibold">{NAME[step.indicator] ?? step.indicator} now ({unit})
            <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus
              className="mt-1 block min-h-14 w-full rounded-lg border-2 border-line-strong bg-surface px-3 text-2xl" />
          </label>
          <Big type="submit" disabled={!value || !Number.isFinite(n)}>Save</Big>
        </form>
      )}
    </>
  )
}

function ProtocolEnd({ protocol, escalate }: { protocol: ProtocolPlanOut; escalate: boolean }) {
  const log = useRunner((s) => s.log)
  useEffect(() => {
    if (!escalate) advanceProtocol()
  }, [escalate])
  if (!escalate) return null
  return (
    <section className="space-y-3 rounded-2xl border-2 border-status-red p-5" role="alert">
      <p className="flex items-center gap-2 text-2xl font-bold text-status-red"><AlertOctagon className="h-7 w-7" aria-hidden /> Not getting better</p>
      <p className="text-xl">{protocol.escalation}</p>
      {protocol.emergencyProtocol && <EmergencyProtocolCard id={protocol.emergencyProtocol} />}
      <Big variant="danger" onClick={() => { void log('note', { text: `Escalated: ${protocol.title}` }); advanceProtocol() }}>
        I am doing this: continue
      </Big>
    </section>
  )
}

function AllProtocolsDone({ episode }: { episode: Episode }) {
  const finish = useRunner((s) => s.finish)
  const [note, setNote] = useState('')
  const escalated = Object.values(episode.outcomes).includes('escalate')
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">All steps done</h1>
      <DoseSummary episode={episode} />
      <label className="block text-base font-semibold">How do you feel now? (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
          className="mt-1 block min-h-12 w-full rounded-lg border border-line-strong bg-surface px-3 text-base" />
      </label>
      <Big variant={escalated ? 'danger' : 'primary'} onClick={() => void finish(escalated ? 'escalated' : 'resolved', note.trim() || undefined)}>
        Finish
      </Big>
    </div>
  )
}

function DoseSummary({ episode }: { episode: Episode }) {
  if (!episode.doses.length) return <p className="text-base">No medicine was given.</p>
  return (
    <ul className="space-y-1 text-base">
      {episode.doses.map((d, i) => {
        const m = medicineById(d.medicineId)
        return <li key={i}>{clock(new Date(d.at).getTime())}: {m ? `${m.name}, ${d.units} ${d.units === 1 ? m.unit : m.unitPlural}` : d.medicineId}</li>
      })}
    </ul>
  )
}

function Finished({ episode }: { episode: Episode }) {
  const clear = useRunner((s) => s.clear)
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">Treatment finished</h1>
      <p className="text-lg">Everything is saved and sent to the flight surgeon. If it gets worse, press Help now again.</p>
      <DoseSummary episode={episode} />
      <Big onClick={clear}>Close</Big>
    </div>
  )
}

function PlanDetails({ protocol }: { protocol: ProtocolPlanOut }) {
  return (
    <MoreDetail label="Why this plan, what not to give, all steps">
      <div className="space-y-3 text-ink">
        <p><strong>Why:</strong> {protocol.matchedBy.join('; ')}</p>
        {protocol.doNotGive.length > 0 && (
          <div><strong>Do not give:</strong><ul className="list-disc pl-5">{protocol.doNotGive.map((d) => <li key={d}>{d}</li>)}</ul></div>
        )}
        <ol className="list-decimal space-y-1 pl-5">
          {protocol.steps.map((s) => <li key={s.id}>{s.text}{s.pick ? `: ${s.pick.doseText} ${s.pick.name}` : s.withheld ? ' (no medicine: see the step)' : ''}</li>)}
        </ol>
        <p className="text-xs text-ink-muted">Protocol {protocol.id} v{protocol.version} · {protocol.approvalStatus === 'demo' ? 'DEMO: not approved by a flight surgeon' : 'approved'}</p>
      </div>
    </MoreDetail>
  )
}
