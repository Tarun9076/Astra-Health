import { createBrowserRouter, Navigate } from 'react-router-dom'
import { LoginPage } from '../features/auth/LoginPage'
import { CheckinPage } from '../features/checkin/CheckinPage'
import { EmergencyPage } from '../features/emergency/EmergencyPage'
import { HomePage } from '../features/overview/SimpleHome'
import { AppLayout } from './AppLayout'
import { Guard, Home } from './Guards'
import {
  AlertsRoute, AnalyticsRoute, AssistantRoute, BodyRoute, CrewRoute, DemoControlRoute, ExerciseRoute, GuidanceRoute, HistoryRoute,
  ReportsRoute, StaffAstronautRoute, WellnessRoute,
} from './LazyPages'
import { Moved } from './Moved'
import { TabbedSection } from './TabbedSection'

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
      { index: true, element: <Navigate to="home" replace /> },
      { path: 'home', element: <HomePage /> },
      {
        path: 'health',
        element: (
          <TabbedSection title="My Health" intro="Tap a part of your body to see how it is and what helps."
            tabs={[{ to: '', label: 'Body systems' }, { to: 'trends', label: 'Trends and charts' }]} />
        ),
        children: [
          { index: true, element: <BodyRoute /> },
          { path: 'trends', element: <AnalyticsRoute /> },
        ],
      },
      { path: 'checkin', element: <CheckinPage /> },
      {
        path: 'guidance',
        element: (
          <TabbedSection title="My Guidance" intro="What to do now, and why. Tick things off to earn points."
            tabs={[{ to: '', label: 'Recommended actions' }, { to: 'alerts', label: 'Health alerts' }]} />
        ),
        children: [
          { index: true, element: <GuidanceRoute /> },
          { path: 'alerts', element: <AlertsRoute /> },
        ],
      },
      { path: 'wellness', element: <WellnessRoute /> },
      { path: 'wellness/exercise', element: <ExerciseRoute /> },
      {
        path: 'history',
        element: (
          <TabbedSection title="Health History" intro="What happened so far, newest first."
            tabs={[{ to: '', label: 'Timeline' }, { to: 'reports', label: 'Medical reports' }]} />
        ),
        children: [
          { index: true, element: <HistoryRoute /> },
          { path: 'reports', element: <ReportsRoute /> },
        ],
      },
      { path: 'assistant', element: <AssistantRoute /> },
      { path: 'emergency', element: <EmergencyPage /> },
      // pre-redesign paths
      { path: 'overview', element: <Moved to="/astronaut/home" /> },
      { path: 'body', element: <Moved to="/astronaut/health" /> },
      { path: 'analytics', element: <Moved to="/astronaut/health/trends" /> },
      { path: 'alerts', element: <Moved to="/astronaut/guidance/alerts" /> },
      { path: 'reports', element: <Moved to="/astronaut/history/reports" /> },
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
      { path: 'emergency', element: <EmergencyPage /> },
      { path: 'sim', element: <Guard roles={['Admin']}><DemoControlRoute /></Guard> },
    ],
  },
  { path: '*', element: <Home /> },
])
