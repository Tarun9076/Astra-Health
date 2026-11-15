// Medication Guide (Step 20): data hooks and small helpers shared by the astronaut, CMO and flight
// surgeon screens. Keys: ['formulary'], ['medication-doses', code | 'crew'], ['medical-profile', code].
import { useQuery } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '../../lib/api'

export type Formulary = Schemas['FormularyOut']
export type Condition = Schemas['ConditionOut']
export type Advice = Schemas['AdviceOut']
export type MedOption = Schemas['OptionOut']
export type Dose = Schemas['DoseOut']
export type MedicalProfile = Schemas['MedicalProfileOut']

export function useFormulary() {
  return useQuery({ queryKey: ['formulary'], queryFn: () => unwrap(api.GET('/api/medication/formulary')) })
}

export function useDoses(code: string | null | undefined) {
  return useQuery({
    queryKey: ['medication-doses', code],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/medication/doses', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

export function useCrewDoses(enabled: boolean) {
  return useQuery({
    queryKey: ['medication-doses', 'crew'],
    queryFn: () => unwrap(api.GET('/api/medication/doses')),
    enabled,
  })
}

export function useMedicalProfile(code: string | null | undefined) {
  return useQuery({
    queryKey: ['medical-profile', code],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/medical-profile', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

export function newDoseId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `dose-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** "14:30" today, or "Tue 14:30" on another day: in the viewer's own time. */
export function clock(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

export const STATUS_WORD: Record<Dose['status'], string> = {
  Requested: 'Waiting for the CMO',
  Confirmed: 'Confirmed: take it now',
  Declined: 'Declined by the CMO',
  Cancelled: 'Cancelled',
  Taken: 'Taken',
}

export const OUTCOME_WORD = { better: 'Better', same: 'No change', worse: 'Worse' } as const
