// A simulated person doing the plan, as MediaPipe-style landmarks (Step 13 demo playback and tests).
// It makes a few deliberate mistakes so the coach has something to say: one shallow squat, one with
// the chest dropping, one too fast; a deadlift done like a squat, one not finished at the top, one
// with the hands too far forward; a heel raise too low and one with bent knees.
// Built as a 2D side view (x forward, y up, floor at 0, body height 1), then placed in the picture.
import type { ExerciseId } from './coach.ts'
import type { Landmark } from './pose.ts'

export type Fault = 'shallow' | 'lean' | 'fast' | 'squat' | 'nolock' | 'reach' | 'low' | 'bentknees' | 'valgus'

/** Which rep (0-based, counting every attempt of that exercise) gets which mistake. */
export const DEMO_FAULTS: Record<ExerciseId, Record<number, Fault>> = {
  squat: { 2: 'shallow', 5: 'lean', 8: 'fast' },
  deadlift: { 1: 'squat', 4: 'nolock', 7: 'reach' },
  heel_raise: { 3: 'low', 8: 'bentknees' },
}
const PERIOD: Record<ExerciseId, number> = { squat: 3.2, deadlift: 3.0, heel_raise: 2.4 } // seconds per rep

type V = [number, number]
const rad = (deg: number) => (deg * Math.PI) / 180
const add = (p: V, len: number, deg: number): V => [p[0] + len * Math.sin(rad(deg)), p[1] + len * Math.cos(rad(deg))]
// segment lengths, as a share of body height
const SHIN = 0.25, THIGH = 0.245, TORSO = 0.3, UPPER_ARM = 0.17, FOREARM = 0.16

interface Joints {
  heel: V; toe: V; ankle: V; knee: V; hip: V; shoulder: V; elbow: V; wrist: V; nose: V; ear: V
}

/**
 * Side-view joints for one exercise at depth d (0 = standing, 1 = bottom of the rep).
 * Angles are from vertical, forward positive: shin `a`, thigh `b`, torso `c`, arms `arm` (from down).
 */
export function joints(exercise: ExerciseId, d: number, fault?: Fault): Joints {
  let heel: V = [-0.04, 0], toe: V = [0.12, 0], ankle: V = [0, 0.045]
  let a = 0, knee = 177, c = 2, arm = 0
  if (exercise === 'squat') {
    knee = 177 - 87 * d
    a = 30 * d
    c = 10 + 30 * d + (fault === 'lean' ? 32 * d : 0)
    arm = 10 + 75 * d
  } else if (exercise === 'deadlift') {
    if (fault === 'squat') {
      knee = 177 - 85 * d
      a = 25 * d
      c = 2 + 45 * d
    } else {
      knee = 177 - 32 * d
      a = 5 * d
      c = 2 + 58 * d
    }
    arm = fault === 'reach' ? 35 * d : 0
  } else {
    const tilt = (fault === 'low' ? 7 : 22) * d // the foot turns about the toes
    const turn = ([x, y]: V): V => {
      const rx = x - toe[0], ry = y - toe[1], s = Math.sin(rad(-tilt)), co = Math.cos(rad(-tilt))
      return [toe[0] + rx * co - ry * s, toe[1] + rx * s + ry * co]
    }
    heel = turn(heel)
    ankle = turn(ankle)
    if (fault === 'bentknees') {
      knee = 177 - 30 * d
      a = 15 * d
    }
  }
  const kneeP = add(ankle, SHIN, a)
  const b = a - (180 - knee)
  const hip = add(kneeP, THIGH, b)
  const shoulder = add(hip, TORSO, c)
  const elbow = add(shoulder, UPPER_ARM, 180 - arm)
  const wrist = add(elbow, FOREARM, 180 - arm)
  return {
    heel, toe, ankle, knee: kneeP, hip, shoulder, elbow, wrist,
    nose: add(add(shoulder, 0.1, c), 0.05, c + 70),
    ear: add(shoulder, 0.12, c - 5),
  }
}

// Seeded noise, so tests are repeatable but the figure still looks alive.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Placement {
  aspect: number // image width / height
  view: 'side' | 'front'
  noise: number // landmark jitter, in image heights
}

const HALF_WIDTH = { shoulder: 0.1, elbow: 0.12, wrist: 0.12, hip: 0.07, knee: 0.075, ankle: 0.075, heel: 0.07, toe: 0.08, ear: 0.035 }

