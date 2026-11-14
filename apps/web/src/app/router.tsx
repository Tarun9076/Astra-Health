import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout, ASTRONAUT_SECTIONS } from './AppLayout'
import { PlaceholderPage } from './PlaceholderPage'

// Surgeon (/surgeon), mission (/mission) and demo-control (/admin/sim) shells arrive in Steps 8–9.
export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/astronaut/overview" replace /> },
  {
    path: '/astronaut',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      ...ASTRONAUT_SECTIONS.map((s) => ({
        path: s.path,
        element: <PlaceholderPage num={s.num} title={s.title} blurb={s.blurb} />,
      })),
    ],
  },
  { path: '*', element: <Navigate to="/astronaut/overview" replace /> },
])
