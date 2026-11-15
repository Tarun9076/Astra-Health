// Shared TanStack Query hooks. Keys: ['me'], ['catalog'], ['dashboard', code], ['alerts', code, status], ['alert', id].
import { useQuery } from '@tanstack/react-query'
import { api, unwrap, type Indicator } from './api'

export function useDashboard(code: string | null | undefined) {
  return useQuery({
    queryKey: ['dashboard', code],
    queryFn: () => unwrap(api.GET('/api/astronauts/{astronaut}/dashboard', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

export function useAlerts(code: string | null | undefined, status: 'active' | 'all') {
  return useQuery({
    queryKey: ['alerts', code, status],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/alerts', { params: { path: { astronaut: code! }, query: { status } } })),
    enabled: Boolean(code),
  })
}

export function useAlert(id: string | null) {
  return useQuery({
    queryKey: ['alert', id],
    queryFn: () => unwrap(api.GET('/api/alerts/{alert_id}', { params: { path: { alert_id: id! } } })),
    enabled: Boolean(id),
  })
}

export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: () => unwrap(api.GET('/api/catalog/indicators')),
    staleTime: Infinity,
    select: (rows: Indicator[]) => Object.fromEntries(rows.map((r) => [r.code, r])) as Record<string, Indicator>,
  })
}

export type Range = '7d' | '30d' | '90d' | 'mission'

export function useAnalytics(code: string | null | undefined, indicator: string | null, range: Range) {
  return useQuery({
    queryKey: ['analytics', code, indicator, range],
    queryFn: () =>
      unwrap(
        api.GET('/api/astronauts/{astronaut}/analytics', {
          params: { path: { astronaut: code! }, query: { indicator: indicator!, range } },
        }),
      ),
    enabled: Boolean(code && indicator),
  })
}

export function useReports(code: string | null | undefined) {
  return useQuery({
    queryKey: ['reports', code],
    queryFn: () => unwrap(api.GET('/api/astronauts/{astronaut}/reports', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

export function useReport(id: string | null) {
  return useQuery({
    queryKey: ['report', id],
    queryFn: () => unwrap(api.GET('/api/reports/{report_id}', { params: { path: { report_id: id! } } })),
    enabled: Boolean(id),
    staleTime: Infinity,
  })
}

export function useInstructions(code: string | null | undefined) {
  return useQuery({
    queryKey: ['instructions', code],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/instructions', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

export interface BodyMetric {
  indicator: string
  name: string
  unit: string
  value: number
  measuredAt: string
  baseline: number | null
  sigma: number | null
  z: number | null
  worseWhen: string
  spark: { day: string; value: number }[]
}
export interface BodyRegion {
  id: string
  title: string
  status: 'GREEN' | 'YELLOW' | 'RED' | 'GREY'
  metrics: BodyMetric[]
  alerts: { id: string; ruleId: string; title: string; severity: string; status: string; reason: string }[]
  tasks: { id: string; code: string; title: string }[]
  knowledge: { noteId: string; title: string; whatHappens: string; whatYouCanDo: string | null; source: string }[]
}

export function useBodySystems(code: string | null | undefined) {
  return useQuery({
    queryKey: ['body-systems', code],
    queryFn: async () => {
      const data = await unwrap(api.GET('/api/astronauts/{astronaut}/body-systems', { params: { path: { astronaut: code! } } }))
      return data as unknown as { astronautCode: string; regions: BodyRegion[]; generatedAt: string }
    },
    enabled: Boolean(code),
  })
}

export function useWellnessCenter(code: string | null | undefined) {
  return useQuery({
    queryKey: ['wellness-center', code],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/wellness-center', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

export function useRadiation(code: string | null | undefined) {
  return useQuery({
    queryKey: ['radiation', code],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/radiation', { params: { path: { astronaut: code! }, query: { range: '30d' } } })),
    enabled: Boolean(code),
  })
}

export function useEnvironment() {
  return useQuery({ queryKey: ['environment'], queryFn: () => unwrap(api.GET('/api/environment/current')), refetchInterval: 60_000 })
}

export function useSpaceWeather() {
  return useQuery({ queryKey: ['space-weather'], queryFn: () => unwrap(api.GET('/api/space-weather/now')), refetchInterval: 5 * 60_000 })
}

export function useSyncStatus(enabled = true) {
  return useQuery({
    queryKey: ['sync-status'],
    queryFn: () => unwrap(api.GET('/api/sync/status')),
    refetchInterval: 3_000,
    retry: false,
    enabled,
  })
}

export function useCrewSummary() {
  return useQuery({ queryKey: ['crew-summary'], queryFn: () => unwrap(api.GET('/api/crew/summary')) })
}

export function useAssistantStatus() {
  return useQuery({ queryKey: ['assistant-status'], queryFn: () => unwrap(api.GET('/api/assistant/status')) })
}

export function useAssistantHistory() {
  return useQuery({
    queryKey: ['assistant-history'],
    queryFn: () => unwrap(api.GET('/api/assistant/history', { params: { query: { limit: 40 } } })),
    staleTime: Infinity,
  })
}

export function useInsights(code: string | null | undefined, range: '7d' | '30d' | 'mission' = '7d') {
  return useQuery({
    queryKey: ['insights', code, range],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/insights', { params: { path: { astronaut: code! }, query: { range } } })),
    enabled: Boolean(code),
  })
}

export function useWellnessTrend(code: string | null | undefined, range: Range) {
  return useQuery({
    queryKey: ['wellness', code, range],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/wellness', { params: { path: { astronaut: code! }, query: { range } } })),
    enabled: Boolean(code),
  })
}

export function useTimeline(code: string | null | undefined, days: number) {
  return useQuery({
    queryKey: ['timeline', code, days],
    queryFn: () =>
      unwrap(api.GET('/api/astronauts/{astronaut}/timeline', { params: { path: { astronaut: code! }, query: { days } } })),
    enabled: Boolean(code),
  })
}

export function useGuidance(code: string | null | undefined) {
  return useQuery({
    queryKey: ['guidance', code],
    queryFn: () => unwrap(api.GET('/api/astronauts/{astronaut}/guidance', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

export function useSymptomCatalog() {
  return useQuery({
    queryKey: ['symptom-catalog'],
    queryFn: () => unwrap(api.GET('/api/catalog/symptoms')),
    staleTime: Infinity,
  })
}

export function useProgress(code: string | null | undefined) {
  return useQuery({
    queryKey: ['progress', code],
    queryFn: () => unwrap(api.GET('/api/astronauts/{astronaut}/progress', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}

/** The mission and its environment (space station, Mars transit, Moon rover, Mars base). */
export function useMission(enabled = true) {
  return useQuery({
    queryKey: ['mission'],
    queryFn: () => unwrap(api.GET('/api/mission')),
    enabled,
    staleTime: 5 * 60_000,
  })
}

export function usePhotos(code: string | null | undefined) {
  return useQuery({
    queryKey: ['photos', code],
    queryFn: () => unwrap(api.GET('/api/astronauts/{astronaut}/photos', { params: { path: { astronaut: code! } } })),
    enabled: Boolean(code),
  })
}
