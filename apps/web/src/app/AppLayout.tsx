import { NavLink, Outlet } from 'react-router-dom'
import { NodeStatusPill } from '../components/ui/NodeStatusPill'

export const ASTRONAUT_SECTIONS = [
  { path: 'overview', num: '01', title: 'Overview', blurb: 'Overall health status and important alerts.' },
  { path: 'body', num: '02', title: 'Body Explorer', blurb: 'Interactive body map linked to body-system data.' },
  { path: 'analytics', num: '03', title: 'Health Analytics', blurb: 'Historical measurements and trends vs your baseline.' },
  { path: 'assistant', num: '04', title: 'AI Health Assistant', blurb: 'Ask questions and understand your health reports.' },
  { path: 'wellness', num: '05', title: 'Wellness Center', blurb: 'Exercise, nutrition, sleep and mental wellness.' },
  { path: 'alerts', num: '06', title: 'Alerts Center', blurb: 'Health warnings and required actions.' },
  { path: 'reports', num: '07', title: 'Medical Reports', blurb: 'Reports queued and sent to flight surgeons.' },
] as const

export function AppLayout() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-space-700 bg-space-950 px-4 py-3">
        <div>
          <p className="text-lg font-bold tracking-widest text-accent">ASTRA HEALTH</p>
          <p className="text-[11px] uppercase tracking-[0.2em] text-ink-muted">Crew health intelligence</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-status-yellow/50 px-3 py-1 text-xs font-semibold text-status-yellow">
            SIMULATED DATA
          </span>
          <NodeStatusPill />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex gap-1 overflow-x-auto border-b border-space-700 bg-space-950 p-2 md:w-60 md:flex-col md:border-r md:border-b-0">
          {ASTRONAUT_SECTIONS.map((s) => (
            <NavLink
              key={s.path}
              to={`/astronaut/${s.path}`}
              className={({ isActive }) =>
                `flex min-h-12 shrink-0 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
                  isActive ? 'bg-space-700 text-ink' : 'text-ink-muted hover:bg-space-800 hover:text-ink'
                }`
              }
            >
              <span className="font-mono text-xs text-accent">{s.num}</span>
              {s.title}
            </NavLink>
          ))}
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>

      <footer className="border-t border-space-700 bg-space-950 px-4 py-2 text-center text-[11px] text-ink-muted">
        Prototype decision support only — not a diagnosis. Thresholds are illustrative; all data is simulated.
      </footer>
    </div>
  )
}
