import { HeartPulse, Loader2, Watch } from 'lucide-react'
import { useEffect } from 'react'
import { useNow } from '../../lib/useNow'
import { useToasts } from '../../lib/toasts'
import { connectWatch, disconnectWatch, liveBpm, useWatch, watchSupported } from '../../lib/watch'

/** Header control for the astronaut's own watch (Step 15): connect, live heart rate, disconnect. */
export function WatchButton() {
  const watch = useWatch()
  const now = useNow(2000)
  const push = useToasts((s) => s.push)
  useEffect(() => {
    if (watch.status === 'error' && watch.message) push({ tone: 'attention', title: 'Watch not connected', body: watch.message })
  }, [watch.status, watch.message, push])
  if (!watchSupported()) return null

  if (watch.status === 'connecting' || watch.status === 'reconnecting') {
    return (
      <span className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-ink-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {watch.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
      </span>
    )
  }
  if (watch.status !== 'on') {
    return (
      <button type="button" onClick={() => void connectWatch()}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm font-medium text-ink hover:bg-subtle">
        <Watch className="h-4 w-4" aria-hidden /> Connect watch
      </button>
    )
  }
  const bpm = liveBpm(watch, now)
  return (
    <details className="relative">
      <summary aria-label={bpm != null ? `Your watch: heart rate ${bpm} beats per minute` : 'Your watch: waiting for a reading'}
        className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-status-green/40 bg-status-green/10 px-3 text-sm font-semibold text-status-green [&::-webkit-details-marker]:hidden">
        <HeartPulse className={`h-4 w-4 ${bpm != null ? 'motion-safe:animate-pulse' : ''}`} aria-hidden />
        {bpm != null ? <span className="tabular-nums">{bpm} bpm</span> : <span>Watch</span>}
      </summary>
      <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-line bg-surface p-4 text-sm shadow-lg">
        <p className="font-semibold">{watch.name}</p>
        <p className="mt-1 text-ink-muted">
          {bpm != null ? `Heart rate now: ${bpm} bpm.` : 'Connected, waiting for a heart-rate reading. Wear the watch snugly.'}
        </p>
        <p className="mt-2 text-ink-muted">
          One reading a minute is saved to your health record as a watch reading ({watch.savedMinutes} so far).
        </p>
        <button type="button" onClick={disconnectWatch}
          className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-line-strong px-3 font-medium hover:bg-subtle">
          Disconnect
        </button>
      </div>
    </details>
  )
}
