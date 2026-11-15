import { useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, AlertTriangle, LogOut, Menu, ShieldAlert, SlidersHorizontal, Users, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { EarthCopyBanner } from '../components/ui/EarthCopyBanner'
import { NodeStatusPill } from '../components/ui/NodeStatusPill'
import { OfflineBanner } from '../components/ui/OfflineBanner'
import { InstallButton } from '../components/ui/InstallButton'
import { ThemeToggle } from '../components/ui/ThemeToggle'
import { WatchButton } from '../components/ui/WatchButton'
import { Toaster } from '../components/ui/Toaster'
import { useAuth } from '../lib/auth'
import { missionDay, missionSol } from '../lib/mission'
import { startOutboxSync } from '../lib/outbox'
import { useCrewSummary, useDashboard, useMission } from '../lib/queries'
import { RealtimeClient, type LiveEvent } from '../lib/realtime'
import { useToasts } from '../lib/toasts'
import { useWatchRecorder } from '../lib/watchRecorder'
import { useNow } from '../lib/useNow'
import { ASTRONAUT_NAV, CHECKIN_TASK } from './sections'

const LIVE_KEYS = [
  'dashboard', 'alerts', 'alert', 'analytics', 'wellness', 'insights', 'crew-summary', 'body-systems', 'radiation',
  'wellness-center', 'environment', 'timeline', 'guidance', 'progress',
]

function useLiveUpdates() {
  const token = useAuth((s) => s.token)
  const role = useAuth((s) => s.user?.role)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)

  useEffect(() => {
    if (!token) return
    const onEvent = (event: LiveEvent) => {
      if (['AlertRaised', 'AlertUpdated', 'MeasurementRecorded', 'CheckinCompleted'].includes(event.type)) {
        for (const key of LIVE_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
      }
      if (['InstructionReceived', 'InstructionAcknowledged'].includes(event.type)) {
        void queryClient.invalidateQueries({ queryKey: ['instructions'] })
        void queryClient.invalidateQueries({ queryKey: ['crew-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['timeline'] })
      }
      if (event.type === 'LinkChanged') {
        void queryClient.invalidateQueries({ queryKey: ['sync-status'] })
      }
      if (event.type === 'MissionChanged') {
        // the environment sets the radiation limit, exercise and fluid targets and the link delay
        for (const key of ['mission', 'sync-status', ...LIVE_KEYS]) void queryClient.invalidateQueries({ queryKey: [key] })
      }
      if (event.type === 'ExerciseSessionRecorded') {
        for (const key of ['exercise-plan', 'exercise-sessions', ...LIVE_KEYS]) void queryClient.invalidateQueries({ queryKey: [key] })
      }
      if (event.type === 'PhotoAdded') {
        void queryClient.invalidateQueries({ queryKey: ['photos'] })
        void queryClient.invalidateQueries({ queryKey: ['timeline'] })
        const p = event.payload as { astronautCode?: string }
        if (role === 'FlightSurgeon' && p.astronautCode) {
          push({ tone: 'info', title: `${p.astronautCode} sent a health photo`, href: `/staff/astronaut/${p.astronautCode}?view=history` })
        }
      }
      if (event.type === 'ReportGenerated') {
        void queryClient.invalidateQueries({ queryKey: ['reports'] })
        void queryClient.invalidateQueries({ queryKey: ['crew-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['timeline'] })
      }
      if (event.type === 'InstructionReceived' && role === 'Astronaut') {
        const p = event.payload as { fromName?: string; text?: string }
        push({ tone: 'info', title: `Message from ${p.fromName ?? 'the flight surgeon'}`, body: p.text, href: '/astronaut/home' })
      }
      if (event.type === 'InstructionAcknowledged' && role === 'FlightSurgeon') {
        const p = event.payload as { astronautCode?: string }
        push({ tone: 'success', title: `${p.astronautCode ?? 'Astronaut'} acknowledged your instruction`, href: p.astronautCode ? `/staff/astronaut/${p.astronautCode}?view=instructions` : undefined })
      }
      if (event.type === 'AlertRaised') {
        const p = event.payload as { id?: string; title?: string; severity?: string; reason?: string; astronautCode?: string }
        const urgent = p.severity === 'Urgent'
        push({
          tone: urgent ? 'urgent' : 'attention',
          title: `${urgent ? 'Urgent' : 'New alert'}${role === 'Astronaut' ? '' : ` · ${p.astronautCode}`}: ${p.title ?? 'Health alert'}`,
          body: p.reason,
          href: role === 'Astronaut' && p.id ? `/astronaut/guidance/alerts?id=${p.id}` : p.astronautCode ? `/staff/astronaut/${p.astronautCode}` : undefined,
        })
      }
    }
    const client = new RealtimeClient(token, onEvent)
    client.connect()
    return () => client.close()
  }, [token, role, queryClient, push])
}

function useOutboxSync() {
  const userId = useAuth((s) => s.user?.userId)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  useEffect(() => {
    if (!userId) return
    return startOutboxSync((count) => {
      push({ tone: 'success', title: `Sent ${count} saved item(s) to the habitat server` })
      void queryClient.invalidateQueries()
    })
  }, [userId, queryClient, push])
}

const navCls = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-12 items-center gap-3 rounded-lg px-3 py-1.5 text-[15px] transition-colors ${
    isActive ? 'bg-accent-soft font-semibold text-accent' : 'text-ink hover:bg-subtle'
  }`

/** Count chip with a word, so meaning never depends on colour alone. */
function NavBadge({ tone, children }: { tone: 'red' | 'amber' | 'blue'; children: ReactNode }) {
  const cls = { red: 'bg-status-red text-on-status', amber: 'bg-status-yellow text-on-status', blue: 'bg-accent text-on-accent' }[tone]
  return <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>
}

function AstronautNav({ onNavigate }: { onNavigate: () => void }) {
  const code = useAuth((s) => s.user?.astronautCode)
  const { data } = useDashboard(code)
  const urgent = data?.activeAlerts.filter((a) => a.severity === 'Urgent').length ?? 0
  const attention = (data?.activeAlerts.length ?? 0) - urgent
  const checkinDue = data?.tasks.some((t) => t.code === CHECKIN_TASK) ?? false
  return (
    <ul className="space-y-1">
      {ASTRONAUT_NAV.map((s) => {
        const Icon = s.icon
        return (
          <li key={s.path}>
            <NavLink to={`/astronaut/${s.path}`} className={navCls} onClick={onNavigate}>
              <Icon className="h-5 w-5 shrink-0" aria-hidden />
              <span className="min-w-0 leading-tight">
                <span className="block">{s.label}</span>
                <span className="block text-xs font-normal text-ink-muted" aria-hidden>{s.hint}</span>
              </span>
              {s.path === 'checkin' && checkinDue && <NavBadge tone="blue">Due</NavBadge>}
              {s.path === 'guidance' && urgent > 0 && <NavBadge tone="red">{urgent} urgent</NavBadge>}
              {s.path === 'guidance' && urgent === 0 && attention > 0 && <NavBadge tone="amber">{attention} to review</NavBadge>}
            </NavLink>
          </li>
        )
      })}
    </ul>
  )
}

function StaffNav({ onNavigate }: { onNavigate: () => void }) {
  const role = useAuth((s) => s.user?.role)
  const crew = useCrewSummary()
  return (
    <div className="space-y-5">
      <ul className="space-y-1">
        <li>
          <NavLink to="/staff" end className={navCls} onClick={onNavigate}>
            <Users className="h-5 w-5 shrink-0" aria-hidden /> Crew overview
          </NavLink>
        </li>
        {role === 'Admin' && (
          <li>
            <NavLink to="/staff/sim" className={navCls} onClick={onNavigate}>
              <SlidersHorizontal className="h-5 w-5 shrink-0" aria-hidden /> Demo control
            </NavLink>
          </li>
        )}
      </ul>
      {crew.data && crew.data.length > 0 && (
        <div>
          <p className="px-3 pb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">Astronauts</p>
          <ul className="space-y-1">
            {crew.data.map((c) => (
              <li key={c.code}>
                <NavLink to={`/staff/astronaut/${c.code}`} className={navCls} onClick={onNavigate}>
                  {c.status === 'RED' ? (
                    <AlertOctagon className="h-4 w-4 shrink-0 text-status-red" aria-label="Urgent" />
                  ) : c.status === 'YELLOW' ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-status-yellow" aria-label="Attention" />
                  ) : (
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-status-green" role="img" aria-label="Normal" />
                  )}
                  <span className="min-w-0 truncate">{c.displayName}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-muted">{c.code}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function AppLayout() {
  const { user, signOut } = useAuth()
  useLiveUpdates()
  useOutboxSync()
  useWatchRecorder(user?.role === 'Astronaut' ? user.astronautCode : null)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const [lastPath, setLastPath] = useState(location.pathname)
  if (lastPath !== location.pathname) {
    // close the mobile drawer after navigating (derived from the route, no effect needed)
    setLastPath(location.pathname)
    setMenuOpen(false)
  }
  const start = user?.missionStart
  const profile = useMission(Boolean(user)).data?.profile
  const isAstronaut = user?.role === 'Astronaut'
  const now = useNow()
  const today = new Date(now).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const roleLabel =
    user?.role === 'FlightSurgeon' ? 'Flight surgeon' : user?.role === 'MissionControl' ? 'Mission control' : user?.role
  const close = () => setMenuOpen(false)

  const nav = (
    <nav aria-label="Main" className="flex min-h-full flex-col gap-4 p-3">
      {isAstronaut ? <AstronautNav onNavigate={close} /> : <StaffNav onNavigate={close} />}
      <NavLink to={isAstronaut ? '/astronaut/emergency' : '/staff/emergency'} onClick={close}
        className={({ isActive }) =>
          `mt-auto flex min-h-12 items-center gap-3 rounded-lg border px-3 text-sm font-semibold ${
            isActive ? 'border-status-red bg-status-red text-on-status' : 'border-status-red/50 text-status-red hover:bg-status-red/5'
          }`
        }>
        <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden /> Emergency procedures
      </NavLink>
    </nav>
  )

  return (
    <div className="flex h-full flex-col">
      <a href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2">
        Skip to content
      </a>
      <header className="no-print flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-3 py-2 md:px-5">
        <button type="button" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-controls="mobile-nav"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink hover:bg-subtle md:hidden">
          <Menu className="h-6 w-6" aria-hidden />
          <span className="sr-only">Open menu</span>
        </button>
        <div className="flex items-baseline gap-3">
          <p className="text-base font-bold tracking-wide text-ink">
            ASTRA <span className="text-accent">HEALTH</span>
          </p>
          {start && (
            <p className="hidden text-sm text-ink-muted sm:block">
              <span className="font-medium text-ink">{user?.missionCode}</span> · Mission day {missionDay(start)}
              <span className="hidden lg:inline">
                {profile?.dayName === 'Sol' && <> · Sol {missionSol(start)}</>} · {today}
              </span>
              {profile && (
                <span className="ml-2 hidden rounded-md border border-line px-2 py-0.5 text-xs text-ink md:inline-block"
                  title={`${profile.environment} · ${profile.location}`}>
                  {profile.name} · {profile.gravityG === 0 ? 'weightless' : `${profile.gravityG} g`}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span title="All health data in this prototype is simulated, not from a real crew"
            className="rounded-md border border-status-yellow/40 bg-status-yellow/10 px-2 py-1 text-[11px] font-semibold tracking-wide text-status-yellow">
            SIMULATED DATA
          </span>
          <NodeStatusPill />
          {isAstronaut && <WatchButton />}
          <InstallButton compact />
          <ThemeToggle />
          {user && (
            <span className="hidden text-right text-xs leading-tight lg:block">
              <span className="block font-semibold text-ink">{user.displayName}</span>
              <span className="text-ink-muted">{roleLabel}</span>
            </span>
          )}
          <button onClick={signOut}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-ink-muted hover:bg-subtle hover:text-ink">
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      </header>

      <OfflineBanner />
      {!isAstronaut && <EarthCopyBanner />}
      <div className="relative flex min-h-0 flex-1">
        <aside className="no-print relative hidden w-64 shrink-0 overflow-y-auto border-r border-line bg-surface md:block">{nav}</aside>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30 bg-ink/30 md:hidden" onClick={close} aria-hidden />
            <aside id="mobile-nav" aria-label="Menu"
              className="fixed inset-y-0 left-0 z-40 w-72 overflow-y-auto border-r border-line bg-surface shadow-lg md:hidden">
              <div className="flex justify-end p-2">
                <button type="button" onClick={close}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-subtle">
                  <X className="h-6 w-6" aria-hidden />
                  <span className="sr-only">Close menu</span>
                </button>
              </div>
              {nav}
            </aside>
          </>
        )}
        {/* `relative`: screen-reader-only text (absolutely positioned) stays inside this scroll area; without it,
            it is placed against the page and stretches the page below the window */}
        <main id="main" tabIndex={-1} className="print-area relative min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-7">
          <Outlet />
        </main>
      </div>

      <footer className="no-print border-t border-line bg-surface px-4 py-1.5 text-center text-[11px] text-ink-muted">
        Prototype decision support, not a diagnosis. Thresholds are illustrative and all data is simulated.
      </footer>
      <Toaster />
    </div>
  )
}
