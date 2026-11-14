import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { homeFor, useAuth } from '../lib/auth'

type Role = 'Astronaut' | 'FlightSurgeon' | 'MissionControl' | 'Admin'

/** Signed-in users with an allowed role only; others go to sign-in or their own home page. */
export function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { token, user } = useAuth()
  if (!token || !user) return <Navigate to="/login" replace />
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />
  return children
}

export function Home() {
  const user = useAuth((s) => s.user)
  return <Navigate to={homeFor(user)} replace />
}
