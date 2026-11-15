import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, BookOpen, CheckCircle2, MapPin, Phone, Pill, ShieldCheck, Stethoscope, TriangleAlert, XCircle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmergencyProtocolCard } from '../../components/ui/EmergencyProtocolCard'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { AnswerCard, LevelPill, MoreDetail, PageHeader } from '../../components/ui/Simple'
import { api, unwrap } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import {
  clock, newDoseId, OUTCOME_WORD, STATUS_WORD, useCrewDoses, useDoses, useFormulary,
  type Advice, type Condition, type Dose, type Formulary, type MedOption,
} from './medication'

/**
 * Medication Guide (Step 20): "what can I safely take?" for the astronaut. The medicine and the dose
 * come from the flight surgeons' medicine list and fixed safety checks, never from the AI; the crew
 * medical officer (CMO) confirms before it is taken.
 */
export function MedicationGuidePage() {
  const code = useAuth((s) => s.user?.astronautCode)
  const formulary = useFormulary()
  const doses = useDoses(code)
  const [params, setParams] = useSearchParams()
  const conditionId = params.get('condition')
  const condition = formulary.data?.conditions.find((c) => c.id === conditionId)
  const open = (doses.data ?? []).filter((d) => d.status === 'Requested' || d.status === 'Confirmed' || d.followUpDue || worseLately(d))

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Medicines" purpose="What can I safely take from the medical kit? Answer a few questions; the crew medical officer confirms." />
      {formulary.isPending && <Loading />}
      {formulary.error && <ErrorNote error={formulary.error} />}
      {formulary.data && <DemoNote formulary={formulary.data} />}
      {open.length > 0 && (
        <section aria-labelledby="my-doses" className="space-y-3">
          <h2 id="my-doses" className="text-lg font-semibold">Waiting for you</h2>
          {open.map((d) => <MyDoseCard key={d.id} dose={d} code={code!} />)}
        </section>
      )}
      {formulary.data?.viewerIsCmo && <CmoQueue />}
      {formulary.data && code && (condition
        ? <ConditionFlow key={condition.id} condition={condition} formulary={formulary.data} code={code} isCmo={formulary.data.viewerIsCmo}
            onBack={() => setParams({})} />
        : <ConditionPicker conditions={formulary.data.conditions} onPick={(id) => setParams({ condition: id })} />)}
      {(doses.data?.length ?? 0) > 0 && (
        <MoreDetail label="My medicine history">
          <ul className="space-y-2">
            {doses.data!.map((d) => (
              <li key={d.id} className="rounded-lg border border-line px-3 py-2 text-sm text-ink">
                <span className="font-medium">{d.medicineName}</span>, {d.doseText} · {d.conditionTitle}
                <span className="block text-xs text-ink-muted">
                  {STATUS_WORD[d.status]}{d.takenAt && ` at ${clock(d.takenAt)}`}{d.outcome && ` · ${OUTCOME_WORD[d.outcome]}`}
                  {d.reviewedBy && ` · reviewed by ${d.reviewedBy}`}{d.reviewNote && `: “${d.reviewNote}”`}
                </span>
              </li>
            ))}
          </ul>
        </MoreDetail>
      )}
    </div>
  )
}

/** "Worse" in the last 12 hours stays at the top: call the CMO. */
function worseLately(d: Dose): boolean {
  return d.outcome === 'worse' && d.outcomeAt !== null && Date.now() - new Date(d.outcomeAt).getTime() < 12 * 3_600_000
}

function DemoNote({ formulary }: { formulary: Formulary }) {
  if (formulary.status !== 'demo') return null
  return (
    <p role="note" className="flex gap-2 rounded-lg border border-status-yellow/50 bg-status-yellow/10 px-3 py-2 text-sm text-ink">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-yellow" aria-hidden />
      <span><strong>Demo medicine list:</strong> doses come from public over-the-counter labels and are not approved by a flight surgeon. Not for real medical use.</span>
    </p>
  )
}

// --- choose a problem --------------------------------------------------------------------------

function ConditionPicker({ conditions, onPick }: { conditions: Condition[]; onPick: (id: string) => void }) {
  return (
    <section aria-labelledby="pick" className="space-y-3">
      <h2 id="pick" className="text-lg font-semibold">What is bothering you?</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {conditions.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onPick(c.id)}
              className="flex h-full min-h-20 w-full flex-col items-start rounded-xl border border-line bg-surface p-4 text-left hover:border-accent hover:bg-accent-soft">
              <span className="text-base font-semibold">{c.title}</span>
              <span className="mt-1 text-sm text-ink-muted">{c.plain}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-muted">
        Something else, or feeling very unwell? Call the crew medical officer, or open <Link to="/astronaut/emergency" className="text-accent underline">Emergency</Link>.
      </p>
    </section>
  )
}

