import { Satellite, Sun } from 'lucide-react'
import { timeAgo } from '../../lib/mission'
import { useSpaceWeather } from '../../lib/queries'
import { Panel } from './Panel'

/** "Space weather now" for the Earth roles (Step 10): NOAA ≥10 MeV protons vs the S1 threshold. */
export function SpaceWeatherCard() {
  const { data } = useSpaceWeather()
  if (!data) return null
  const flux = data.protonFluxPfu
  const storm = data.sScale != null
  // log scale 0.1 … 100 000 pfu, with the S1 threshold (10 pfu) marked
  const pos = (v: number) => Math.min(100, Math.max(0, ((Math.log10(Math.max(v, 0.1)) + 1) / 6) * 100))
  return (
    <Panel title="Space weather now">
      <div className="space-y-3 text-sm">
        <p className="flex flex-wrap items-baseline gap-2">
          <Sun className={`h-5 w-5 ${storm ? 'text-status-red' : 'text-accent'}`} aria-hidden />
          <span>Solar protons ≥ 10 MeV:</span>
          <span className="font-mono text-lg">{flux != null ? flux.toFixed(2) : '—'} pfu</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${storm ? 'bg-status-red/15 text-status-red' : 'bg-status-green/15 text-status-green'}`}>
            {storm ? `Radiation storm ${data.sScale}` : 'Below S1 storm level'}
          </span>
        </p>
        {flux != null && (
          <div className="relative h-2 rounded-full bg-subtle" role="img" aria-label={`${flux.toFixed(2)} pfu; storm level S1 starts at ${data.thresholdPfu} pfu`}>
            <div className="h-full rounded-full bg-accent" style={{ width: `${pos(flux)}%` }} />
            <div className="absolute -top-1 h-4 w-0.5 bg-status-red" style={{ left: `${pos(data.thresholdPfu)}%` }} title="S1 threshold, 10 pfu" />
          </div>
        )}
        <p className="text-xs text-ink-muted">
          NOAA SWPC GOES {data.source === 'noaa-live' ? 'live' : 'cached sample (offline)'}
          {data.fluxTime && ` · ${timeAgo(data.fluxTime)}`} · S1 storm level starts at {data.thresholdPfu} pfu.
        </p>
        <p className="text-xs text-ink-muted">
          Recent NASA DONKI solar particle events: {data.recentSepEvents.length ? data.recentSepEvents.map((e) => e.id).join(', ') : 'none in the last 30 days'}.
        </p>
        {data.lightTimeMinutes != null && (
          <p className="flex items-center gap-1 text-xs text-ink-muted"><Satellite className="h-3.5 w-3.5" aria-hidden /> Earth–Mars light time today: {data.lightTimeMinutes.toFixed(1)} min (JPL Horizons)</p>
        )}
      </div>
    </Panel>
  )
}
