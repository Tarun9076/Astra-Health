import { Download, EllipsisVertical, MonitorDown, Share, SquarePlus } from 'lucide-react'
import { useState } from 'react'
import { browserKind, installApp, useInstall } from '../../lib/install'

/**
 * "Install app" (Step 18): always visible until the app is installed. When the browser has offered
 * installation it opens the browser's install dialog; otherwise it shows where install is in this
 * browser (Safari: Share → Add to Home Screen). `compact` for the header, full width on sign-in.
 */
export function InstallButton({ compact = false }: { compact?: boolean }) {
  const { offer, installed } = useInstall()
  const [help, setHelp] = useState(false)
  if (installed) return null

  const label = compact ? 'Install app' : 'Install ASTRA HEALTH on this device'
  const cls = compact
    ? 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-accent/50 bg-accent-soft px-3 text-sm font-semibold text-accent hover:bg-accent/15'
    : 'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-accent/50 bg-accent-soft px-4 text-sm font-semibold text-accent hover:bg-accent/15'

  return (
    <div className="relative">
      <button type="button" className={cls} aria-expanded={offer ? undefined : help}
        onClick={() => (offer ? void installApp() : setHelp((h) => !h))}>
        <Download className="h-4 w-4" aria-hidden /> {label}
      </button>
      {!offer && help && (
        <div role="note" className={`${compact ? 'absolute right-0 z-40 mt-2 w-80 shadow-lg' : 'mt-2'} rounded-xl border border-line bg-surface p-4 text-left text-sm text-ink`}>
          <HowToInstall />
        </div>
      )}
    </div>
  )
}

/** Where "install" is in this browser. */
function HowToInstall() {
  const kind = browserKind()
  if (kind === 'ios') {
    return (
      <>
        <p className="font-semibold">Install on iPhone or iPad</p>
        <ol className="mt-2 space-y-1.5">
          <li className="flex items-center gap-2">1. Tap <Share className="h-4 w-4 text-accent" aria-label="Share" /> at the bottom of Safari.</li>
          <li className="flex items-center gap-2">2. Choose <SquarePlus className="h-4 w-4 text-accent" aria-hidden /> <strong>Add to Home Screen</strong>.</li>
          <li>3. Tap <strong>Add</strong>. ASTRA HEALTH opens from your home screen and works offline.</li>
        </ol>
      </>
    )
  }
  if (kind === 'unsupported') {
    return (
      <>
        <p className="font-semibold">This browser can’t install apps</p>
        <p className="mt-1">Open this page in <strong>Chrome</strong> or <strong>Edge</strong> (on a computer or Android), then press Install app again.</p>
      </>
    )
  }
  return (
    <>
      <p className="font-semibold">Install from the browser</p>
      <ol className="mt-2 space-y-1.5">
        <li className="flex items-start gap-2">
          <MonitorDown className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span>Click the <strong>install icon</strong> at the right end of the address bar, if you see one.</span>
        </li>
        <li className="flex items-start gap-2">
          <EllipsisVertical className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span>
            Or open the browser menu: in <strong>Chrome</strong>, ⋮ → <strong>Cast, save and share</strong> → <strong>Install page as app</strong>;
            in <strong>Edge</strong>, ⋯ → <strong>Apps</strong> → <strong>Install this site as an app</strong>. On Android: ⋮ → <strong>Add to Home screen</strong>.
          </span>
        </li>
      </ol>
      <p className="mt-2 text-xs text-ink-muted">The browser may need a few seconds on the page before it allows installing. If this button opens the install dialog by itself next time, just confirm it.</p>
    </>
  )
}
