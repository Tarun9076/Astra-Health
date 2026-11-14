import { lazy, Suspense } from 'react'

// Charts are heavy: load the Analytics page (and Recharts) only when it is opened.
const AnalyticsPage = lazy(() =>
  import('../features/analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
)

export function AnalyticsRoute() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-muted">Loading charts…</p>}>
      <AnalyticsPage />
    </Suspense>
  )
}
