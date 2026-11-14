import { ShieldAlert } from 'lucide-react'
import { EMERGENCY_PROTOCOLS } from '../../lib/emergency'
import { ProtocolSteps } from './Panel'

/** Emergency procedure from the copy bundled into the app, so it works even when the backend is down. */
export function EmergencyProtocolCard({ id, reported }: { id: string; reported?: boolean }) {
  const protocol = EMERGENCY_PROTOCOLS[id]
  return (
    <div className="rounded-xl border-2 border-status-red bg-status-red/10 p-4" role="alert">
      <p className="mb-1 flex items-center gap-2 text-base font-semibold text-status-red">
        <ShieldAlert className="h-5 w-5" aria-hidden /> {protocol?.title ?? id}
      </p>
      <p className="mb-3 text-sm font-medium">
        {reported
          ? 'Reported as an urgent symptom — the crew medical officer and flight surgeon are alerted.'
          : 'If this is happening now: call the crew medical officer and follow these steps.'}
      </p>
      {protocol ? <ProtocolSteps markdown={protocol.body} /> : <p className="text-sm">Open the onboard checklist {id}.</p>}
      {protocol && <p className="mt-3 text-xs text-ink-muted">{protocol.disclaimer}</p>}
    </div>
  )
}
