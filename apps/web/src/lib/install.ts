// "Install app" (Step 18). Chrome, Edge and Android announce that the app can be installed with a
// `beforeinstallprompt` event, often before React has rendered, so it is caught at startup (main.tsx)
// and kept here; the button shows the browser's own install dialog. Without that offer (not yet, or
// Safari on iPhone and iPad, which never sends it) the button explains where install is instead.
import { create } from 'zustand'

/** Chrome's install event (not in the standard DOM types). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

interface InstallState {
  offer: BeforeInstallPromptEvent | null // the browser is ready to install
  installed: boolean // installed in this session, or already running as the installed app
}

export const useInstall = create<InstallState>(() => ({ offer: null, installed: false }))

/** Running as the installed app (its own window, no browser bar). */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches)
}

/** How this browser installs web apps: its own dialog (Chrome, Edge, Android), Safari's Share menu
 * (iPhone, iPad: every iOS browser uses Safari's engine), or not at all (Firefox on a computer). */
export function browserKind(): 'dialog' | 'ios' | 'unsupported' {
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Firefox\//.test(ua) && !/Android/.test(ua)) return 'unsupported'
  return 'dialog'
}

export function initInstall(): void {
  useInstall.setState({ installed: isStandalone() })
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault() // keep the browser's own mini bar quiet; our button shows the dialog
    useInstall.setState({ offer: event as BeforeInstallPromptEvent })
  })
  window.addEventListener('appinstalled', () => useInstall.setState({ offer: null, installed: true }))
}

/** Shows the browser's install dialog. True when the person accepted. */
export async function installApp(): Promise<boolean> {
  const { offer } = useInstall.getState()
  if (!offer) return false
  await offer.prompt()
  const { outcome } = await offer.userChoice
  // an offer can be used once; the browser sends a new one later if the person declined
  useInstall.setState({ offer: null, installed: outcome === 'accepted' })
  return outcome === 'accepted'
}
