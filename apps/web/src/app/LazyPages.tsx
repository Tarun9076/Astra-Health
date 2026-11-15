import { lazy, Suspense } from 'react'

// Charts are heavy: load the Analytics page (and Recharts) only when it is opened.
const AnalyticsPage = lazy(() =>
  import('../features/analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
)

const AssistantPage = lazy(() =>
  import('../features/assistant/AssistantPage').then((m) => ({ default: m.AssistantPage })),
)

export function AssistantRoute() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-muted">Loading the assistant…</p>}>
      <AssistantPage />
    </Suspense>
  )
}

export function AnalyticsRoute() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-muted">Loading charts…</p>}>
      <AnalyticsPage embedded />
    </Suspense>
  )
}

const CrewPage = lazy(() => import('../features/staff/CrewPage').then((m) => ({ default: m.CrewPage })))
const StaffAstronautPage = lazy(() => import('../features/staff/CrewPage').then((m) => ({ default: m.StaffAstronautPage })))
const ReportsPage = lazy(() => import('../features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const DemoControlPage = lazy(() => import('../features/admin/DemoControlPage').then((m) => ({ default: m.DemoControlPage })))

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>{children}</Suspense>
}

export const CrewRoute = () => <Page><CrewPage /></Page>
export const StaffAstronautRoute = () => <Page><StaffAstronautPage /></Page>
export const ReportsRoute = () => <Page><ReportsPage embedded /></Page>
export const DemoControlRoute = () => <Page><DemoControlPage /></Page>

const BodyExplorerPage = lazy(() => import('../features/body/BodyExplorerPage').then((m) => ({ default: m.BodyExplorerPage })))
const WellnessCenterPage = lazy(() => import('../features/wellness/WellnessCenterPage').then((m) => ({ default: m.WellnessCenterPage })))

export const BodyRoute = () => <Page><BodyExplorerPage /></Page>
export const WellnessRoute = () => <Page><WellnessCenterPage /></Page>

const AlertsPage = lazy(() => import('../features/alerts/AlertsPage').then((m) => ({ default: m.AlertsPage })))
const GuidancePage = lazy(() => import('../features/guidance/GuidancePage').then((m) => ({ default: m.GuidancePage })))
const HistoryPage = lazy(() => import('../features/history/HistoryPage').then((m) => ({ default: m.HistoryPage })))

export const AlertsRoute = () => <Page><AlertsPage /></Page>
export const GuidanceRoute = () => <Page><GuidancePage /></Page>
export const HistoryRoute = () => <Page><HistoryPage /></Page>

const ExerciseCoachPage = lazy(() => import('../features/exercise/ExerciseCoachPage').then((m) => ({ default: m.ExerciseCoachPage })))

export const ExerciseRoute = () => <Page><ExerciseCoachPage /></Page>
