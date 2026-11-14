// Mission time. Mission day 1 = mission start date (UTC). A Mars sol is 24 h 39 min 35.244 s.
const DAY_MS = 86_400_000
const SOL_MS = 88_775_244

function startMs(missionStart: string): number {
  return Date.parse(`${missionStart}T00:00:00Z`)
}

export function missionDay(missionStart: string, at: Date = new Date()): number {
  return Math.floor((at.getTime() - startMs(missionStart)) / DAY_MS) + 1
}

export function missionSol(missionStart: string, at: Date = new Date()): number {
  return Math.floor((at.getTime() - startMs(missionStart)) / SOL_MS) + 1
}

export function dayOf(missionStart: string, iso: string): number {
  return missionDay(missionStart, new Date(iso))
}

export function timeAgo(iso: string, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

export function formatValue(value: number, decimals = 1): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
}
