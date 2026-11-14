import { Navigate, useLocation } from 'react-router-dom'

/** Old links (toasts, bookmarks, e2e) keep working: redirect and keep ?query. */
export function Moved({ to }: { to: string }) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}