/** 33 landmarks, normalised to the picture, for the joints above. */
export function landmarks(j: Joints, place: Placement, random: () => number = Math.random, kneesIn = 0): Landmark[] {
  const scale = 0.75 // body height in image heights
  const floor = 0.93
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }))
  const set = (i: number, p: V, side: -1 | 0 | 1, part: keyof typeof HALF_WIDTH | null, visibility: number) => {
    let x: number
    if (place.view === 'side') x = 0.42 * place.aspect + p[0] * scale + (side === -1 ? 0.012 : 0)
    else x = 0.5 * place.aspect + side * (part ? HALF_WIDTH[part] : 0) * scale
    const jitter = () => (random() - 0.5) * 2 * place.noise
    out[i] = { x: (x + jitter()) / place.aspect, y: floor - p[1] * scale + jitter(), z: 0, visibility }
  }
  const far = place.view === 'side' ? 0.7 : 0.97 // the far side is partly hidden in a side view
  const near = 0.98
  const pairs: [keyof Joints & keyof typeof HALF_WIDTH, number, number][] = [
    ['shoulder', 11, 12], ['elbow', 13, 14], ['wrist', 15, 16], ['hip', 23, 24], ['knee', 25, 26],
    ['ankle', 27, 28], ['heel', 29, 30], ['toe', 31, 32], ['ear', 7, 8],
  ]
  for (const [part, left, right] of pairs) {
    set(left, j[part], -1, part, far)
    set(right, j[part], 1, part, near)
  }
  if (place.view === 'front' && kneesIn) {
    // knees caving in: they move towards each other, the feet stay put
    for (const [i, s] of [[25, -1], [26, 1]] as const) {
      out[i].x = (0.5 * place.aspect + s * (HALF_WIDTH.knee - kneesIn) * scale) / place.aspect
    }
  }
  // face and hands, close to the nose and wrists
  set(0, j.nose, 0, null, near)
  for (let i = 1; i <= 6; i++) set(i, [j.nose[0] - 0.01, j.nose[1] + 0.012], i <= 3 ? -1 : 1, null, near)
  set(9, [j.nose[0], j.nose[1] - 0.025], -1, null, near)
  set(10, [j.nose[0], j.nose[1] - 0.025], 1, null, near)
  for (const [i, s] of [[17, -1], [19, -1], [21, -1], [18, 1], [20, 1], [22, 1]] as const) {
    set(i, [j.wrist[0] + 0.02, j.wrist[1] - 0.03], s, 'wrist', s === -1 ? far : near)
  }
  if (place.view === 'front') {
    // face points spread sideways a little in a front view
    for (const [i, s] of [[1, -1], [2, -1], [3, -1], [4, 1], [5, 1], [6, 1]] as const) {
      out[i].x = (0.5 * place.aspect + s * 0.02 * scale) / place.aspect
    }
  }
  return out
}

const ease = (x: number) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, x)))) / 2

interface Rep {
  exercise: ExerciseId
  start: number
  period: number
  from: number
  bottom: number
  to: number
  fault?: Fault
}

/** Plays the simulated person: call `pose(t, exercise, active)` every frame. */
export class DemoPerson {
  private attempts: Record<ExerciseId, number> = { squat: 0, deadlift: 0, heel_raise: 0 }
  private rep: Rep | null = null
  private level = 0
  private last: ExerciseId = 'squat'
  private random: () => number
  private place: Placement
  private faults: Record<ExerciseId, Record<number, Fault>>

  constructor(opts: Partial<Placement> & { seed?: number; faults?: Record<ExerciseId, Record<number, Fault>> } = {}) {
    this.place = { aspect: opts.aspect ?? 16 / 9, view: opts.view ?? 'side', noise: opts.noise ?? 0.0015 }
    this.random = rng(opts.seed ?? 7)
    this.faults = opts.faults ?? DEMO_FAULTS
  }

  /** The rep being shown (for tests): its number for that exercise and its mistake. */
  get current(): { attempt: number; fault?: Fault } | null {
    return this.rep ? { attempt: this.attempts[this.rep.exercise], fault: this.rep.fault } : null
  }

  pose(t: number, exercise: ExerciseId | null, active: boolean): Landmark[] {
    if (!active || !exercise) {
      if (this.rep) this.attempts[this.rep.exercise] += 1 // the set ended during this rep's last pause
      this.rep = null
      return this.draw(this.last, this.level)
    }
    if (exercise !== this.last) this.level = 0
    this.last = exercise
    if (!this.rep || this.rep.exercise !== exercise) this.rep = this.next(exercise, t, this.level)
    while (t >= this.rep.start + this.rep.period * 1000) {
      this.attempts[exercise] += 1
      this.rep = this.next(exercise, this.rep.start + this.rep.period * 1000, this.rep.to)
    }
    const u = (t - this.rep.start) / (this.rep.period * 1000)
    const { from, bottom, to } = this.rep
    let d: number
    if (u < 0.4) d = from + (bottom - from) * ease(u / 0.4)
    else if (u < 0.5) d = bottom
    else if (u < 0.9) d = bottom + (to - bottom) * ease((u - 0.5) / 0.4)
    else d = to
    this.level = d
    return this.draw(exercise, d, this.rep.fault)
  }

  private next(exercise: ExerciseId, start: number, from: number): Rep {
    const fault = this.faults[exercise][this.attempts[exercise]]
    return {
      exercise, start, from, fault,
      period: fault === 'fast' ? 1.1 : PERIOD[exercise],
      bottom: fault === 'shallow' ? 0.42 : 1,
      to: fault === 'nolock' ? 0.15 : 0,
    }
  }

  private draw(exercise: ExerciseId, d: number, fault?: Fault): Landmark[] {
    const kneesIn = fault === 'valgus' ? 0.06 * d : 0
    return landmarks(joints(exercise, d, fault), this.place, this.random, kneesIn)
  }
}
