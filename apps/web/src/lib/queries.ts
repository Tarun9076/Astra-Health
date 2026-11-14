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
