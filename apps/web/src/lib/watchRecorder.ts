// While the watch is connected, save one heart-rate reading a minute (the median of that minute) as a
// Wearable reading, through the offline outbox like every other write (Step 15).
import { useEffect } from 'react'
import { sendOrQueue } from './outbox'
import { medianSince, useWatch } from './watch'

const MIN_BEATS = 5 // fewer readings than this in a minute: the watch was not really worn or connected

// Tests shorten the minute (set before the app loads); the real app always uses 60 s.
const saveEveryMs = () => (globalThis as { __ASTRA_WATCH_SAVE_MS?: number }).__ASTRA_WATCH_SAVE_MS ?? 60_000

export function useWatchRecorder(code: string | null | undefined): void {
  useEffect(() => {
    if (!code) return
    const every = saveEveryMs()
    const id = setInterval(() => {
      const state = useWatch.getState()
      if (state.status !== 'on') return
      const end = Date.now()
      const { bpm, count } = medianSince(end - every)
      if (bpm == null || count < MIN_BEATS) return
      const body = {
        astronautId: code,
        items: [{
          indicator: 'heart_rate', value: bpm, unit: 'bpm', measuredAt: new Date(end).toISOString(),
          source: 'Wearable', deviceId: `WATCH:${state.name ?? 'watch'}`,
        }],
      }
      sendOrQueue('/api/measurements/batch', body)
        .then(() => useWatch.setState((s) => ({ savedMinutes: s.savedMinutes + 1 })))
        .catch(() => { /* a rejected reading is not retried; the next minute is a new one */ })
    }, every)
    return () => clearInterval(id)
  }, [code])
}
