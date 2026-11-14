import type { BodyRegion } from '../../lib/queries'

export type RegionStatus = BodyRegion['status']

// Status colours are the app's status tokens (never used for anything but status); GREY = no data.
export const STATUS_FILL: Record<RegionStatus, string> = {
  GREEN: '#22c55e',
  YELLOW: '#f59e0b',
  RED: '#ef4444',
  GREY: '#64748b',
}

export const STATUS_LABEL: Record<RegionStatus, string> = {
  GREEN: 'Within your normal',
  YELLOW: 'Needs attention',
  RED: 'Urgent',
  GREY: 'No data yet',
}

export function statusOf(regions: BodyRegion[] | undefined, id: string): RegionStatus {
  return regions?.find((r) => r.id === id)?.status ?? 'GREY'
}