// --- one problem: safety questions, then the safe options ---------------------------------------

function ConditionFlow({ condition, formulary, code, isCmo, onBack }: {
  condition: Condition; formulary: Formulary; code: string; isCmo: boolean; onBack: () => void
}) {
  const [answers, setAnswers] = useState<Record<string, boolean>>({})
  const all = condition.redFlags.every((f) => f.id in answers)
  const check = useMutation({
    mutationFn: () => unwrap(api.POST('/api/astronauts/{astronaut}/medication/advice', {
      params: { path: { astronaut: code } }, body: { conditionId: condition.id, answers },
    })),
  })
  const answer = (id: string, yes: boolean) => {
    setAnswers((a) => ({ ...a, [id]: yes }))
    check.reset()
  }
  return (
    <section aria-labelledby="flow" className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1 text-sm text-accent">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All problems
      </button>
      <div>
        <h2 id="flow" className="text-xl font-semibold">{condition.title}</h2>
        <p className="mt-1 text-base text-ink-muted">{condition.plain}</p>
      </div>
      <Panel title="First, a few safety questions">
        <ol className="space-y-3">
          {condition.redFlags.map((f, i) => (
            <li key={f.id}>
              <fieldset className="flex flex-wrap items-center justify-between gap-2">
                <legend className="sr-only">Question {i + 1}</legend>
                <p className="max-w-lg text-base">{f.question}</p>
                <div className="flex gap-2">
                  {([['No', false], ['Yes', true]] as const).map(([label, yes]) => (
                    <button key={label} type="button" aria-pressed={answers[f.id] === yes} onClick={() => answer(f.id, yes)}
                      aria-label={`${label}: ${f.question}`}
                      className={`min-h-11 min-w-16 rounded-lg border px-4 text-sm font-semibold ${answers[f.id] === yes
                        ? yes ? 'border-status-red bg-status-red text-on-status' : 'border-accent bg-accent text-on-accent'
                        : 'border-line-strong hover:bg-subtle'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
        <Button className="mt-4 w-full sm:w-auto" disabled={!all || check.isPending} onClick={() => check.mutate()}>
          <ShieldCheck className="h-4 w-4" aria-hidden /> {all ? 'Check what I can take' : 'Answer every question first'}
        </Button>
        {check.isError && <ErrorNote error={check.error} />}
      </Panel>
      {check.data && <AdviceView advice={check.data} answers={answers} isCmo={isCmo} formulary={formulary} />}
    </section>
  )
}

function AdviceView({ advice, answers, isCmo, formulary }: {
  advice: Advice; answers: Record<string, boolean>; isCmo: boolean; formulary: Formulary
}) {
  if (advice.stop) {
    return advice.stop.action === 'emergency' && advice.stop.protocol ? (
      <div className="space-y-3">
        <AnswerCard level="help" role="alert" headline="Stop: this needs help now">
          You answered yes to: “{advice.stop.question}” Don't take anything from the kit. Call the crew medical officer and follow these steps.
        </AnswerCard>
        <EmergencyProtocolCard id={advice.stop.protocol} />
      </div>
    ) : (
      <AnswerCard level="help" role="alert" headline="Don't take anything yet: call the crew medical officer now">
        You answered yes to: “{advice.stop.question}” This needs a person to look at it before any medicine.
      </AnswerCard>
    )
  }
  const best = advice.options.find((o) => o.medicineId === advice.recommended)
  const others = advice.options.filter((o) => o !== best)
  return (
    <div className="space-y-4">
      {advice.nonDrug.length > 0 && (
        <Panel title="Try these first">
          <ul className="list-disc space-y-1 pl-5 text-base">{advice.nonDrug.map((s) => <li key={s}>{s}</li>)}</ul>
        </Panel>
      )}
      {best ? (
        <RecommendedCard option={best} advice={advice} answers={answers} isCmo={isCmo} />
      ) : (
        <AnswerCard level="care" role="status" headline="No safe medicine in the kit for you right now">
          Every medicine for this problem is blocked for you (see below). Call the crew medical officer; the flight surgeon is told.
        </AnswerCard>
      )}
      {others.length > 0 && (
        <Panel title={best ? 'Other medicines for this' : 'Why each medicine is blocked'}>
          <ul className="space-y-3">{others.map((o) => <OptionRow key={o.medicineId} option={o} />)}</ul>
        </Panel>
      )}
      <p className="text-xs text-ink-muted">
        Medicine list version {advice.formularyVersion} ({formulary.status === 'demo' ? 'demo, not approved' : `approved by ${formulary.approvedBy}`}).{' '}
        {best && <a href={best.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline"><BookOpen className="h-3 w-3" aria-hidden />Label source</a>}
      </p>
    </div>
  )
}

function Checks({ option }: { option: MedOption }) {
  if (option.checks.length === 0 && option.cautions.length === 0) return null
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {option.checks.map((c) => (
        <li key={c.code + c.text} className="flex gap-1.5">
          {c.level === 'block'
            ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-red" aria-hidden />
            : <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-yellow" aria-hidden />}
          <span><span className="sr-only">{c.level === 'block' ? 'Blocked: ' : 'Careful: '}</span>{c.text}</span>
        </li>
      ))}
      {option.cautions.map((c) => (
        <li key={c} className="flex gap-1.5 text-ink-muted"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{c}</li>
      ))}
    </ul>
  )
}

function OptionRow({ option }: { option: MedOption }) {
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{option.name} {option.strength}</span>
        <LevelPill level={option.status === 'blocked' ? 'help' : option.status === 'caution' ? 'care' : 'ok'}>
          {option.status === 'blocked' ? 'Not for you now' : option.status === 'caution' ? 'Possible, with care' : 'OK'}
        </LevelPill>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{option.doseText} · {option.when}</p>
      <Checks option={option} />
      {option.nextAllowedAt && <p className="mt-1 text-sm">Next possible at <strong>{clock(option.nextAllowedAt)}</strong>.</p>}
    </li>
  )
}

function RecommendedCard({ option, advice, answers, isCmo }: {
  option: MedOption; advice: Advice; answers: Record<string, boolean>; isCmo: boolean
}) {
  const queryClient = useQueryClient()
  const [alone, setAlone] = useState(isCmo)
  const [reason, setReason] = useState(isCmo ? 'I am the crew medical officer' : '')
  const request = useMutation({
    mutationFn: () => unwrap(api.POST('/api/medication/doses', {
      body: {
        id: newDoseId(), conditionId: advice.conditionId, medicineId: option.medicineId, answers,
        selfConfirmReason: alone ? reason.trim() : null,
      },
    })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['medication-doses'] })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!alone || reason.trim().length >= 3) request.mutate()
  }
  return (
    <AnswerCard level={option.status === 'caution' ? 'care' : 'ok'} headline={`${option.name} ${option.strength}: ${option.doseText}`}>
      <p>{option.when}</p>
      <p className="mt-1 text-sm text-ink-muted">{option.how}</p>
      <p className="mt-1 inline-flex items-center gap-1 text-sm"><MapPin className="h-4 w-4" aria-hidden /> {option.kitLocation}</p>
      <Checks option={option} />
      {request.isSuccess ? (
        <p className="mt-3 flex items-center gap-2 text-base font-semibold text-status-green" role="status">
          <CheckCircle2 className="h-5 w-5" aria-hidden />
          {request.data.status === 'Confirmed' ? 'Confirmed. It is at the top of this page: take it, then tap “I took it”.' : 'Sent to the crew medical officer. You will see here when it is confirmed.'}
        </p>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          {!isCmo && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={alone} onChange={(e) => setAlone(e.target.checked)} className="h-5 w-5" />
              No crew medical officer available: I confirm it myself
            </label>
          )}
          {alone && (
            <label className="block text-sm">
              <span className="font-medium">Why (the flight surgeon will see this)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required minLength={3}
                placeholder="e.g. CMO on EVA" className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 outline-none focus:border-accent" />
            </label>
          )}
          <Button type="submit" disabled={request.isPending || (alone && reason.trim().length < 3)}>
            {alone ? <><ShieldCheck className="h-4 w-4" aria-hidden /> Confirm and take it</> : <><Stethoscope className="h-4 w-4" aria-hidden /> Ask the CMO to confirm</>}
          </Button>
          {request.isError && <ErrorNote error={request.error} />}
        </form>
      )}
    </AnswerCard>
  )
}

// --- my doses: waiting, take it, did it help? ------------------------------------------------------

function MyDoseCard({ dose, code }: { dose: Dose; code: string }) {
  const queryClient = useQueryClient()
  const done = () => void queryClient.invalidateQueries({ queryKey: ['medication-doses', code] })
  const act = useMutation({
    mutationFn: (what: 'taken' | 'cancel') => unwrap(what === 'taken'
      ? api.POST('/api/medication/doses/{dose_id}/taken', { params: { path: { dose_id: dose.id } } })
      : api.POST('/api/medication/doses/{dose_id}/cancel', { params: { path: { dose_id: dose.id } } })),
    onSuccess: done,
  })
  const outcome = useMutation({
    mutationFn: (o: 'better' | 'same' | 'worse') =>
      unwrap(api.POST('/api/medication/doses/{dose_id}/outcome', { params: { path: { dose_id: dose.id } }, body: { outcome: o } })),
    onSuccess: done,
  })
  const title = `${dose.medicineName}: ${dose.doseText}`
  if (outcome.data?.outcome === 'worse' || worseLately(dose)) {
    return (
      <AnswerCard level="help" role="alert" headline="Call the crew medical officer now">
        You feel worse after {dose.medicineName}. Don't take more. The flight surgeon is told.
      </AnswerCard>
    )
  }
  if (dose.status === 'Taken' && dose.followUpDue) {
    return (
      <AnswerCard level="care" headline={`Did ${dose.medicineName} help?`}
        actions={(['better', 'same', 'worse'] as const).map((o) => (
          <Button key={o} variant={o === 'worse' ? 'danger' : o === 'better' ? 'primary' : 'ghost'} disabled={outcome.isPending} onClick={() => outcome.mutate(o)}>
            {OUTCOME_WORD[o]}
          </Button>
        ))}>
        You took it at {clock(dose.takenAt!)} for {dose.conditionTitle.toLowerCase()}.
        {outcome.data?.outcome === 'same' && ' If it does not get better, call the crew medical officer.'}
      </AnswerCard>
    )
  }
  if (dose.status === 'Confirmed') {
    return (
      <AnswerCard level="ok" headline={`Take it now: ${title}`}
        actions={<>
          <Button disabled={act.isPending} onClick={() => act.mutate('taken')}><Pill className="h-4 w-4" aria-hidden /> I took it</Button>
          <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cancel')}>I don't need it</Button>
        </>}>
        <p>{dose.whenText} {dose.how}</p>
        <p className="mt-1 inline-flex items-center gap-1 text-sm"><MapPin className="h-4 w-4" aria-hidden /> {dose.kitLocation}</p>
        <p className="mt-1 text-sm text-ink-muted">
          Confirmed by {dose.confirmedBy}{dose.selfConfirmed ? ' (yourself; the flight surgeon will review it)' : ''}.
        </p>
        {act.isError && <ErrorNote error={act.error} />}
      </AnswerCard>
    )
  }
  return (
    <AnswerCard level="care" headline={`Waiting for the CMO: ${title}`}
      actions={<Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cancel')}>Cancel</Button>}>
      For {dose.conditionTitle.toLowerCase()}, asked at {clock(dose.requestedAt)}. Don't take it until it is confirmed.
      <span className="mt-1 flex items-center gap-1 text-sm text-ink-muted"><Phone className="h-4 w-4" aria-hidden /> In a hurry? Call the crew medical officer.</span>
    </AnswerCard>
  )
}

// --- the crew medical officer's queue ----------------------------------------------------------------

function CmoQueue() {
  const crew = useCrewDoses(true)
  const waiting = (crew.data ?? []).filter((d) => d.status === 'Requested')
  return (
    <Panel title="Crew medical officer: doses to confirm">
      {crew.isPending && <Loading />}
      {crew.error && <ErrorNote error={crew.error} />}
      {crew.data && waiting.length === 0 && <p className="text-sm text-ink-muted">No crew member is waiting for a medicine.</p>}
      <ul className="space-y-3">{waiting.map((d) => <CmoRow key={d.id} dose={d} />)}</ul>
    </Panel>
  )
}

function CmoRow({ dose }: { dose: Dose }) {
  const queryClient = useQueryClient()
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const decide = useMutation({
    mutationFn: (approve: boolean) => unwrap(api.POST('/api/medication/doses/{dose_id}/confirm', {
      params: { path: { dose_id: dose.id } }, body: { approve, reason: approve ? null : reason.trim() },
    })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['medication-doses'] }),
  })
  return (
    <li className="rounded-lg border border-line p-3">
      <p className="text-base font-semibold">{dose.astronautName}: {dose.medicineName}, {dose.doseText}</p>
      <p className="text-sm text-ink-muted">For {dose.conditionTitle.toLowerCase()} · asked at {clock(dose.requestedAt)} · all safety questions answered “no”</p>
      {dose.checks.length > 0 && (
        <ul className="mt-1 space-y-1 text-sm">
          {dose.checks.map((c) => <li key={c.text} className="flex gap-1.5"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-yellow" aria-hidden />{c.text}</li>)}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}><CheckCircle2 className="h-4 w-4" aria-hidden /> Confirm</Button>
        {!declining && <Button variant="ghost" onClick={() => setDeclining(true)}>Decline</Button>}
      </div>
      {declining && (
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) decide.mutate(false) }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. I'll examine you first" aria-label="Reason for declining"
            className="min-h-11 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none focus:border-accent" />
          <Button type="submit" variant="danger" disabled={decide.isPending || reason.trim().length < 3}>Decline</Button>
        </form>
      )}
      {decide.isError && <ErrorNote error={decide.error} />}
    </li>
  )
}
