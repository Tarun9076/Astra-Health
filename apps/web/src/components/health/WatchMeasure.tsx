import { HeartPulse, Watch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNow } from '../../lib/useNow'
import { liveBpm, medianSince, useWatch, watchSupported } from '../../lib/watch'

const SECONDS = 30

/**
 * Check-in, resting heart rate (Step 15): measure 30 s with the connected watch while sitting still,
 * and fill in the median. The person still sees the value and can change it before sending.
 */
export function WatchMeasure({ onResult }: { onResult: (bpm: number) => void }) {
  const watch = useWatch()
  const now = useNow(1000)
  const [start, setStart] = useState<number | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const done = useRef(onResult)
  useEffect(() => {
    done.current = onResult
  }, [onResult])
  const left = start == null ? 0 : Math.max(0, SECONDS - Math.floor((now - start) / 1000))

  useEffect(() => {
    if (start == null) return
    const id = setTimeout(() => {
      const { bpm, count } = medianSince(start)
      setStart(null)
      if (bpm == null || count < 5) {
        setResult('The watch sent too few readings. Wear it snugly and try again, or type the value.')
        return
      }
      done.current(bpm)
      setResult(`Measured by your watch: ${bpm} bpm (middle value of ${count} readings in ${SECONDS} s).`)
    }, SECONDS * 1000)
    return () => clearTimeout(id)
  }, [start])

  if (!watchSupported()) return null
  const bpm = liveBpm(watch, now)
  if (watch.status !== 'on') {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-sm text-ink-muted">
        <Watch className="h-4 w-4 shrink-0" aria-hidden /> Have a smartwatch? Use “Connect watch” at the top to measure this automatically.
      </p>
    )
  }
  return (
    <div className="rounded-lg border border-accent/40 bg-accent-soft p-3 text-sm">
      {start != null ? (
        <p role="status" className="flex items-center gap-2 font-medium">
          <HeartPulse className="h-4 w-4 text-accent motion-safe:animate-pulse" aria-hidden />
          Sit still and breathe normally… {left} s{bpm != null ? ` · now ${bpm} bpm` : ''}
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-accent" aria-hidden />
            {bpm != null ? `Your watch reads ${bpm} bpm now.` : 'Your watch is connected; waiting for a reading.'}
          </p>
          <button type="button" disabled={bpm == null} onClick={() => { setResult(null); setStart(Date.now()) }}
            className="inline-flex min-h-10 items-center rounded-lg bg-accent px-3 font-semibold text-on-accent disabled:opacity-50">
            Measure with my watch ({SECONDS} s)
          </button>
        </div>
      )}
      {result && <p className="mt-2" role="status">{result}</p>}
    </div>
  )
}
