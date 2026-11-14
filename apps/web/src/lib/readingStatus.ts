import { ArrowDown, ArrowUp, CheckCircle2, Clock, HelpCircle, Info, TriangleAlert } from 'lucide-react'
import type { Vital } from './api'

const STALE_HOURS = 48

function concerning(v: Vital): boolean {
  return (v.deviation === 'above' && v.worseWhen !== 'low') || (v.deviation === 'below' && v.worseWhen !== 'high')
}

export type Tone = 'ok' | 'warn' | 'neutral'

/** Status words + icon for one or more readings (blood pressure = two). Colour is never the only signal. */
export function readingStatus(vitals: Vital[], now = Date.now()): { tone: Tone; icon: typeof Info; text: string } {
  if (vitals.some((v) => v.quality === 'Questionable')) return { tone: 'warn', icon: HelpCircle, text: 'Check this reading — it looks unusual for the device' }
  const newest = Math.max(...vitals.map((v) => Date.parse(v.measuredAt)))
  if (now - newest > STALE_HOURS * 3_600_000) return { tone: 'neutral', icon: Clock, text: 'Out of date — measure again' }
  const off = vitals.find((v) => v.deviation === 'above' || v.deviation === 'below')
  if (off) {
    const words = off.deviation === 'above' ? 'Higher than your normal' : 'Lower than your normal'
    return concerning(off)
      ? { tone: 'warn', icon: TriangleAlert, text: words }
      : { tone: 'neutral', icon: off.deviation === 'above' ? ArrowUp : ArrowDown, text: words }
  }
  if (vitals.every((v) => v.deviation === 'unknown' || v.baseline == null)) return { tone: 'neutral', icon: Info, text: 'No personal normal yet' }
  return { tone: 'ok', icon: CheckCircle2, text: 'Within your normal' }
}

