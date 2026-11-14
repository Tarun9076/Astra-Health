import { useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, LogOut, SlidersHorizontal, Users } from 'lucide-react'
import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { EarthCopyBanner } from '../components/ui/EarthCopyBanner'
import { OfflineBanner } from '../components/ui/OfflineBanner'
import { NodeStatusPill } from '../components/ui/NodeStatusPill'
import { Toaster } from '../components/ui/Toaster'
import { useAuth } from '../lib/auth'
import { missionDay, missionSol } from '../lib/mission'
import { startOutboxSync } from '../lib/outbox'
import { RealtimeClient, type LiveEvent } from '../lib/realtime'
import { useToasts } from '../lib/toasts'
import { ASTRONAUT_SECTIONS } from './sections'


function useLiveUpdates() {
  const token = useAuth((s) => s.token)
  const role = useAuth((s) => s.user?.role)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)

  useEffect(() => {
    if (!token) return
    const onEvent = (event: LiveEvent) => {
      if (['AlertRaised', 'AlertUpdated', 'MeasurementRecorded', 'CheckinCompleted'].includes(event.type)) {
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        void queryClient.invalidateQueries({ queryKey: ['alerts'] })
        void queryClient.invalidateQueries({ queryKey: ['alert'] })
        void queryClient.invalidateQueries({ queryKey: ['analytics'] })
        void queryClient.invalidateQueries({ queryKey: ['wellness'] })
        void queryClient.invalidateQueries({ queryKey: ['insights'] })
        void queryClient.invalidateQueries({ queryKey: ['crew-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['body-systems'] })
        void queryClient.invalidateQueries({ queryKey: ['radiation'] })
        void queryClient.invalidateQueries({ queryKey: ['wellness-center'] })
        void queryClient.invalidateQueries({ queryKey: ['environment'] })
      }
      if (['InstructionReceived', 'InstructionAcknowledged'].includes(event.type)) {
        void queryClient.invalidateQueries({ queryKey: ['instructions'] })
        void queryClient.invalidateQueries({ queryKey: ['crew-summary'] })
      }
      if (event.type === 'LinkChanged') {
        void queryClient.invalidateQueries({ queryKey: ['sync-status'] })
      }
      if (event.type === 'ReportGenerated') {
        void queryClient.invalidateQueries({ queryKey: ['reports'] })
        void queryClient.invalidateQueries({ queryKey: ['crew-summary'] })
      }
      if (event.type === 'InstructionReceived' && role === 'Astronaut') {
        const p = event.payload as { fromName?: string; text?: string }
        push({ tone: 'info', title: `Message from ${p.fromName ?? 'the flight surgeon'}`, body: p.text, href: '/astronaut/overview' })
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
          href: role === 'Astronaut' && p.id ? `/astronaut/alerts?id=${p.id}` : p.astronautCode ? `/staff/astronaut/${p.astronautCode}` : undefined,
        })
      }
    }
    const client = new RealtimeClient(token, onEvent)
    client.connect()
    return () => client.close()
  }, [token, role, queryClient, push])
}

const navCls = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-12 shrink-0 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
    isActive ? 'bg-space-700 text-ink' : 'text-ink-muted hover:bg-space-800 hover:text-ink'
  }`

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

export function AppLayout() {
  const { user, signOut } = useAuth()
  useLiveUpdates()
  useOutboxSync()
  const start = user?.missionStart
  const isAstronaut = user?.role === 'Astronaut'

  return (
    <div className="flex h-full flex-col">
      <header className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-space-700 bg-space-950 px-4 py-3">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-lg font-bold tracking-widest text-accent">ASTRA HEALTH</p>
            <p className="text-[11px] tracking-[0.2em] text-ink-muted uppercase">Crew health intelligence</p>
          </div>
          {start && (
            <span className="hidden rounded-lg border border-space-600 px-3 py-1 font-mono text-xs sm:inline">
              {user?.missionCode} · Day {missionDay(start)} · Sol {missionSol(start)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-status-yellow/50 px-3 py-1 text-xs font-semibold text-status-yellow">
            SIMULATED DATA
          </span>
          <NodeStatusPill />
          {user && (
            <span className="hidden text-right text-xs md:block">
              <span className="block font-medium">{user.displayName}</span>
              <span className="text-ink-muted">{user.role === 'FlightSurgeon' ? 'Flight surgeon' : user.role}</span>
            </span>
          )}
          <button
            onClick={signOut}
            className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs text-ink-muted hover:bg-space-800 hover:text-ink"
          >
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      </header>

      <OfflineBanner />
      {!isAstronaut && <EarthCopyBanner />}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="no-print flex gap-1 overflow-x-auto border-b border-space-700 bg-space-950 p-2 md:w-60 md:flex-col md:border-r md:border-b-0">
          {isAstronaut ? (
            <>
              <NavLink to="/astronaut/checkin" className={navCls}>
                <ClipboardCheck className="h-4 w-4 text-accent" aria-hidden />
                Daily check-in
              </NavLink>
              {ASTRONAUT_SECTIONS.map((s) => (
                <NavLink key={s.path} to={`/astronaut/${s.path}`} className={navCls}>
                  <span className="font-mono text-xs text-accent">{s.num}</span>
                  {s.title}
                </NavLink>
              ))}
            </>
          ) : (
            <>
              <NavLink to="/staff" end className={navCls}>
                <Users className="h-4 w-4 text-accent" aria-hidden />
                Crew
              </NavLink>
              {user?.role === 'Admin' && (
                <NavLink to="/staff/sim" className={navCls}>
                  <SlidersHorizontal className="h-4 w-4 text-accent" aria-hidden />
                  Demo control
                </NavLink>
              )}
            </>
          )}
        </nav>

        <main className="print-area min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>

      <footer className="no-print border-t border-space-700 bg-space-950 px-4 py-2 text-center text-[11px] text-ink-muted">
        Prototype decision support only — not a diagnosis. Thresholds are illustrative; all data is simulated.
      </footer>
      <Toaster />
    </div>
  )
}
