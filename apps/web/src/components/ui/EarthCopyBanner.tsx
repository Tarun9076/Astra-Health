import { Globe2 } from 'lucide-react'
import { timeAgo } from '../../lib/mission'
import { useSyncStatus } from '../../lib/queries'

/** Earth roles read the Ground node's copy: say how fresh it is and whether the link is up. */
export function EarthCopyBanner() {
  const { data } = useSyncStatus()
  if (!data || data.nodeRole !== 'Ground') return null
  const link = data.link
  const down = link?.status === 'Down'
  return (
    <div className={`no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs ${down ? 'border-status-red/40 bg-status-red/10' : 'border-space-700 bg-space-950'}`}>
      <span className="inline-flex items-center gap-1.5 font-semibold"><Globe2 className="h-4 w-4 text-accent" aria-hidden /> Earth copy (Ground node)</span>
      <span className="text-ink-muted">
        Data from the Habitat arrives after the light-time delay
        {link && ` (${link.realDelayMinutes.toFixed(1)} light-min; ${link.oneWaySeconds.toFixed(0)} s in demo time)`}.
        {' '}Last received {data.lastReceivedAt ? timeAgo(data.lastReceivedAt) : 'not yet'}.
      </span>
      {down && <span className="font-semibold text-status-red">Link DOWN — newer onboard data is waiting to be sent.</span>}
    </div>
  )
}
