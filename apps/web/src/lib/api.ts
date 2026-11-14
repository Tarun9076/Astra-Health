// Thin fetch wrapper. In Step 4 this is replaced/augmented by a client generated
// from the API's OpenAPI document (openapi-typescript), so DTOs never drift.

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export interface SystemStatus {
  service: string
  nodeRole: 'Habitat' | 'Ground'
  nodeId: string
  missionCode: string
  utcNow: string
  simulatedData: boolean
  disclaimer: string
}

export const getSystemStatus = () => apiGet<SystemStatus>('/api/system/status')
