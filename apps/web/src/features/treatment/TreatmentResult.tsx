import { Pill, Siren } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { LinkButton, Panel } from '../../components/ui/Panel'
import { AnswerCard, LevelPill } from '../../components/ui/Simple'
import { useAuth } from '../../lib/auth'
import type { AssessmentOut } from '../../lib/treatment/engine'
import { useRunner } from './runner'

/**
 * Step 21: what the check-in means now. Critical (tier 3) starts Act Now at once; mild or needs
 * treatment (tiers 1–2) point to the Medication Guide condition, where the CMO confirms the dose.
 */
export function TreatmentResult({ plan, source, profileKnown = true }: { plan: AssessmentOut | null | undefined; source: 'checkin' | 'device'; profileKnown?: boolean }) {
  const me = useAuth((s) => s.user)
  const running = useRunner((s) => s.episode)
  const start = useRunner((s) => s.start)
  const navigate = useNavigate()
  const started = useRef(false)
  const critical = plan && plan.tier === 3 && plan.critical.length > 0
  useEffect(() => {
    if (!critical || started.current || !me?.astronautCode) return
    started.current = true
    if (running && !running.finished) return // a treatment is already running here: don't replace it
    void start({ astronautCode: me.astronautCode, astronautName: me.displayName, plan, source, profileKnown }).then(() => navigate('/astronaut/act'))
  }, [critical, me, plan, running, source, profileKnown, start, navigate])

  if (!plan || plan.tier === 0) return null
  if (critical) {
    return (
      <AnswerCard level="help" role="alert" headline={`Critical: act now — ${plan.critical.map((p) => p.title).join(', ')}`}
        actions={<LinkButton to="/astronaut/act" variant="danger"><Siren className="h-4 w-4" aria-hidden /> Open Act Now</LinkButton>}>
        Opening the step-by-step treatment. Call the crew medical officer.
      </AnswerCard>
    )
  }
  return (
    <Panel title="What to do now">
      <ul className="space-y-3">
        {plan.routine.map((r) => (
          <li key={r.condition} className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-base font-semibold">
              <LevelPill level={r.tier === 2 ? 'care' : 'ok'}>{r.tier === 2 ? 'Needs treatment' : 'Mild'}</LevelPill> {r.title}
            </span>
            <LinkButton to={`/astronaut/medicine?condition=${r.condition}`} variant={r.tier === 2 ? 'primary' : 'ghost'}>
              <Pill className="h-4 w-4" aria-hidden /> What can I take?
            </LinkButton>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-ink-muted">The Medication Guide asks a few safety questions and checks your allergies and other medicines; the crew medical officer confirms the dose.</p>
    </Panel>
  )
}
