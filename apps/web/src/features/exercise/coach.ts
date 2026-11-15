// The coach engine (Step 13; LLD §15.6): counts reps and checks posture from body points, and walks
// through today's plan (sets, rests, next exercise). Pure: no camera, DOM or React, so it is tested
// with generated movement (unit/coach.test.ts). Time `t` is in milliseconds.
//
// Each exercise follows one joint measure through a rep with hysteresis (start below one threshold,
// finish above another), so noise near a threshold cannot count twice. Seen from the front, a squat's
// knee angle hardly changes in the picture, so the drop of the hips (against standing height) is
// turned into the same angle scale instead. A rep is judged when it ends:
// deep enough to count, and which posture tips apply. Tips are coaching, not a diagnosis.
import { angle, bestSide, facingCamera, leanFromVertical, mid, torsoLength, visible, type Pose, type Side } from './pose.ts'

export type ExerciseId = 'squat' | 'deadlift' | 'heel_raise'

/** Everything the coach can say about a rep. `miss` means the rep did not count. */
export const TIPS = {
  squat_depth_miss: 'Go lower: thighs about level with the floor. That one did not count.',
  squat_shallow: 'A little lower next time.',
  chest_up: 'Keep your chest up.',
  knees_out: 'Push your knees out over your toes.',
  hinge_more: 'Push your hips further back. That one did not count.',
  hinge_not_squat: 'Hinge at the hips: keep your knees softer, this is not a squat.',
  lock_out: 'Stand all the way up at the top: hips forward.',
  keep_close: 'Keep your hands close to your legs.',
  rise_higher: 'Rise higher onto the balls of your feet. That one did not count.',
  knees_straight: 'Keep your knees straight.',
  too_fast: 'Slow down: about 2 seconds down and 2 seconds up.',
  too_fast_heel: 'Slow down: rise, hold for a moment, then lower slowly.',
  step_back: 'Step back so the camera sees your whole body, head to feet.',
  turn_side: 'Turn side-on to the camera for the best posture checks.',
} as const
export type TipCode = keyof typeof TIPS

const MISS: TipCode[] = ['squat_depth_miss', 'hinge_more', 'rise_higher']

export interface RepResult {
  counted: boolean
  score: number // 0-100; 0 when not counted
  tips: TipCode[]
  seconds: number
}

/** What the counter sees in one frame. */
export interface Frame {
  visible: boolean
  phase: 'ready' | 'moving' | 'hidden'
  measure: number | null // the joint measure being followed (degrees or lift)
  progress: number // 0 at rest, 1 at the deepest point needed to count
  watch: number[] // body points to highlight (where a tip applies)
  rep?: RepResult
}

interface Spec {
  needed: (keyof Side)[]
  /** The followed measure; `up` is the resting position (start of a rep). */
  measure: (pose: Pose, side: Side) => number
  start: (m: number) => boolean // leaving the resting position
  rest: (m: number) => boolean // back at the resting position
  progress: (m: number) => number
  judge: (track: Track, view: 'side' | 'front') => { counted: boolean; tips: TipCode[] }
  watch: Partial<Record<TipCode, (side: Side) => number[]>>
  minSeconds: number
  fastTip: TipCode
}

/** What is followed during one rep. */
interface Track {
  start: number
  extreme: number // deepest measure (min angle, or max lift)
  maxLean: number
  minKnee: number
  minKneeGap: number // front view: knee distance / ankle distance
  maxReach: number // hands ahead of the feet, in torso lengths
  topAfter: number // best measure in the moment after the rep ends (lock-out)
}

const smaller = (a: number, b: number) => Math.min(a, b)

