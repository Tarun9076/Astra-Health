// Plain words for readings (Step 14). The astronaut screens use these instead of numbers against a
// statistical range: "a bit high", "much lower than usual", never "+2.7σ". The detailed numbers stay
// one tap away ("More detail") and on the flight surgeon's screens.
import type { Dashboard, Vital } from './api'

export type Level = 'ok' | 'care' | 'help'
export type TileTone = 'ok' | 'care' | 'none'

const STALE_MS = 48 * 3_600_000

/** Is a reading off in the direction that matters (e.g. low sleep, high heart rate)? */
export function concerning(v: Vital): boolean {
  return (v.deviation === 'above' && v.worseWhen !== 'low') || (v.deviation === 'below' && v.worseWhen !== 'high')
}

/** One or two words for a reading: "Normal", "A bit high", "Very low", "Measure again"… */
export function wordFor(vitals: Vital[], now = Date.now()): { word: string; tone: TileTone } {
  if (vitals.length === 0) return { word: 'No reading yet', tone: 'none' }
  if (vitals.some((v) => v.quality === 'Questionable')) return { word: 'Check again', tone: 'care' }
  if (now - Math.max(...vitals.map((v) => Date.parse(v.measuredAt))) > STALE_MS) return { word: 'Measure again', tone: 'none' }
  const off = vitals.filter(concerning).sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0))[0]
  if (off) {
    const strong = Math.abs(off.z ?? 0) >= 3
    const high = off.deviation === 'above'
    return { word: `${strong ? 'Very' : 'A bit'} ${high ? 'high' : 'low'}`, tone: 'care' }
  }
  return { word: 'Normal', tone: 'ok' }
}

/** What a concerning reading means, in a few words, to build the one-sentence summary. */
const PHRASE: Record<string, { high: string; low: string }> = {
  resting_hr: { high: 'your heart is working harder at rest', low: 'your resting heart rate is lower than usual' },
  heart_rate: { high: 'your heart rate is higher than usual', low: 'your heart rate is lower than usual' },
  bp_sys: { high: 'your blood pressure is higher than usual', low: 'your blood pressure is lower than usual' },
  bp_dia: { high: 'your blood pressure is higher than usual', low: 'your blood pressure is lower than usual' },
  sleep_hours: { high: 'you slept longer than usual', low: 'you have slept less than you need' },
  sleep_quality: { high: 'you slept better than usual', low: 'your sleep was poor' },
  fatigue: { high: 'you feel more tired than usual', low: 'you feel less tired than usual' },
  mood: { high: 'your mood is better than usual', low: 'your mood is lower than usual' },
  stress: { high: 'you feel more stressed than usual', low: 'you feel less stressed than usual' },
  glucose: { high: 'your blood sugar is higher than usual', low: 'your blood sugar is lower than usual' },
  body_temp: { high: 'your temperature is raised', low: 'your temperature is lower than usual' },
  spo2: { high: 'your oxygen level is higher than usual', low: 'your oxygen level is lower than usual' },
  activity_min: { high: 'you were more active than usual', low: 'you moved less than usual' },
  exercise_sessions: { high: 'you exercised more than planned', low: 'you are behind on your exercise' },
  hydration_ml: { high: 'you drank more than usual', low: 'you drank less than you need' },
  body_weight: { high: 'your weight has gone up', low: 'your weight has gone down' },
}

const HABITS = new Set(['activity_min', 'exercise_sessions', 'hydration_ml', 'body_weight'])

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The one-line answer to "how am I?": a level, a short headline and one or two sentences. */
export function summarise(d: Dashboard, now = Date.now()): { level: Level; headline: string; sentence: string } {
  const urgent = d.activeAlerts.filter((a) => a.severity === 'Urgent')
  if (urgent.length > 0) {
    return {
      level: 'help',
      headline: 'Get help now',
      sentence: `${urgent[0].title}. Follow the emergency steps and call the crew medical officer.`,
    }
  }
  const fresh = d.vitals.filter((v) => v.quality !== 'Questionable' && now - Date.parse(v.measuredAt) <= STALE_MS)
  // body signals first (heart, sleep, tiredness…), then habits (activity, water, weight), each by size
  const habit = (v: Vital) => (HABITS.has(v.indicator) ? 1 : 0)
  const phrases = [...new Set(fresh.filter(concerning).sort((a, b) => habit(a) - habit(b) || Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0))
    .map((v) => PHRASE[v.indicator]?.[v.deviation === 'above' ? 'high' : 'low']).filter(Boolean) as string[])]
  if (d.activeAlerts.length > 0 || phrases.length > 0) {
    const what = phrases.length ? `${capital(joinWords(phrases.slice(0, 2)))}.` : `${d.activeAlerts[0].title}.`
    return { level: 'care', headline: 'Take it easy today', sentence: `${what} Small steps today help you recover.` }
  }
  return { level: 'ok', headline: 'You are doing well', sentence: 'Your latest readings are all within your normal. Keep up your daily habits.' }
}
