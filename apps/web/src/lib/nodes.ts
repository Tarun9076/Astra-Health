// Which backend node a signed-in user talks to (Step 9; HLD §4):
// astronauts (and the Admin's demo controls) use the Habitat node onboard; the flight surgeon and
// mission control work on Earth, on the Ground node's synced copy. Vite (dev), Caddy or Vercel forward /ground-api and
// /ground-ws to the Ground node (port 8001).
import { useAuth } from './auth'

const EARTH_ROLES = new Set(['FlightSurgeon', 'MissionControl'])

export function onEarth(role: string | null | undefined): boolean {
  return Boolean(role && EARTH_ROLES.has(role))
}

export function currentRoleOnEarth(): boolean {
  return onEarth(useAuth.getState().user?.role)
}

/** /api/... → /ground-api/... for Earth roles (sign-in itself always goes to the Habitat). */
export function routeUrl(url: string): string {
  if (!currentRoleOnEarth()) return url
  const u = new URL(url, window.location.origin)
  if (!u.pathname.startsWith('/api/') || u.pathname.startsWith('/api/auth/login')) return url
  u.pathname = u.pathname.replace(/^\/api\//, '/ground-api/')
  return u.toString()
}

export function websocketPath(): string {
  return currentRoleOnEarth() ? '/ground-ws' : '/ws'
}
