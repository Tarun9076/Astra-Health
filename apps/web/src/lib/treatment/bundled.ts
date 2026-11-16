// The treatment protocols and the medicine list, bundled into the app at build time (like the
// emergency procedures), so Act Now works with the Habitat server down (Step 21e).
import type { QueryClient } from '@tanstack/react-query'
import { assess, type AssessmentOut, type FormularyFile, type ProtocolFile, type RoutineFile, type Situation, type TakenDose } from './engine'

const protocolFiles = import.meta.glob('../../../../../protocols/treatments/TX-*.json', { import: 'default', eager: true }) as Record<string, ProtocolFile>
const routineFile = import.meta.glob('../../../../../protocols/treatments/routine.json', { import: 'default', eager: true }) as Record<string, RoutineFile>
const formularyFile = import.meta.glob('../../../../../protocols/medications.json', { import: 'default', eager: true }) as Record<string, FormularyFile>

export const BUNDLED = {
  protocols: Object.values(protocolFiles),
  routine: Object.values(routineFile)[0] ?? { version: '0.0.0', links: [] },
  formulary: Object.values(formularyFile)[0] ?? null,
}

export function protocolById(id: string): ProtocolFile | undefined {
  return BUNDLED.protocols.find((p) => p.id === id)
}

export function medicineById(id: string) {
  return BUNDLED.formulary?.medicines.find((m) => m.id === id)
}

interface CachedProfile { allergies: string[]; conditions: string[]; regularMedicines: string[] }
interface CachedDose { medicineId: string; units: number; status: string; takenAt: string | null }
interface CachedFormulary { medicines: { id: string; stockLeft: number }[] }

export interface DeviceInput {
  rules?: string[]
  symptoms?: Record<string, number>
  vitals?: Record<string, number>
  questionable?: string[]
}

/**
 * The decision made on this device, from the bundled protocols and what this device last saw from the
 * server (medical profile, doses, kit stock). `profileKnown` is false when this device never loaded the
 * person's profile: the screen then says allergies are unknown.
 */
export function deviceAssess(
  queryClient: QueryClient, code: string, input: DeviceInput, chosen?: string | null,
): { plan: AssessmentOut; profileKnown: boolean } {
  const profile = queryClient.getQueryData<CachedProfile>(['medical-profile', code])
  const doses = queryClient.getQueryData<CachedDose[]>(['medication-doses', code]) ?? []
  const stockCache = queryClient.getQueryData<CachedFormulary>(['formulary'])
  const stock = Object.fromEntries((BUNDLED.formulary?.medicines ?? []).map((m) => [m.id, m.stockUnits]))
  for (const m of stockCache?.medicines ?? []) stock[m.id] = m.stockLeft
  const history: TakenDose[] = doses
    .filter((d) => d.status === 'Taken' && d.takenAt)
    .map((d) => ({ medicineId: d.medicineId, units: d.units, at: new Date(d.takenAt!) }))
  const situation: Situation = {
    rules: input.rules ?? [], symptoms: input.symptoms ?? {}, vitals: input.vitals ?? {}, questionable: input.questionable ?? [],
    profile: { allergies: profile?.allergies ?? [], conditions: profile?.conditions ?? [], regularMedicines: profile?.regularMedicines ?? [] },
    history, stock, pending: [], now: new Date(),
  }
  // protocol updates from Earth reach this device with GET /api/treatment/protocols (kept in the offline cache)
  const updated = queryClient.getQueryData<{ files?: ProtocolFile[] }>(['treatment-protocols'])?.files
  const protocols = updated?.length ? updated : BUNDLED.protocols
  return { plan: assess(protocols, BUNDLED.routine, BUNDLED.formulary, situation, code, chosen), profileKnown: Boolean(profile) }
}
