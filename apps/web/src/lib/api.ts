// Typed API client. Types are generated from the backend's OpenAPI schema:
//   services/backend: python -m astra.export_openapi ../../apps/web/openapi.json
//   apps/web:         npm run gen:api
import createClient, { type Middleware } from 'openapi-fetch'
import type { components, paths } from './api-types'
import { useAuth } from './auth'
import { routeUrl } from './nodes'

type Schemas = components['schemas']
export type Me = Schemas['MeOut']
export type Dashboard = Schemas['DashboardOut']
export type Vital = Schemas['Vital']
export type AlertSummary = Schemas['AlertSummary']
export type AlertDetail = Schemas['AlertDetail']
export type Task = Schemas['TaskOut']
export type Indicator = Schemas['IndicatorOut']
export type CheckinIn = Schemas['CheckinIn']
export type VitalIn = Schemas['VitalIn']
export type CheckinOut = Schemas['CheckinOut']
export type Astronaut = Schemas['AstronautOut']
export type SystemStatus = Schemas['SystemStatus']
export type Analytics = Schemas['AnalyticsOut']
export type AnalyticsDay = Schemas['DayPoint']
export type WellnessDay = Schemas['WellnessDay']
export type Wellness = Schemas['WellnessOut']
export type Insight = Schemas['InsightOut']
export type ChatOut = Schemas['ChatOut']
export type ChatTurn = Schemas['HistoryItem']
export type ChatCitation = Schemas['CitationOut']
export type AssistantStatus = Schemas['AssistantStatus']
export type ReportItem = Schemas['ReportListItem']
export type Report = Schemas['ReportOut']
export type Instruction = Schemas['InstructionOut']
export type CrewStatus = Schemas['CrewStatus']
export type SyncStatus = Schemas['SyncStatus']
export type LinkState = Schemas['LinkOut']

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = useAuth.getState().token
    if (token) request.headers.set('Authorization', `Bearer ${token}`)
    const routed = routeUrl(request.url)
    return routed === request.url ? request : new Request(routed, request)
  },
  onResponse({ response }) {
    // An expired or revoked session: sign out so the app returns to the login page.
    if (response.status === 401 && useAuth.getState().token) useAuth.getState().signOut()
    return response
  },
}

export const api = createClient<paths>({ baseUrl: '' })
api.use(auth)

function detailOf(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((d) => (d as { msg?: string }).msg ?? '').join('; ')
  }
  return 'Request failed'
}

/** Await an openapi-fetch call and return its data, or throw an ApiError with the server's message. */
export async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response }
  try {
    result = await call
  } catch {
    throw new ApiError(0, 'Habitat server unreachable')
  }
  if (result.error !== undefined || result.data === undefined) {
    throw new ApiError(result.response.status, detailOf(result.error))
  }
  return result.data
}
