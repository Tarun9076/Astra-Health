import { Download, Share, SquarePlus } from 'lucide-react'
import { useState } from 'react'
import { installApp, isIosSafari, useInstall } from '../../lib/install'

/**
 * "Install app" (Step 18): shown only when this browser can install the app and it is not installed
 * yet. `compact` for the header, the full-width version for the sign-in page.
 */
export function InstallButton({ compact = false }: { compact?: boolean }) {
  const { offer, installed } = useInstall()
  const [help, setHelp] = useState(false)
  const ios = isIosSafari()
  if (installed || (!offer && !ios)) return null

  const label = compact ? 'Install app' : 'Install ASTRA HEALTH on this device'
  const cls = compact
    ? 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm font-medium text-ink hover:bg-subtle'
    : 'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-line-strong px-4 text-sm font-semibold text-ink hover:bg-subtle'

  return (
    <div className="relative">
      <button type="button" className={cls} aria-expanded={ios ? help : undefined}
        onClick={() => (ios ? setHelp((h) => !h) : void installApp())}>
        <Download className="h-4 w-4" aria-hidden /> {label}
      </button>
      {ios && help && (
        <div role="note" className={`${compact ? 'absolute right-0 z-40 mt-2 w-72 shadow-lg' : 'mt-2'} rounded-xl border border-line bg-surface p-4 text-sm`}>
          <p className="font-semibold">Install on iPhone or iPad</p>
          <ol className="mt-2 space-y-1.5">
            <li className="flex items-center gap-2">1. Tap <Share className="h-4 w-4 text-accent" aria-label="Share" /> at the bottom of Safari.</li>
            <li className="flex items-center gap-2">2. Choose <SquarePlus className="h-4 w-4 text-accent" aria-hidden /> <strong>Add to Home Screen</strong>.</li>
            <li>3. Tap <strong>Add</strong>. ASTRA HEALTH opens from your home screen and works offline.</li>
          </ol>
        </div>
      )}
    </div>
  )
}
