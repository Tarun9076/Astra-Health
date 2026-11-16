// On-device treatment engine (Step 21e): the same decision as services/backend/astra/core/treatment.py
// and core/medication.py, so Act Now still works with the Habitat server down. It reads the same
// protocol files (bundled into the app) and returns the same shape as POST .../treatment/assess.
// The two copies are kept identical by one shared test file: protocols/treatments/cases.json runs
// against both (backend tests and `npm run test:unit`). Change one, change the other.
import type { components } from '../api-types'

type S = components['schemas']
export type AssessmentOut = S['AssessmentOut']
export type ProtocolPlanOut = S['ProtocolPlanOut']
export type StepOut = S['StepOut']
export type PickOut = S['PickOut']
type CheckOut = S['CheckOut']
type RejectedOut = S['RejectedOut']
type RoutineOut = S['RoutineOut']

// --- the protocol files (camelCase, as written) ---------------------------------------------------

type Level = 'block' | 'caution'
type Op = 'lt' | 'lte' | 'gt' | 'gte'

export interface MedicineFile {
  id: string
  name: string
  strength: string
  strengthMg?: number | null
  amountPerUnit?: number | null
  amountUnit?: string | null
  unit: string
  unitPlural: string
  perUnit?: string | null
  how: string
  appearance?: string | null
  route?: string
  rxOnly?: boolean
  kitLocation: string
  stockUnits: number
  expires: string
  groups: string[]
  allergyGroups?: string[]
  firstDoseUnits?: number | null
  doseUnits: number
  doseUnitsMax?: number | null
  minIntervalHours: number
  maxUnitsPer24h: number
  maxDays?: number | null
  drowsy: boolean
  avoidIf: { condition: string; level: Level; reason: string }[]
  interactions: { with: string; level: Level; reason: string }[]
  cautions: string[]
}

export interface FormularyFile {
  version: string
  status: 'demo' | 'approved'
  vocabulary: { allergies: Record<string, string>; conditions: Record<string, string>; regularMedicines: Record<string, string> }
  medicines: MedicineFile[]
  conditions: { id: string; title: string }[]
}

export interface StepFile {
  id: string
  kind: StepOut['kind']
  text: string
  detail?: string | null
  givenBy?: StepOut['givenBy']
  emergency?: string | null
  medicines?: { medicine: string; doseUnits?: number | null }[]
  override?: string[]
  ifNone?: string | null
  question?: string | null
  yes?: string | null
  no?: string | null
  afterMinutes?: number | null
  indicator?: string | null
  op?: Op | null
  value?: number | null
  passed?: string | null
  failed?: string | null
  maxRepeats?: number | null
  failedAfterMax?: string | null
  next?: string | null
}

export interface ProtocolFile {
  id: string
  version: string
  title: string
  plain: string
  tier: 3
  priority: number
  triggers: { rules?: string[]; symptoms?: { code: string; minSeverity?: number }[]; vitals?: { indicator: string; op: Op; value: number }[] }
  actFirst?: boolean
  emergencyProtocol?: string | null
  doNotGive: { target: string; reason: string }[]
  steps: StepFile[]
  escalation: string
  followUpHours: number
  approval: { status: 'demo' | 'approved' }
}

export interface RoutineFile {
  version: string
  links: { condition: string; rules?: string[]; symptoms?: string[]; moderateFromSeverity?: number; coveredBy?: string[] }[]
}

export interface TakenDose { medicineId: string; units: number; at: Date }

