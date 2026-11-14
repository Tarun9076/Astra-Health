import { ChevronDown, ShieldAlert } from 'lucide-react'
import { ProtocolSteps } from '../../components/ui/Panel'
import { EMERGENCY_PROTOCOLS } from '../../lib/emergency'

/**
 * All emergency procedures, always one tap away from the side menu. Bundled into the app, so they
 * open even with the habitat server or the Earth link down.
 */
export function EmergencyPage() {
  const protocols = Object.values(EMERGENCY_PROTOCOLS).sort((a, b) => a.title.localeCompare(b.title))
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-status-red">
          <ShieldAlert className="h-7 w-7" aria-hidden /> Emergency procedures
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          If someone is in danger now: call the crew medical officer, then follow the steps. These checklists are stored
          on this device and work offline.
        </p>
      </header>
      <ul className="space-y-3">
        {protocols.map((p) => (
          <li key={p.id}>
            <details className="group rounded-xl border border-line bg-surface open:border-status-red/60">
              <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 text-base font-semibold">
                <ShieldAlert className="h-5 w-5 shrink-0 text-status-red" aria-hidden />
                <span className="flex-1">{p.title}</span>
                <span className="font-mono text-xs font-normal text-ink-muted">{p.id}</span>
                <ChevronDown className="h-5 w-5 text-ink-muted transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="border-t border-line px-4 py-4">
                <ProtocolSteps markdown={p.body} />
                <p className="mt-3 text-xs text-ink-muted">{p.disclaimer}</p>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  )
}
