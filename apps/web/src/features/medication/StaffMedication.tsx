import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, Pill, Save, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { api, unwrap } from '../../lib/api'
import { clock, OUTCOME_WORD, STATUS_WORD, useCrewDoses, useDoses, useFormulary, useMedicalProfile, type Dose, type Formulary, type MedicalProfile } from './medication'

/** Why the flight surgeon should look at a dose: given without the CMO, or the astronaut feels worse. */
function flags(d: Dose): string[] {
  const out: string[] = []
  if (d.selfConfirmed) out.push(`Confirmed alone: “${d.selfConfirmReason ?? ''}”`)
  if (d.outcome === 'worse') out.push('Feels worse after it')
  if (d.checks.some((c) => c.level === 'caution')) out.push('Given with a caution')
  return out
}

/** Crew overview (flight surgeon): doses not reviewed yet, the most important first. */
export function MedicinesToReview() {
  const crew = useCrewDoses(true)
  const todo = (crew.data ?? [])
    .filter((d) => !d.reviewedAt && (d.status === 'Taken' || d.status === 'Confirmed'))
    .sort((a, b) => flags(b).length - flags(a).length)
  if (!crew.data || todo.length === 0) return null
  return (
    <Panel title={`Medicines to review (${todo.length})`}>
      <ul className="space-y-2">
        {todo.slice(0, 6).map((d) => (
          <li key={d.id}>
            <Link to={`/staff/astronaut/${d.astronautCode}?view=medicines`} className="block rounded-lg border border-line px-3 py-2 text-sm hover:border-accent">
              <span className="font-semibold">{d.astronautCode}</span> · {d.medicineName}, {d.doseText} · {d.conditionTitle}
              {flags(d).length > 0 && <span className="mt-0.5 block text-xs text-status-yellow">{flags(d).join(' · ')}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** One astronaut (flight surgeon): their doses with the review, and their medical profile. */
export function StaffMedicinePanel({ code }: { code: string }) {
  const doses = useDoses(code)
  const formulary = useFormulary()
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Medicines given onboard">
        {doses.isPending && <Loading />}
        {doses.error && <ErrorNote error={doses.error} />}
        {doses.data?.length === 0 && <p className="text-sm text-ink-muted">No medicine from the Medication Guide yet.</p>}
        <ul className="space-y-3">{doses.data?.map((d) => <DoseReview key={d.id} dose={d} />)}</ul>
      </Panel>
      {formulary.data && <ProfileEditor code={code} formulary={formulary.data} />}
    </div>
  )
}

function DoseReview({ dose }: { dose: Dose }) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const review = useMutation({
    mutationFn: () => unwrap(api.POST('/api/medication/doses/{dose_id}/review', { params: { path: { dose_id: dose.id } }, body: { note } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['medication-doses'] }),
  })
  return (
    <li className="rounded-lg border border-line p-3 text-sm">
      <p className="flex items-center gap-1.5 text-base font-semibold"><Pill className="h-4 w-4" aria-hidden /> {dose.medicineName}, {dose.doseText}</p>
      <p className="text-ink-muted">
        {dose.conditionTitle} · {STATUS_WORD[dose.status]}{dose.takenAt && ` at ${clock(dose.takenAt)}`}
        {dose.confirmedBy && ` · confirmed by ${dose.confirmedBy}`}{dose.outcome && ` · ${OUTCOME_WORD[dose.outcome]}`}
      </p>
      {dose.declineReason && <p className="text-ink-muted">Declined: {dose.declineReason}</p>}
      {[...flags(dose), ...dose.checks.map((c) => c.text)].filter((v, i, a) => a.indexOf(v) === i).map((f) => (
        <p key={f} className="mt-1 flex gap-1.5 text-status-yellow"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{f}</p>
      ))}
      {dose.reviewedAt ? (
        <p className="mt-2 inline-flex items-center gap-1 text-status-green"><CheckCheck className="h-4 w-4" aria-hidden />
          Reviewed by {dose.reviewedBy}{dose.reviewNote && `: “${dose.reviewNote}”`}</p>
      ) : (dose.status === 'Taken' || dose.status === 'Confirmed') && (
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); review.mutate() }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note for the crew (optional)" aria-label={`Review note for ${dose.medicineName}`}
            className="min-h-11 flex-1 rounded-lg border border-line-strong bg-surface px-3 outline-none focus:border-accent" />
          <Button type="submit" disabled={review.isPending}>Mark reviewed</Button>
        </form>
      )}
      {review.isError && <ErrorNote error={review.error} />}
    </li>
  )
}

function ProfileEditor({ code, formulary }: { code: string; formulary: Formulary }) {
  const profile = useMedicalProfile(code)
  return (
    <Panel title="Allergies, conditions, regular medicines">
      {profile.isPending && <Loading />}
      {profile.error && <ErrorNote error={profile.error} />}
      {profile.data && <ProfileForm key={profile.data.updatedAt ?? 'none'} code={code} profile={profile.data} formulary={formulary} />}
    </Panel>
  )
}

function ProfileForm({ code, profile, formulary }: { code: string; profile: MedicalProfile; formulary: Formulary }) {
  const queryClient = useQueryClient()
  const [allergies, setAllergies] = useState(new Set(profile.allergies))
  const [conditions, setConditions] = useState(new Set(profile.conditions))
  const [medicines, setMedicines] = useState(new Set(profile.regularMedicines))
  const [note, setNote] = useState(profile.note)
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT('/api/astronauts/{astronaut}/medical-profile', {
      params: { path: { astronaut: code } },
      body: { allergies: [...allergies], conditions: [...conditions], regularMedicines: [...medicines], note },
    })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['medical-profile', code] }),
  })
  const group = (title: string, options: Record<string, string>, value: Set<string>, set: (s: Set<string>) => void) => (
    <fieldset className="space-y-1" disabled={!profile.canEdit}>
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      {Object.entries(options).map(([id, label]) => (
        <label key={id} className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={value.has(id)}
            onChange={(e) => { const next = new Set(value); if (e.target.checked) next.add(id); else next.delete(id); set(next) }} />
          {label}
        </label>
      ))}
    </fieldset>
  )
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <p className="text-sm text-ink-muted">The Medication Guide checks every medicine against this list. Changes reach the habitat with the next link window.</p>
      {group('Allergies', formulary.vocabulary.allergies, allergies, setAllergies)}
      {group('Health conditions', formulary.vocabulary.conditions, conditions, setConditions)}
      {group('Regular medicines', formulary.vocabulary.regularMedicines, medicines, setMedicines)}
      <label className="block text-sm">
        <span className="font-semibold">Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={!profile.canEdit}
          className="mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 outline-none focus:border-accent" />
      </label>
      {profile.canEdit && <Button type="submit" disabled={save.isPending}><Save className="h-4 w-4" aria-hidden /> Save</Button>}
      {profile.updatedBy && <p className="text-xs text-ink-muted">Last changed by {profile.updatedBy}{profile.updatedAt && ` · ${clock(profile.updatedAt)}`}</p>}
      {save.isError && <ErrorNote error={save.error} />}
      {save.isSuccess && <p role="status" className="text-sm text-status-green">Saved.</p>}
    </form>
  )
}
