// T-TX-10 (Step 21e): the on-device engine gives the same answers as the backend engine, on the same
// clinical case file (protocols/treatments/cases.json). Run with: npm run test:unit
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assess, type AssessmentOut, type FormularyFile, type ProtocolFile, type RoutineFile, type Situation } from '../src/lib/treatment/engine.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..', 'protocols')
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf-8')) as T
const formulary = read<FormularyFile>(join(ROOT, 'medications.json'))
const protocols = readdirSync(join(ROOT, 'treatments')).filter((f) => /^TX-.*\.json$/.test(f)).map((f) => read<ProtocolFile>(join(ROOT, 'treatments', f)))
const routine = read<RoutineFile>(join(ROOT, 'treatments', 'routine.json'))
const { cases } = read<{ cases: Case[] }>(join(ROOT, 'treatments', 'cases.json'))
const NOW = new Date('2026-11-16T12:00:00Z')

interface Case {
  id: string
  why: string
  chosen?: string
  situation: {
    rules?: string[]; symptoms?: Record<string, number>; vitals?: Record<string, number>; questionable?: string[]
    profile?: { allergies?: string[]; conditions?: string[]; regularMedicines?: string[] }
    history?: { medicine: string; units: number; minutesAgo: number }[]; stock?: Record<string, number>; pending?: string[]
  }
  expect: Record<string, unknown>
}

function situation(raw: Case['situation']): Situation {
  return {
    rules: raw.rules ?? [], symptoms: raw.symptoms ?? {}, vitals: raw.vitals ?? {}, questionable: raw.questionable ?? [],
    profile: { allergies: raw.profile?.allergies ?? [], conditions: raw.profile?.conditions ?? [], regularMedicines: raw.profile?.regularMedicines ?? [] },
    history: (raw.history ?? []).map((h) => ({ medicineId: h.medicine, units: h.units, at: new Date(NOW.getTime() - h.minutesAgo * 60_000) })),
    stock: { ...Object.fromEntries(formulary.medicines.map((m) => [m.id, m.stockUnits])), ...(raw.stock ?? {}) },
    pending: raw.pending ?? [],
    now: NOW,
  }
}

/** The same summary the backend test builds (tests/core/test_treatment.py). */
function summary(a: AssessmentOut) {
  const picks: Record<string, string | null> = {}, rejected: Record<string, string[]> = {}, cautions: Record<string, string[]> = {}
  for (const p of a.critical) for (const s of p.steps) {
    if (s.kind !== 'medicine') continue
    const key = `${p.id}/${s.id}`
    picks[key] = s.pick ? `${s.pick.medicineId} ${s.pick.doseText}` : null
    rejected[key] = s.rejected.flatMap((r) => r.codes.map((c) => `${r.medicineId}:${c}`))
    cautions[key] = s.pick ? s.pick.checks.filter((c) => c.level === 'caution').map((c) => c.code) : []
  }
  const remeasure = Object.fromEntries(a.critical.filter((p) => p.remeasure.length).map((p) => [p.id, p.remeasure]))
  return { tier: a.tier, critical: a.critical.map((p) => p.id), routine: a.routine.map((r) => [r.condition, r.tier]), picks, rejected, cautions, remeasure }
}

for (const c of cases) {
  test(`${c.id}: ${c.why}`, () => {
    const got = summary(assess(protocols, routine, formulary, situation(c.situation), 'AST-TEST', c.chosen))
    for (const key of ['tier', 'critical', 'routine'] as const) {
      if (key in c.expect) assert.deepEqual(got[key], c.expect[key], key)
    }
    for (const key of ['picks', 'rejected', 'cautions', 'remeasure'] as const) {
      const expected = c.expect[key] as Record<string, unknown> | undefined
      if (!expected) continue
      if (key === 'picks' && Object.keys(expected).length === 0) assert.deepEqual(got.picks, {}, 'no medicine steps')
      for (const [step, value] of Object.entries(expected)) {
        const actual = (got[key] as Record<string, unknown>)[step]
        if (key === 'rejected' || key === 'cautions') {
          for (const v of value as string[]) assert.ok((actual as string[] | undefined)?.includes(v), `${key} ${step}: ${v} in ${JSON.stringify(actual)}`)
        } else assert.deepEqual(actual, value, `${key} ${step}`)
      }
    }
  })
}

test('the device engine words the plan exactly like the server (dose, withheld, reasons)', () => {
  const a = assess(protocols, routine, formulary, situation({ symptoms: { chest_pain: 7, neuro_deficit: 6 } }), 'AST-001')
  const aspirin = a.critical[0].steps.find((s) => s.id === 'aspirin')!
  assert.match(aspirin.withheld!, /^No safe medicine in the kit for this step\. Do not give: No aspirin or ibuprofen with stroke signs/)
  assert.equal(a.critical[0].steps[0].id, 'stroke') // the first screen is the decision that matters
  assert.deepEqual(a.critical.map((p) => p.matchedBy), [['symptom chest_pain 7/10'], ['symptom neuro_deficit 6/10']])
})
