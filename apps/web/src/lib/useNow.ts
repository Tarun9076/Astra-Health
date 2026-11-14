import { useEffect, useState } from 'react'

/** Current time (ms) for rendering, refreshed every minute so "today" and "2 h ago" stay right. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
