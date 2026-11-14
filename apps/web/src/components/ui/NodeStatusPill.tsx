import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../lib/api'
import { useLiveStatus } from '../../lib/realtime'

/** Habitat server reachability + live-update socket. Becomes the Earth-link pill in Step 9. */
export function NodeStatusPill() {
  const live = useLiveStatus((s) => s.status)
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
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-space-600 bg-space-800 px-3 py-1 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  )
}
