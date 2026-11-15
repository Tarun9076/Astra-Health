// Coach engine tests (Step 13: T-EX-06..09), driven by the simulated person at 30 frames a second.
// Run with:  npm run test:unit   (Node 23.6+ runs TypeScript directly)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RepCounter, TIPS, Workout, type CoachEvent, type ExerciseId, type PlanItem, type TipCode } from '../src/features/exercise/coach.ts'
import { toBody } from '../src/features/exercise/pose.ts'
import { DemoPerson, type Fault } from '../src/features/exercise/synthetic.ts'

const FPS = 30
const ASPECT = 16 / 9
const NO_FAULTS: Record<ExerciseId, Record<number, Fault>> = { squat: {}, deadlift: {}, heel_raise: {} }

/** Runs one exercise for `seconds`; returns each finished rep. */
function run(exercise: ExerciseId, seconds: number, person: DemoPerson) {
  const counter = new RepCounter(exercise)
  const reps = []
  for (let t = 0; t < seconds * 1000; t += 1000 / FPS) {
    const frame = counter.update(toBody(person.pose(t, exercise, true), ASPECT), t, ASPECT)
    if (frame.rep) reps.push(frame.rep)
  }
  const last = counter.flush(seconds * 1000)
  if (last) reps.push(last)
  return reps
}

for (const [exercise, period] of [['squat', 3.2], ['deadlift', 3.0], ['heel_raise', 2.4]] as const) {
  test(`${exercise}: clean reps all count, with no tips`, () => {
    const reps = run(exercise, period * 10 + 0.5, new DemoPerson({ faults: NO_FAULTS, aspect: ASPECT }))
    assert.equal(reps.length, 10)
    assert.ok(reps.every((r) => r.counted && r.tips.length === 0 && r.score === 100), JSON.stringify(reps))
  })
}

test('each deliberate mistake gets its tip, and misses do not count', () => {
  const tipsOf = (exercise: ExerciseId, seconds: number) => run(exercise, seconds, new DemoPerson({ aspect: ASPECT }))
  const squat = tipsOf('squat', 3.2 * 9 + 1.1 + 0.5)
  assert.deepEqual(squat.map((r) => r.counted), [true, true, false, true, true, true, true, true, true, true])
  assert.deepEqual(squat[2].tips, ['squat_depth_miss'])
  assert.deepEqual(squat[5].tips, ['chest_up'])
  assert.deepEqual(squat[8].tips, ['too_fast'])
  assert.equal(squat[5].score, 80)

  const dead = tipsOf('deadlift', 3.0 * 8 + 0.5)
  assert.ok(dead[1].counted && dead[1].tips.includes('hinge_not_squat'))
  assert.deepEqual(dead[4].tips, ['lock_out'])
  assert.deepEqual(dead[7].tips, ['keep_close'])
  assert.equal(dead.filter((r) => r.tips.length).length, 3)

  const heel = tipsOf('heel_raise', 2.4 * 9 + 0.5)
  assert.ok(!heel[3].counted && heel[3].tips[0] === 'rise_higher')
  assert.deepEqual(heel[8].tips, ['knees_straight'])
  assert.equal(heel.filter((r) => r.tips.length).length, 2)
})

test('front view: squat depth from hip height, and knees caving in', () => {
  const person = new DemoPerson({ view: 'front', aspect: ASPECT, faults: { squat: { 3: 'valgus' }, deadlift: {}, heel_raise: {} } })
  const reps = run('squat', 3.2 * 6 + 0.5, person)
  assert.equal(reps.length, 6)
  assert.ok(reps.every((r) => r.counted), JSON.stringify(reps))
  assert.deepEqual(reps.map((r) => r.tips.includes('knees_out')), [false, false, false, true, false, false])
})

