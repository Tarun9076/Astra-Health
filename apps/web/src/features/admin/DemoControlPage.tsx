import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Radiation, RotateCcw, Satellite, Wifi, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { api, unwrap, type SyncStatus } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { timeAgo } from '../../lib/mission'
import { useSyncStatus } from '../../lib/queries'

/** The Ground node's sync status, read directly (the Admin otherwise talks to the Habitat). */
function useGroundStatus() {
  const token = useAuth((s) => s.token)
  return useQuery({
    queryKey: ['ground-sync-status'],
    queryFn: async (): Promise<SyncStatus> => {
      const r = await fetch('/ground-api/sync/status', { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error(`Ground node: HTTP ${r.status}`)
      return (await r.json()) as SyncStatus
    },
    refetchInterval: 3_000,
    retry: false,
  })
}

function Queue({ title, status, error }: { title: string; status?: SyncStatus; error?: Error | null }) {
  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <p className="text-xs font-semibold tracking-wider text-ink-muted uppercase">{title}</p>
      {error ? <p className="mt-1 text-status-red">Unreachable — start the Ground node on :8001</p> : status ? (
        <dl className="mt-1 grid grid-cols-3 gap-2 font-mono">
          <div><dt className="font-sans text-xs text-ink-muted">Waiting</dt><dd>{status.pending}</dd></div>
          <div><dt className="font-sans text-xs text-ink-muted">In flight</dt><dd>{status.inFlight}</dd></div>
          <div><dt className="font-sans text-xs text-ink-muted">Delivered</dt><dd>{status.acked}</dd></div>
          <div className="col-span-3 font-sans text-xs text-ink-muted">
            Last received {status.lastReceivedAt ? timeAgo(status.lastReceivedAt) : '—'} · last ACK {status.lastAckAt ? timeAgo(status.lastAckAt) : '—'}
          </div>
        </dl>
      ) : <Loading />}
    </div>
  )
}

/** Demo Control Panel (Step 9): the deep-space link and scenario injection. Admin, on the Habitat. */
export function DemoControlPage() {
  const habitat = useSyncStatus()
  const ground = useGroundStatus()
  const queryClient = useQueryClient()
  const link = habitat.data?.link
  const [draft, setMinutes] = useState<number | null>(null)
  const minutes = draft ?? link?.realDelayMinutes ?? null

  const setLink = useMutation({
    mutationFn: (body: { status?: 'Up' | 'Down'; realDelayMinutes?: number; useHorizons?: boolean; compressionSecondsPerMinute?: number }) =>
      unwrap(api.PUT('/api/admin/link', { body: { useHorizons: false, ...body } })),
    onSuccess: (l) => {
      setMinutes(null)
      void l
      void queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    },
  })
  const inject = useMutation({
    mutationFn: (scenario: 'fatigue' | 'solar-storm') => unwrap(api.POST('/api/admin/sim/scenario', { body: { scenario, astronautId: 'AST-001' } })),
  })

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Demo control</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The Habitat (onboard) and Ground (Earth) nodes talk over a simulated deep-space link. Take it down to see the
          habitat keep working on its own; bring it up to watch queued data cross with the real Earth–Mars light time.
        </p>
      </div>
      {habitat.error && <ErrorNote error={habitat.error} />}

      <Panel title="Deep-space link">
        {!link ? <Loading /> : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${link.status === 'Up' ? 'bg-status-green/15 text-status-green' : 'bg-status-red/15 text-status-red'}`}>
                {link.status === 'Up' ? <Wifi className="h-4 w-4" aria-hidden /> : <WifiOff className="h-4 w-4" aria-hidden />}
                Link {link.status === 'Up' ? 'UP' : 'DOWN'}
              </span>
              <Button variant={link.status === 'Up' ? 'danger' : 'primary'} disabled={setLink.isPending}
                onClick={() => setLink.mutate({ status: link.status === 'Up' ? 'Down' : 'Up' })}>
                {link.status === 'Up' ? 'Take link down' : 'Bring link up'}
              </Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="text-sm">
                <p className="flex items-center gap-2"><Satellite className="h-4 w-4 text-accent" aria-hidden />
                  One-way delay <span className="font-mono">{link.realDelayMinutes.toFixed(1)} light-min</span>
                  <span className="text-ink-muted">({link.delaySource === 'horizons' ? 'JPL Horizons, today' : 'manual'})</span></p>
                <p className="mt-1 text-xs text-ink-muted">
                  Demo time: {link.compressionSecondsPerMinute} s per light-minute → <span className="font-mono">{link.oneWaySeconds.toFixed(0)} s</span> one way,
                  {' '}{(2 * link.oneWaySeconds).toFixed(0)} s round trip.
                  {link.horizonsDelayMinutes != null && ` Real light time today: ${link.horizonsDelayMinutes.toFixed(1)} min.`}
                </p>
              </div>
              <div className="space-y-2 text-sm">
                <label className="block">
                  <span className="text-xs text-ink-muted">Override delay: {minutes?.toFixed(1)} light-min (Mars: 3–22)</span>
                  <input type="range" min={0} max={24} step={0.5} value={minutes ?? 0} className="w-full"
                    onChange={(e) => setMinutes(Number(e.target.value))}
                    onMouseUp={() => minutes != null && setLink.mutate({ realDelayMinutes: minutes })}
                    onKeyUp={() => minutes != null && setLink.mutate({ realDelayMinutes: minutes })} />
                </label>
                <Button variant="ghost" onClick={() => setLink.mutate({ useHorizons: true })} disabled={setLink.isPending}>
                  <RotateCcw className="h-4 w-4" aria-hidden /> Use today's real light time
                </Button>
              </div>
            </div>
            {setLink.isError && <ErrorNote error={setLink.error} />}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Queue title="Habitat → Earth queue" status={habitat.data} />
        <Queue title="Earth → Habitat queue" status={ground.data} error={ground.error} />
      </div>

      <Panel title="Scenarios (start now, through the normal intake)">
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => inject.mutate('fatigue')} disabled={inject.isPending}>
            <Activity className="h-4 w-4" aria-hidden /> Inject fatigue episode (AST-001)
          </Button>
          <Button variant="ghost" onClick={() => inject.mutate('solar-storm')} disabled={inject.isPending}>
            <Radiation className="h-4 w-4" aria-hidden /> Replay May 2024 solar storm peak (all crew)
          </Button>
        </div>
        {inject.data && (
          <p className="mt-3 text-sm">{inject.data.readings} reading(s) recorded; new alerts: {inject.data.newAlerts.join(', ') || 'none (already active)'}.</p>
        )}
        {inject.isError && <ErrorNote error={inject.error} />}
        <p className="mt-3 text-xs text-ink-muted">
          Resetting the demo rebuilds the databases: run <code>python -m astra.seed --mission-day-today N</code> and
          <code> simulator/simulate.py seed</code> (see the plan, Step 4).
        </p>
      </Panel>
    </div>
  )
}
