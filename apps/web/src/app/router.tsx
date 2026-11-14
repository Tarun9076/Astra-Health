import type { ReactNode } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AlertsPage } from '../features/alerts/AlertsPage'
import { LoginPage } from '../features/auth/LoginPage'
import { CheckinPage } from '../features/checkin/CheckinPage'
import { OverviewPage } from '../features/overview/OverviewPage'
import { AppLayout } from './AppLayout'
import { Guard, Home } from './Guards'
import { AnalyticsRoute, AssistantRoute, CrewRoute, DemoControlRoute, ReportsRoute, StaffAstronautRoute } from './LazyPages'
import { PlaceholderPage } from './PlaceholderPage'
import { ASTRONAUT_SECTIONS } from './sections'


const BUILT: Record<string, ReactNode> = {
  overview: <OverviewPage />,
  alerts: <AlertsPage />,
  analytics: <AnalyticsRoute />,
  assistant: <AssistantRoute />,
  reports: <ReportsRoute />,
}

export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/astronaut',
    element: (
      <Guard roles={['Astronaut']}>
        <AppLayout />
      </Guard>
    ),
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: 'checkin', element: <CheckinPage /> },
      ...ASTRONAUT_SECTIONS.map((s) => ({
        path: s.path,
        element: BUILT[s.path] ?? <PlaceholderPage num={s.num} title={s.title} blurb={s.blurb} />,
      })),
    ],
  },
  {
    path: '/staff',
    element: (
      <Guard roles={['FlightSurgeon', 'MissionControl', 'Admin']}>
        <AppLayout />
      </Guard>
    ),
    children: [
      { index: true, element: <CrewRoute /> },
      { path: 'astronaut/:code', element: <StaffAstronautRoute /> },
      { path: 'sim', element: <Guard roles={['Admin']}><DemoControlRoute /></Guard> },
    ],
  },
  { path: '*', element: <Home /> },
])