const SPECS: Record<ExerciseId, Spec> = {
  squat: {
    needed: ['shoulder', 'hip', 'knee', 'ankle'],
    measure: (p, s) => angle(p[s.hip], p[s.knee], p[s.ankle]),
    start: (m) => m < 150,
    rest: (m) => m > 160,
    progress: (m) => clamp01((170 - m) / (170 - 100)),
    judge: (t, view) => {
      const tips: TipCode[] = []
      const counted = t.extreme <= 115
      if (!counted) tips.push('squat_depth_miss')
      else if (t.extreme > 100) tips.push('squat_shallow')
      if (view === 'side' && t.maxLean > 50) tips.push('chest_up')
      if (view === 'front' && t.minKneeGap < 0.75) tips.push('knees_out')
      return { counted, tips }
    },
    watch: {
      squat_depth_miss: (s) => [s.hip, s.knee],
      squat_shallow: (s) => [s.hip, s.knee],
      chest_up: (s) => [s.shoulder, s.hip],
      knees_out: () => [25, 26],
    },
    minSeconds: 1.6,
    fastTip: 'too_fast',
  },
  deadlift: {
    needed: ['shoulder', 'hip', 'knee', 'ankle'],
    measure: (p, s) => angle(p[s.shoulder], p[s.hip], p[s.knee]),
    start: (m) => m < 145,
    rest: (m) => m > 160,
    progress: (m) => clamp01((170 - m) / (170 - 110)),
    judge: (t, view) => {
      const tips: TipCode[] = []
      const counted = t.extreme <= 110
      if (!counted) tips.push('hinge_more')
      if (t.minKnee < 110) tips.push('hinge_not_squat')
      if (t.topAfter < 168) tips.push('lock_out')
      if (view === 'side' && t.maxReach > 0.55) tips.push('keep_close')
      return { counted, tips }
    },
    watch: {
      hinge_more: (s) => [s.shoulder, s.hip],
      hinge_not_squat: (s) => [s.knee],
      lock_out: (s) => [s.hip],
      keep_close: (s) => [s.wrist],
    },
    minSeconds: 1.6,
    fastTip: 'too_fast',
  },
  heel_raise: {
    needed: ['hip', 'knee', 'ankle', 'heel', 'toe'],
    // heel height above the toes, in shin lengths (flat feet: about 0; this is relative to `floor`)
    measure: (p, s) => (p[s.toe].y - p[s.heel].y) / Math.max(1e-6, Math.hypot(p[s.knee].x - p[s.ankle].x, p[s.knee].y - p[s.ankle].y)),
    start: (m) => m > 0.06,
    rest: (m) => m < 0.03,
    progress: (m) => clamp01(m / 0.12),
    judge: (t) => {
      const tips: TipCode[] = []
      const counted = t.extreme >= 0.1
      if (!counted) tips.push('rise_higher')
      if (t.minKnee < 155) tips.push('knees_straight')
      return { counted, tips }
    },
    watch: {
      rise_higher: (s) => [s.heel, s.toe],
      knees_straight: (s) => [s.knee],
    },
    minSeconds: 1.2,
    fastTip: 'too_fast_heel',
  },
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const LOCKOUT_MS = 400 // after a rep ends, watch this long for the full stand (deadlift lock-out)
const HIDDEN_MS = 500 // body not seen for this long: pause and ask to step back

/** Counts the reps of one exercise. Feed it every frame; it reports finished reps. */
export class RepCounter {
  readonly exercise: ExerciseId
  private spec: Spec
  private smooth: number | null = null
  private track: Track | null = null
  private ending: { track: Track; until: number } | null = null
  private floor: { value: number; at: number }[] = [] // heel raise: recent flat-foot measures
  private standing: { value: number; at: number }[] = [] // squat: recent hip heights above the ankles
  private lastSeen = -Infinity
  private side: Side | null = null
  private view: 'side' | 'front' = 'side'

  constructor(exercise: ExerciseId) {
    this.exercise = exercise
    this.spec = SPECS[exercise]
  }

  update(pose: Pose | null, t: number, aspect = 1): Frame {
    const side = pose ? bestSide(pose) : null
    const seen = !!pose && !!side && visible(pose, side, this.spec.needed, aspect)
    if (!seen || !pose || !side) {
      if (t - this.lastSeen > HIDDEN_MS) {
        this.track = null // a rep that went out of view does not count
        this.ending = null
        this.smooth = null
        return { visible: false, phase: 'hidden', measure: null, progress: 0, watch: [] }
      }
      return { visible: true, phase: this.track ? 'moving' : 'ready', measure: this.smooth, progress: 0, watch: [] }
    }
    this.lastSeen = t
    this.side = side
    this.view = facingCamera(pose) ? 'front' : 'side'

    let m = this.spec.measure(pose, side)
    if (this.exercise === 'heel_raise') m = this.relativeToFloor(m, t)
    if (this.exercise === 'squat') {
      const fromHeight = this.squatFromHeight(pose, t)
      if (this.view === 'front') m = fromHeight
    }
    this.smooth = this.smooth == null ? m : this.smooth * 0.5 + m * 0.5
    const s = this.smooth
    const frame: Frame = { visible: true, phase: 'ready', measure: s, progress: this.spec.progress(s), watch: [] }

    if (this.ending) {
      this.ending.track.topAfter = Math.max(this.ending.track.topAfter, s)
      if (t >= this.ending.until || this.spec.start(s)) {
        frame.rep = this.finish(this.ending.track, t)
        frame.watch = this.watchFor(frame.rep.tips)
        this.ending = null
      }
    }
    if (this.track) {
      this.follow(this.track, pose, side, s)
      frame.phase = 'moving'
      if (this.spec.rest(s)) {
        this.track.topAfter = s
        this.ending = { track: this.track, until: t + LOCKOUT_MS }
        this.track = null
        frame.phase = 'ready'
      }
    } else if (!this.ending && this.spec.start(s)) {
      this.track = { start: t, extreme: s, maxLean: 0, minKnee: 180, minKneeGap: Infinity, maxReach: 0, topAfter: 0 }
      this.follow(this.track, pose, side, s)
      frame.phase = 'moving'
    }
    return frame
  }

  /** End of set: judge a rep that has just finished but is still being watched. */
  flush(t: number): RepResult | null {
    if (!this.ending) return null
    const rep = this.finish(this.ending.track, t)
    this.ending = null
    return rep
  }

  private follow(track: Track, pose: Pose, side: Side, s: number) {
    track.extreme = this.exercise === 'heel_raise' ? Math.max(track.extreme, s) : Math.min(track.extreme, s)
    track.maxLean = Math.max(track.maxLean, leanFromVertical(pose[side.hip], pose[side.shoulder]))
    track.minKnee = Math.min(track.minKnee, angle(pose[side.hip], pose[side.knee], pose[side.ankle]))
    const ankleGap = Math.abs(pose[27].x - pose[28].x)
    if (ankleGap > 1e-3) track.minKneeGap = smaller(track.minKneeGap, Math.abs(pose[25].x - pose[26].x) / ankleGap)
    const feet = mid(pose[side.ankle], pose[side.toe])
    const facing = Math.sign(pose[side.toe].x - pose[side.heel].x) || 1
    track.maxReach = Math.max(track.maxReach, ((pose[side.wrist].x - feet.x) * facing) / Math.max(1e-6, torsoLength(pose)))
  }

  private finish(track: Track, t: number): RepResult {
    const { counted, tips } = this.spec.judge(track, this.view)
    const seconds = (t - track.start) / 1000
    if (counted && seconds < this.spec.minSeconds) tips.push(this.spec.fastTip)
    const faults = tips.filter((c) => !MISS.includes(c) && c !== 'squat_shallow').length + (tips.includes('squat_shallow') ? 0.5 : 0)
    return { counted, tips, seconds, score: counted ? Math.max(40, Math.round(100 - 20 * faults)) : 0 }
  }

  private watchFor(tips: TipCode[]): number[] {
    const side = this.side
    if (!side) return []
    return tips.flatMap((c) => this.spec.watch[c]?.(side) ?? [])
  }

  /** Squat seen from the front: hip height against standing height, on the knee-angle scale
   * (standing 180°; hips down to about two thirds of standing height ≈ 98°, which counts). */
  private squatFromHeight(pose: Pose, t: number): number {
    const h = mid(pose[27], pose[28]).y - mid(pose[23], pose[24]).y
    this.standing = this.standing.filter((s) => t - s.at < 8000)
    this.standing.push({ value: h, at: t })
    const top = Math.max(...this.standing.map((s) => s.value))
    return Math.max(60, Math.min(180, 180 - (1 - h / Math.max(1e-6, top)) * 260))
  }

  /** Heel raise: the flat-foot level is the lowest measure of the last few seconds. */
  private relativeToFloor(m: number, t: number): number {
    this.floor = this.floor.filter((f) => t - f.at < 4000)
    this.floor.push({ value: m, at: t })
    return m - Math.min(...this.floor.map((f) => f.value))
  }

  get facing(): 'side' | 'front' {
    return this.view
  }
}

// --- The workout: sets, rests and the next exercise ---------------------------------------------

export interface PlanItem {
  exercise: ExerciseId
  name: string
  sets: number
  reps: number
}

export interface SetSummary {
  reps: number
  target: number
  formScore: number | null
}

export interface ExerciseSummary {
  exercise: ExerciseId
  name: string
  sets: SetSummary[]
  tips: { tip: string; count: number }[]
}

export type CoachEvent =
  | { kind: 'start'; name: string; set: number; sets: number; reps: number }
  | { kind: 'rep'; count: number; target: number; tips: TipCode[] }
  | { kind: 'miss'; tips: TipCode[] }
  | { kind: 'hidden' }
  | { kind: 'turn' }
  | { kind: 'set-done'; name: string; set: number; sets: number; reps: number }
  | { kind: 'rest'; seconds: number; next: string }
  | { kind: 'done' }

export interface CoachState {
  state: 'active' | 'rest' | 'done'
  item: PlanItem | null
  exerciseIndex: number
  set: number // 1-based
  reps: number
  restLeft: number // seconds
  next: string | null
  lastTips: TipCode[]
  setScore: number | null
  frame: Frame | null
}

const TIP_REPEAT_MS = 6000

export class Workout {
  readonly items: PlanItem[]
  readonly restSeconds: number
  private ex = 0
  private set = 1
  private reps = 0
  private scores: number[] = []
  private counter: RepCounter
  private state: 'active' | 'rest' | 'done' = 'active'
  private restUntil = 0
  private results: { sets: SetSummary[]; tips: Map<TipCode, number> }[]
  private lastTips: TipCode[] = []
  private lastFrame: Frame | null = null
  private hiddenSaid = -Infinity
  private turnSaid = false
  private started = false

  constructor(items: PlanItem[], restSeconds: number) {
    if (!items.length) throw new Error('A workout needs at least one exercise')
    this.items = items
    this.restSeconds = restSeconds
    this.counter = new RepCounter(items[0].exercise)
    this.results = items.map(() => ({ sets: [], tips: new Map() }))
  }

  /** Feed one frame (null: nobody detected). Returns what happened, for the screen and the voice. */
  update(pose: Pose | null, t: number, aspect = 1): CoachEvent[] {
    const events: CoachEvent[] = []
    if (!this.started) {
      this.started = true
      events.push(this.startEvent())
    }
    if (this.state === 'done') return events
    if (this.state === 'rest') {
      if (t >= this.restUntil) this.beginNext(events)
      return events
    }
    const item = this.items[this.ex]
    const frame = this.counter.update(pose, t, aspect)
    this.lastFrame = frame
    if (!frame.visible) {
      if (t - this.hiddenSaid > TIP_REPEAT_MS) {
        this.hiddenSaid = t
        events.push({ kind: 'hidden' })
      }
      return events
    }
    if (!this.turnSaid && frame.measure != null && this.counter.facing === 'front' && item.exercise !== 'squat') {
      this.turnSaid = true
      events.push({ kind: 'turn' })
    }
    if (frame.rep) this.record(frame.rep, events, t)
    return events
  }

  /** Finish the current set now (fewer reps than planned). */
  finishSet(t: number): CoachEvent[] {
    if (this.state !== 'active') return []
    const events: CoachEvent[] = []
    const rep = this.counter.flush(t)
    if (rep) this.record(rep, events, t)
    if (this.state === 'active') this.closeSet(events, t)
    return events
  }

  skipRest(t: number): CoachEvent[] {
    if (this.state !== 'rest') return []
    this.restUntil = t
    return this.update(null, t)
  }

  /** Stop the workout; the current set is kept if it has reps. */
  end(t: number): CoachEvent[] {
    if (this.state === 'done') return []
    const events: CoachEvent[] = []
    if (this.state === 'active') {
      const rep = this.counter.flush(t)
      if (rep) this.recordRep(rep, events)
      if (this.reps > 0) this.saveSet()
    }
    this.state = 'done'
    events.push({ kind: 'done' })
    return events
  }

  snapshot(t: number): CoachState {
    const nextItem = this.peekNext()
    return {
      state: this.state,
      item: this.state === 'done' ? null : this.items[this.ex],
      exerciseIndex: this.ex,
      set: this.set,
      reps: this.reps,
      restLeft: this.state === 'rest' ? Math.max(0, Math.ceil((this.restUntil - t) / 1000)) : 0,
      next: nextItem,
      lastTips: this.lastTips,
      setScore: this.scores.length ? Math.round(this.scores.reduce((a, b) => a + b, 0) / this.scores.length) : null,
      frame: this.lastFrame,
    }
  }

  summary(): ExerciseSummary[] {
    return this.items
      .map((item, i) => ({
        exercise: item.exercise,
        name: item.name,
        sets: this.results[i].sets,
        tips: [...this.results[i].tips].map(([code, count]) => ({ tip: TIPS[code], count })),
      }))
      .filter((r) => r.sets.length > 0)
  }

  private record(rep: RepResult, events: CoachEvent[], t: number) {
    this.recordRep(rep, events)
    if (this.reps >= this.items[this.ex].reps) this.closeSet(events, t)
  }

  private recordRep(rep: RepResult, events: CoachEvent[]) {
    this.scores.push(rep.score)
    this.lastTips = rep.tips
    const tally = this.results[this.ex].tips
    for (const tip of rep.tips) tally.set(tip, (tally.get(tip) ?? 0) + 1)
    if (rep.counted) {
      this.reps += 1
      events.push({ kind: 'rep', count: this.reps, target: this.items[this.ex].reps, tips: rep.tips })
    } else {
      events.push({ kind: 'miss', tips: rep.tips })
    }
  }

  private saveSet() {
    const item = this.items[this.ex]
    const score = this.scores.length ? Math.round(this.scores.reduce((a, b) => a + b, 0) / this.scores.length) : null
    this.results[this.ex].sets.push({ reps: this.reps, target: item.reps, formScore: this.reps ? score : null })
  }

  private closeSet(events: CoachEvent[], t: number) {
    const item = this.items[this.ex]
    this.saveSet()
    events.push({ kind: 'set-done', name: item.name, set: this.set, sets: item.sets, reps: this.reps })
    const next = this.peekNext()
    if (next == null) {
      this.state = 'done'
      events.push({ kind: 'done' })
      return
    }
    this.state = 'rest'
    this.restUntil = t + this.restSeconds * 1000
    events.push({ kind: 'rest', seconds: this.restSeconds, next })
  }

  private peekNext(): string | null {
    if (this.state === 'done') return null
    const item = this.items[this.ex]
    if (this.set < item.sets) return `${item.name}, set ${this.set + 1} of ${item.sets}`
    const following = this.items[this.ex + 1]
    return following ? `${following.name}, set 1 of ${following.sets}` : null
  }

  private beginNext(events: CoachEvent[]) {
    const item = this.items[this.ex]
    if (this.set < item.sets) {
      this.set += 1
    } else {
      this.ex += 1
      this.set = 1
      this.turnSaid = false
    }
    this.reps = 0
    this.scores = []
    this.lastTips = []
    this.counter = new RepCounter(this.items[this.ex].exercise)
    this.state = 'active'
    events.push(this.startEvent())
  }

  private startEvent(): CoachEvent {
    const item = this.items[this.ex]
    return { kind: 'start', name: item.name, set: this.set, sets: item.sets, reps: item.reps }
  }
}

/** The sentence spoken for an event (null: say nothing). */
export function spoken(e: CoachEvent): string | null {
  switch (e.kind) {
    case 'start':
      return `${e.name}. Set ${e.set} of ${e.sets}: ${e.reps} reps.`
    case 'rep': {
      const tip = e.tips.find((c) => c !== 'squat_shallow') ?? e.tips[0]
      return tip ? `${e.count}. ${TIPS[tip]}` : `${e.count}`
    }
    case 'miss':
      return TIPS[e.tips[0]] ?? null
    case 'hidden':
      return TIPS.step_back
    case 'turn':
      return TIPS.turn_side
    case 'set-done':
      return `Set complete: ${e.reps} reps.`
    case 'rest':
      return `Rest ${e.seconds} seconds. Next: ${e.next}.`
    case 'done':
      return 'Workout complete. Well done.'
  }
}
