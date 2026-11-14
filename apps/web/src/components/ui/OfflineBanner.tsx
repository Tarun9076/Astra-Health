import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudOff } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { api, unwrap } from '../../lib/api'
import { useOutbox } from '../../lib/outbox'

function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

/** Device offline or Habitat server unreachable: say what is shown and what is waiting to be sent. */
export function OfflineBanner() {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine)
  const server = useQuery({
    queryKey: ['system-status'],
    queryFn: () => unwrap(api.GET('/api/system/status')),
    refetchInterval: 15_000,
    retry: false,
  })
  const pending = useOutbox((s) => s.pending)
  const queryClient = useQueryClient()
  const offline = !online || server.isError
  if (!offline && pending === 0) return null

  const saved = Math.max(0, ...queryClient.getQueryCache().findAll({ queryKey: ['dashboard'] }).map((q) => q.state.dataUpdatedAt))
  const at = saved ? new Date(saved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div role="status" className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-status-yellow/50 bg-status-yellow/10 px-4 py-2 text-xs">
      <span className="inline-flex items-center gap-1.5 font-semibold text-status-yellow">
        <CloudOff className="h-4 w-4" aria-hidden /> {offline ? 'Offline' : 'Back online'}
      </span>
      {offline && <span>{at ? `Showing data saved on this device at ${at}.` : 'No saved data on this device yet.'}</span>}
      {pending > 0 && <span>{pending} item(s) saved on this device will be sent {offline ? 'when the habitat server is back' : 'now'}.</span>}
    </div>
  )
}
