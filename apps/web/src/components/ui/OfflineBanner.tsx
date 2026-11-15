import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudOff, WifiOff } from 'lucide-react'
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

/**
 * Two different things, two different messages:
 * - the **Habitat server** can't be reached: offline for real; saved screens are shown and writes wait;
 * - only the **internet** is gone: everything on board keeps working (the server is on the spacecraft,
 *   here this computer); just the online AI model is unavailable, so the assistant answers offline.
 */
export function OfflineBanner() {
  const internet = useSyncExternalStore(subscribe, () => navigator.onLine)
  const server = useQuery({
    queryKey: ['system-status'],
    queryFn: () => unwrap(api.GET('/api/system/status')),
    refetchInterval: 15_000,
    retry: false,
  })
  const pending = useOutbox((s) => s.pending)
  const queryClient = useQueryClient()
  const serverDown = server.isError

  if (!serverDown && !internet) {
    return (
      <div role="status" className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-subtle px-4 py-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
          <WifiOff className="h-4 w-4" aria-hidden /> No internet
        </span>
        <span className="text-ink-muted">Everything on board keeps working. The AI assistant uses its offline answers until the internet is back.</span>
      </div>
    )
  }
  if (!serverDown && pending === 0) return null

  const saved = Math.max(0, ...queryClient.getQueryCache().findAll({ queryKey: ['dashboard'] }).map((q) => q.state.dataUpdatedAt))
  const at = saved ? new Date(saved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div role="status" className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-status-yellow/50 bg-status-yellow/10 px-4 py-2 text-xs">
      <span className="inline-flex items-center gap-1.5 font-semibold text-status-yellow">
        <CloudOff className="h-4 w-4" aria-hidden /> {serverDown ? 'Habitat server not reachable' : 'Back online'}
      </span>
      {serverDown && <span>{at ? `Showing data saved on this device at ${at}.` : 'No saved data on this device yet.'}</span>}
      {pending > 0 && <span>{pending} item(s) saved on this device will be sent {serverDown ? 'when the habitat server is back' : 'now'}.</span>}
    </div>
  )
}
