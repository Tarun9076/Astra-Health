// "Install app" (Step 18). Chrome, Edge and Android announce that the app can be installed with a
// `beforeinstallprompt` event, often before React has rendered, so it is caught at startup (main.tsx)
// and kept here; the button shows the browser's own install dialog. Safari on iPhone and iPad has no
// such event: there the button explains Share → Add to Home Screen instead.
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

/** Safari on iPhone or iPad (iPadOS reports itself as a Mac with touch). */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
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