export interface Situation {
  rules: string[]
  symptoms: Record<string, number>
  vitals: Record<string, number>
  questionable: string[]
  profile: { allergies: string[]; conditions: string[]; regularMedicines: string[] }
  history: TakenDose[]
  stock: Record<string, number>
  pending: string[]
  now: Date
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const LOW_STOCK_UNITS = 5
const TIER_WORD: Record<number, string> = { 0: 'Nothing to treat', 1: 'Mild', 2: 'Needs treatment', 3: 'Critical: act now' }

/** Python's {:g}: up to 6 significant digits, no trailing zeros. */
function g(x: number): string {
  return String(Number(x.toPrecision(6)))
}

function compare(value: number, op: Op, limit: number): boolean {
  return { lt: value < limit, lte: value <= limit, gt: value > limit, gte: value >= limit }[op]
}

export function doseText(m: MedicineFile, units: number): string {
  let text = `${units} ${units === 1 ? m.unit : m.unitPlural}`
  if (m.strengthMg) text += ` (${g(units * m.strengthMg)} mg)`
  else if (m.amountPerUnit && m.amountUnit) text += ` (${g(units * m.amountPerUnit)} ${m.amountUnit})`
  if (m.perUnit) text += `: ${m.perUnit}`
  return text
}

function expired(m: MedicineFile, now: Date): boolean {
  const [y, mo] = m.expires.split('-').map(Number)
  const ny = now.getUTCFullYear(), nm = now.getUTCMonth() + 1
  return ny > y || (ny === y && nm > mo)
}

function unitsFor(m: MedicineFile, history: TakenDose[], now: Date): number {
  const recent = history.some((d) => d.medicineId === m.id && now.getTime() - d.at.getTime() < DAY)
  return m.firstDoseUnits && !recent ? m.firstDoseUnits : m.doseUnits
}

const utcDay = (d: Date) => Math.floor(d.getTime() / DAY)

/** core/medication.py check_medicine, same order and wording. */
export function checkMedicine(f: FormularyFile, m: MedicineFile, units: number, s: Situation, history: TakenDose[], stockLeft: number): CheckOut[] {
  const checks: CheckOut[] = []
  const now = s.now.getTime()
  for (const group of m.allergyGroups ?? []) {
    if (s.profile.allergies.includes(group)) checks.push({ level: 'block', code: 'allergy', text: `Allergy on record: ${f.vocabulary.allergies[group]}.` })
  }
  for (const a of m.avoidIf) if (s.profile.conditions.includes(a.condition)) checks.push({ level: a.level, code: 'condition', text: a.reason })
  const day = history.filter((d) => now - d.at.getTime() < DAY && d.at.getTime() <= now)
  const groups = new Set<string>()
  for (const d of day) {
    const other = f.medicines.find((x) => x.id === d.medicineId)
    if (other && other.id !== m.id) other.groups.forEach((x) => groups.add(x))
  }
  for (const i of m.interactions) {
    if (s.profile.regularMedicines.includes(i.with) || groups.has(i.with)) checks.push({ level: i.level, code: 'interaction', text: i.reason })
  }
  if (s.pending.includes(m.id)) checks.push({ level: 'block', code: 'pending', text: 'A dose of this medicine is already waiting for confirmation.' })
  const same = day.filter((d) => d.medicineId === m.id).sort((a, b) => a.at.getTime() - b.at.getTime())
  if (same.length && m.minIntervalHours) {
    const after = same[same.length - 1].at.getTime() + m.minIntervalHours * HOUR
    if (after > now) checks.push({ level: 'block', code: 'interval', text: `Too soon after the last dose (at least ${g(m.minIntervalHours)} hours between doses).` })
  }
  const used = same.reduce((n, d) => n + d.units, 0)
  if (used + units > m.maxUnitsPer24h) {
    checks.push({ level: 'block', code: 'limit24h', text: `The 24-hour limit is ${doseText(m, m.maxUnitsPer24h).split(':')[0]}; ${used} already taken.` })
  }
  if (m.maxDays) {
    const today = utcDay(s.now)
    const days = new Set(history.filter((d) => d.medicineId === m.id && today - m.maxDays! <= utcDay(d.at) && utcDay(d.at) < today).map((d) => utcDay(d.at)))
    if (days.size >= m.maxDays) {
      checks.push({ level: 'block', code: 'days', text: `Already used on ${days.size} days in a row: the limit is ${m.maxDays} days. Ask the flight surgeon.` })
    }
  }
  if (stockLeft < units) checks.push({ level: 'block', code: 'stock', text: 'Not enough left in the medical kit.' })
  else if (stockLeft - units <= LOW_STOCK_UNITS) checks.push({ level: 'caution', code: 'stock', text: `Only ${stockLeft} left in the kit: tell the flight surgeon.` })
  if (expired(m, s.now)) checks.push({ level: 'caution', code: 'expired', text: `Past its expiry date (${m.expires}): it may be weaker. The CMO decides.` })
  if (m.drowsy) checks.push({ level: 'caution', code: 'drowsy', text: 'Makes you drowsy: no EVA, rover driving or machine work until you are fully alert.' })
  return checks
}

function approved(c: CheckOut): CheckOut {
  const base = c.text.split(': ')[0].replace(/\.+$/, '')
  return { level: 'caution', code: c.code, text: `${base}: pre-approved for this emergency, give it anyway.` }
}

export function nextOf(p: ProtocolFile, step: StepFile): string {
  if (step.next) return step.next
  const i = p.steps.indexOf(step)
  return i + 1 < p.steps.length ? p.steps[i + 1].id : 'done'
}

function matchedBy(p: ProtocolFile, s: Situation): string[] {
  const t = p.triggers
  const out = (t.rules ?? []).filter((r) => s.rules.includes(r)).map((r) => `alert ${r}`)
  for (const x of t.symptoms ?? []) {
    const sev = s.symptoms[x.code]
    if (sev !== undefined && sev >= (x.minSeverity ?? 1)) out.push(`symptom ${x.code} ${sev}/10`)
  }
  for (const v of t.vitals ?? []) {
    const val = s.vitals[v.indicator]
    if (val !== undefined && compare(val, v.op, v.value)) out.push(`${v.indicator} ${g(val)} (${v.op} ${g(v.value)})`)
  }
  return out
}

function stepOut(p: ProtocolFile, step: StepFile, pick: PickOut | null, rejected: RejectedOut[], withheld: string | null): StepOut {
  return {
    id: step.id, kind: step.kind, text: step.text, detail: step.detail ?? null, givenBy: step.givenBy ?? 'any',
    emergency: step.emergency ?? null, question: step.question ?? null, yes: step.yes ?? null, no: step.no ?? null,
    afterMinutes: step.afterMinutes ?? null, indicator: step.indicator ?? null, op: step.op ?? null, value: step.value ?? null,
    passed: step.passed ?? null, failed: step.failed ?? null, maxRepeats: step.maxRepeats ?? null,
    failedAfterMax: step.failedAfterMax ?? null, ifNone: step.ifNone ?? null, next: nextOf(p, step),
    pick, rejected, withheld,
  }
}

/** core/treatment.py plan_protocols: merge the matched critical protocols into one plan. */
function planProtocols(matched: [ProtocolFile, string[]][], f: FormularyFile | null, s: Situation): ProtocolPlanOut[] {
  const ordered = [...matched].sort((a, b) => a[0].priority - b[0].priority || (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : 0))
  const rules = ordered.flatMap(([p]) => p.doNotGive.map((d) => [d, p.title] as const))
  const history = [...s.history]
  const planned = new Map<string, string>()
  return ordered.map(([p, why]) => {
    const steps = p.steps.map((step) => {
      if (step.kind !== 'medicine' || !f) return stepOut(p, step, null, [], null)
      const rejected: RejectedOut[] = []
      let pick: PickOut | null = null
      let withheld: string | null = null
      for (const choice of step.medicines ?? []) {
        const m = f.medicines.find((x) => x.id === choice.medicine)!
        if (planned.has(m.id)) {
          withheld = `${m.name} is already in this plan (${planned.get(m.id)}): don't give it twice.`
          break
        }
        const forbidden = rules
          .filter(([d]) => d.target === m.id || d.target === (m.route ?? 'swallow') || m.groups.includes(d.target))
          .map(([d, src]) => `Do not give: ${d.reason} (${src})`)
        if (forbidden.length) {
          rejected.push({ medicineId: m.id, name: m.name, codes: ['do-not-give'], reasons: forbidden })
          continue
        }
        const units = choice.doseUnits ?? unitsFor(m, history, s.now)
        const checks = checkMedicine(f, m, units, s, history, s.stock[m.id] ?? 0).map((c) => ((step.override ?? []).includes(c.code) ? approved(c) : c))
        const blocks = checks.filter((c) => c.level === 'block')
        if (blocks.length) {
          rejected.push({ medicineId: m.id, name: m.name, codes: blocks.map((c) => c.code), reasons: blocks.map((c) => c.text) })
          continue
        }
        pick = {
          medicineId: m.id, name: m.name, strength: m.strength, units, doseText: doseText(m, units), route: m.route ?? 'swallow',
          appearance: m.appearance ?? null, how: m.how, kitLocation: m.kitLocation, rxOnly: m.rxOnly ?? false,
          status: checks.length ? 'caution' : 'ok', checks,
        }
        planned.set(m.id, p.title)
        history.push({ medicineId: m.id, units, at: s.now })
        break
      }
      if (!pick && withheld === null) {
        const reasons = rejected.flatMap((r) => r.reasons).join(' ')
        withheld = `No safe medicine in the kit for this step. ${reasons} Skip it and go on.`
      }
      return stepOut(p, step, pick, rejected, withheld)
    })
    const remeasure = (p.triggers.vitals ?? [])
      .filter((v) => s.questionable.includes(v.indicator) && why.some((w) => w.startsWith(v.indicator)))
      .map((v) => v.indicator)
    return {
      id: p.id, version: p.version, title: p.title, plain: p.plain, priority: p.priority, matchedBy: why, remeasure,
      actFirst: p.actFirst ?? false, emergencyProtocol: p.emergencyProtocol ?? null, escalation: p.escalation,
      followUpHours: p.followUpHours, doNotGive: rules.map(([d, src]) => `${d.reason} (${src})`),
      approvalStatus: p.approval.status, steps,
    }
  })
}

/** core/treatment.py assess: the whole decision. `chosen`: a protocol opened with Help now. */
export function assess(
  protocols: ProtocolFile[], routine: RoutineFile, f: FormularyFile | null, s: Situation, astronautCode: string, chosen?: string | null,
): AssessmentOut {
  const matched: [ProtocolFile, string[]][] = []
  for (const p of protocols) {
    let why = matchedBy(p, s)
    if (p.id === chosen) why = ['opened by the crew (Help now)', ...why]
    if (why.length) matched.push([p, why])
  }
  let plans = planProtocols(matched, f, s)
  if (chosen) plans = [...plans.filter((p) => p.id === chosen), ...plans.filter((p) => p.id !== chosen)]
  const critical = new Set(plans.map((p) => p.id))
  const hits: RoutineOut[] = []
  for (const link of routine.links) {
    if ((link.coveredBy ?? []).some((id) => critical.has(id))) continue
    const rules = (link.rules ?? []).filter((r) => s.rules.includes(r)).map((r) => `alert ${r}`)
    const syms = (link.symptoms ?? []).filter((c) => s.symptoms[c] !== undefined).map((c) => [c, s.symptoms[c]] as const)
    if (!rules.length && !syms.length) continue
    const tier = rules.length || syms.some(([, sev]) => sev >= (link.moderateFromSeverity ?? 7)) ? 2 : 1
    const title = f?.conditions.find((c) => c.id === link.condition)?.title ?? link.condition
    hits.push({ condition: link.condition, title, tier, matchedBy: [...rules, ...syms.map(([c, sev]) => `symptom ${c} ${sev}/10`)] })
  }
  hits.sort((a, b) => b.tier - a.tier)
  const tier = plans.length ? 3 : Math.max(0, ...hits.map((h) => h.tier))
  return { astronautCode, tier, tierWord: TIER_WORD[tier], critical: plans, routine: hits, generatedAt: s.now.toISOString() }
}
