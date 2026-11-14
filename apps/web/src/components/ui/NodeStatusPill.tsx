import { useQuery } from '@tanstack/react-query'
import { getSystemStatus } from '../../lib/api'

/** Shows whether the Habitat API is reachable. Becomes the link-status pill in Step 9. */
export function NodeStatusPill() {
  const { data, isError, isPending } = useQuery({
    queryKey: ['system-status'],
    queryFn: getSystemStatus,
    refetchInterval: 10_000,
    retry: false,
  })

  const [dot, label] = isPending
    ? ['bg-ink-muted', 'Connecting…']
    : isError
      ? ['bg-status-red', 'API offline']
      : ['bg-status-green', `${data.nodeRole} · ${data.nodeId}`]

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-space-600 bg-space-800 px-3 py-1 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  )
}