test('out of view: the rep in progress does not count, and the coach asks to step back', () => {
  const person = new DemoPerson({ faults: NO_FAULTS, aspect: ASPECT })
  const w = new Workout([{ exercise: 'squat', name: 'Squat', sets: 1, reps: 3 }], 30)
  const events: CoachEvent[] = []
  for (let t = 0; t < 12_000; t += 1000 / FPS) {
    const hidden = t > 1000 && t < 2500 // gone mid-way down the first rep
    events.push(...w.update(hidden ? null : toBody(person.pose(t, 'squat', true), ASPECT), t, ASPECT))
  }
  assert.equal(events.filter((e) => e.kind === 'hidden').length, 1)
  // reps 2 and 3 count (the first was interrupted), so the set ends after the 3rd full rep
  assert.equal(w.snapshot(12_000).reps, 2)
})

/** Plays a whole workout with the simulated person until it is done. */
function playWorkout(items: PlanItem[], rest: number) {
  const person = new DemoPerson({ aspect: ASPECT })
  const w = new Workout(items, rest)
  const events: CoachEvent[] = []
  let t = 0
  for (; t < 600_000; t += 1000 / FPS) {
    const s = w.snapshot(t)
    if (s.state === 'done') break
    const pose = person.pose(t, s.item?.exercise ?? null, s.state === 'active')
    events.push(...w.update(toBody(pose, ASPECT), t, ASPECT))
  }
  return { w, events, t }
}

test('a workout runs every set, rests between them and adds up the tips', () => {
  const items: PlanItem[] = [
    { exercise: 'squat', name: 'Squat', sets: 2, reps: 5 },
    { exercise: 'deadlift', name: 'Deadlift', sets: 1, reps: 8 },
    { exercise: 'heel_raise', name: 'Heel raise', sets: 1, reps: 10 },
  ]
  const { w, events } = playWorkout(items, 10)
  const kinds = events.map((e) => e.kind)
  assert.equal(kinds.filter((k) => k === 'start').length, 4)
  assert.equal(kinds.filter((k) => k === 'rest').length, 3)
  assert.equal(kinds.at(-1), 'done')
  const summary = w.summary()
  assert.deepEqual(summary.map((s) => s.sets.map((x) => `${x.reps}/${x.target}`)), [['5/5', '5/5'], ['8/8'], ['10/10']])
  const tips = Object.fromEntries(summary.map((s) => [s.exercise, Object.fromEntries(s.tips.map((x) => [x.tip, x.count]))]))
  const tip = (code: TipCode) => TIPS[code]
  assert.deepEqual(tips.squat, { [tip('squat_depth_miss')]: 1, [tip('chest_up')]: 1, [tip('too_fast')]: 1 })
  assert.deepEqual(Object.keys(tips.deadlift).sort(), [tip('hinge_not_squat'), tip('keep_close'), tip('lock_out')].sort())
  assert.deepEqual(tips.heel_raise, { [tip('rise_higher')]: 1, [tip('knees_straight')]: 1 })
  // set score: the first squat set had 6 attempts: 4 clean (100), the miss (0), chest dropping (80)
  assert.equal(summary[0].sets[0].formScore, Math.round((100 * 4 + 0 + 80) / 6))
})

test('finishing a set early and ending the workout keep what was done', () => {
  const w = new Workout([{ exercise: 'squat', name: 'Squat', sets: 2, reps: 10 }], 60)
  const person = new DemoPerson({ faults: NO_FAULTS, aspect: ASPECT })
  let t = 0
  for (; t < 3.2 * 3 * 1000 + 500; t += 1000 / FPS) w.update(toBody(person.pose(t, 'squat', true), ASPECT), t, ASPECT)
  const early = w.finishSet(t)
  assert.deepEqual(early.map((e) => e.kind), ['set-done', 'rest'])
  assert.equal(w.snapshot(t).restLeft, 60)
  w.skipRest(t + 1000)
  assert.equal(w.snapshot(t + 1000).set, 2)
  assert.deepEqual(w.end(t + 2000).map((e) => e.kind), ['done'])
  assert.deepEqual(w.summary()[0].sets, [{ reps: 3, target: 10, formScore: 100 }])
})
