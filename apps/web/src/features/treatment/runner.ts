// Act Now runner (Step 21d): walks the plan one step at a time and logs every action. The state is kept
// on this device (localStorage), so a reload or a crash resumes at the same step; every action goes
// through the offline outbox, so nothing is lost when the Habitat server is down and nothing is sent
// twice (device ids). The plan never changes during a treatment: it is the snapshot shown at the start.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { AssessmentOut, ProtocolPlanOut, StepOut } from '../../lib/treatment/engine'
import { sendOrQueue } from '../../lib/outbox'
import { medicineById } from '../../lib/treatment/bundled'

export type Source = 'checkin' | 'help-now' | 'device'
export type EndKind = 'resolved' | 'escalated' | 'cancelled'

export interface GivenDose { protocolId: string; stepId: string; medicineId: string; units: number; at: string }

export interface Episode {
  id: string
  astronautCode: string
  astronautName: string
  plan: AssessmentOut
  source: Source
  profileKnown: boolean
  startedAt: string
  protocolIndex: number
  stepId: string // a step id, or 'done' / 'escalate' while showing the end of a protocol
  stepAt: string // when this step was reached (recheck timers count from here)
  failures: Record<string, number> // `${protocolId}/${stepId}` → failed rechecks so far
  doses: GivenDose[]
  outcomes: Record<string, 'done' | 'escalate'>
  finished: boolean
}

interface RunnerState {
  episode: Episode | null
  readAloud: boolean
  start: (e: Pick<Episode, 'astronautCode' | 'astronautName' | 'plan' | 'source' | 'profileKnown'> & { id?: string; resume?: Partial<Episode> }) => Promise<void>
  log: (kind: string, data?: Record<string, unknown>, at?: { protocolId?: string; stepId?: string }) => Promise<void>
  goto: (target: string) => void
  fail: (step: StepOut) => string
  given: (d: Omit<GivenDose, 'at'>) => void
  finish: (kind: EndKind, note?: string) => Promise<void>
  clear: () => void
  setReadAloud: (on: boolean) => void
}

export function newId(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID()}`
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

const safeStorage = createJSONStorage(() => {
  try {
    return window.localStorage
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  }
})

export function currentProtocol(e: Episode): ProtocolPlanOut | undefined {
  return e.plan.critical[e.protocolIndex]
}

export function currentStep(e: Episode): StepOut | undefined {
  return currentProtocol(e)?.steps.find((s) => s.id === e.stepId)
}

/** Tier 3 only: the critical protocols, in plan order. */
export const useRunner = create<RunnerState>()(
  persist(
    (set, get) => ({
      episode: null,
      readAloud: true,
      async start({ astronautCode, astronautName, plan, source, profileKnown, id, resume }) {
        const now = new Date().toISOString()
        const episode: Episode = {
          id: id ?? newId('episode'), astronautCode, astronautName, plan, source, profileKnown, startedAt: now,
          protocolIndex: 0, stepId: plan.critical[0]?.steps[0]?.id ?? 'done', stepAt: now, failures: {}, doses: [],
          outcomes: {}, finished: false, ...resume,
        }
        set({ episode })
        if (!resume) {
          await sendOrQueue('/api/treatment/episodes', {
            id: episode.id, astronautCode, protocolIds: plan.critical.map((p) => p.id), tier: 3, source, plan, startedAt: now,
          })
        }
      },
      async log(kind, data = {}, where = {}) {
        const e = get().episode
        if (!e) return
        await sendOrQueue(`/api/treatment/episodes/${e.id}/events`, {
          id: newId('event'), kind, protocolId: where.protocolId ?? currentProtocol(e)?.id ?? null,
          stepId: where.stepId ?? (e.stepId === 'done' || e.stepId === 'escalate' ? null : e.stepId),
          at: new Date().toISOString(), data,
        })
      },
      goto(target) {
        const e = get().episode
        if (!e) return
        set({ episode: { ...e, stepId: target, stepAt: new Date().toISOString() } })
      },
      fail(step) {
        // maxRepeats = how many times the 'failed' way may be taken; after that, failedAfterMax
        const e = get().episode!
        const key = `${currentProtocol(e)?.id}/${step.id}`
        const count = e.failures[key] ?? 0
        const target = step.maxRepeats != null && count >= step.maxRepeats ? step.failedAfterMax ?? 'escalate' : step.failed ?? 'escalate'
        set({ episode: { ...e, failures: { ...e.failures, [key]: count + 1 } } })
        return target
      },
      given(d) {
        const e = get().episode
        if (!e) return
        set({ episode: { ...e, doses: [...e.doses, { ...d, at: new Date().toISOString() }] } })
      },
      async finish(kind, note) {
        const e = get().episode
        if (!e) return
        await get().log(kind, note ? { note } : {}, { protocolId: currentProtocol(e)?.id, stepId: undefined })
        set({ episode: { ...e, finished: true } })
      },
      clear: () => set({ episode: null }),
      setReadAloud: (readAloud) => set({ readAloud }),
    }),
    { name: 'astra-act-now', storage: safeStorage },
  ),
)

/** After a protocol ends (done or escalate): the next protocol of the plan, or the end of the treatment. */
export function advanceProtocol(): void {
  const { episode } = useRunner.getState()
  if (!episode) return
  const p = currentProtocol(episode)
  const outcomes = p ? { ...episode.outcomes, [p.id]: episode.stepId as 'done' | 'escalate' } : episode.outcomes
  const nextIndex = episode.protocolIndex + 1
  const next = episode.plan.critical[nextIndex]
  useRunner.setState({
    episode: next
      ? { ...episode, outcomes, protocolIndex: nextIndex, stepId: next.steps[0].id, stepAt: new Date().toISOString() }
      : { ...episode, outcomes, protocolIndex: nextIndex },
  })
}

/** Where a logged event leads (to resume an episode started on another device). */
export function targetAfter(step: StepOut, kind: string, data: Record<string, unknown>): string {
  if (kind === 'answer') return data.answer === 'yes' ? step.yes ?? step.next : step.no ?? step.next
  if (kind === 'recheck') return data.result === 'passed' ? step.passed ?? step.next : String(data.target ?? step.failed ?? step.next)
  if (kind === 'step_skipped' && step.kind === 'medicine') return step.ifNone ?? step.next
  return step.next
}

/** One logged action in plain words (timelines on the crew's and the flight surgeon's screens). */
export function describeEvent(kind: string, stepId: string | null, data: Record<string, unknown>, plan?: AssessmentOut): string {
  const step = plan?.critical.flatMap((p) => p.steps).find((s) => s.id === stepId)
  const what = step?.text ?? stepId ?? ''
  switch (kind) {
    case 'dose_given': {
      const m = medicineById(String(data.medicineId))
      return `gave ${data.units} × ${m?.name ?? data.medicineId}${data.readBackBy ? ` (checked by ${data.readBackBy})` : ' (no second check)'}`
    }
    case 'answer': return `${what}: ${data.answer}`
    case 'recheck': return `${what}: ${data.value ?? data.answer ?? ''} → ${data.result === 'passed' ? 'better' : 'not better'}`
    case 'step_done': return data.value !== undefined ? `${what}: ${data.value}` : `done: ${what}`
    case 'step_skipped': return `skipped: ${what}${data.reason ? ` (${data.reason})` : ''}`
    case 'note': return `note: ${data.text}`
    default: return kind
  }
}
