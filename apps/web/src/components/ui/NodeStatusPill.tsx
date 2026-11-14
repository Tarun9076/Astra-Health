import { useQuery } from '@tanstack/react-query'
import { Satellite } from 'lucide-react'
import { api, unwrap } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useSyncStatus } from '../../lib/queries'
import { useLiveStatus } from '../../lib/realtime'

/** This node (Habitat onboard / Ground on Earth), the live socket, and the deep-space link. */
export function NodeStatusPill() {
  const live = useLiveStatus((s) => s.status)
  const signedIn = useAuth((s) => Boolean(s.token))
  const sync = useSyncStatus(signedIn)
  const { data, isError, isPending } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => unwrap(api.GET('/api/system/status')),
    refetchInterval: 15_000,
    retry: false,
  })
  const [dot, label] = isPending
    ? ['bg-ink-muted', 'Connecting…']
    : isError
      ? ['bg-status-red', 'Server offline']
      : live === 'live'
        ? ['bg-status-green', `${data.nodeRole} · live`]
        : ['bg-status-yellow', `${data.nodeRole} · ${live === 'off' ? 'online' : 'reconnecting'}`]
  const link = sync.data?.link
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
        {label}
      </span>
      {link && (
        <span title={`One-way light time ${link.realDelayMinutes.toFixed(1)} min (${link.delaySource}); shown as ${link.oneWaySeconds.toFixed(0)} s in demo time`}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${link.status === 'Up' ? 'border-line-strong bg-surface' : 'border-status-red/60 bg-status-red/10 text-status-red'}`}>
          <Satellite className="h-3.5 w-3.5" aria-hidden />
          Earth link {link.status === 'Up' ? `UP · ${link.realDelayMinutes.toFixed(1)} light-min` : 'DOWN'}
          {sync.data && sync.data.pending + sync.data.inFlight > 0 && ` · ${sync.data.pending + sync.data.inFlight} queued`}
        </span>
      )}
    </span>
  )
}
