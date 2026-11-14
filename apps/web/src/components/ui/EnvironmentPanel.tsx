import { Radiation, Satellite, ThermometerSun } from 'lucide-react'
import { formatValue, timeAgo } from '../../lib/mission'
import { useEnvironment, useRadiation } from '../../lib/queries'
import { EmergencyProtocolCard } from './EmergencyProtocolCard'
import { ErrorNote, Loading, Panel } from './Panel'

/** Habitat environment (cabin air) and the astronaut's radiation dose (Step 10). */
export function EnvironmentPanel({ code }: { code: string }) {
  const env = useEnvironment()
  const rad = useRadiation(code)
  const r = rad.data
  const maxDay = Math.max(0.001, ...(r?.days.map((d) => d.total) ?? [0]))
  return (
    <div className="space-y-4">
      {r?.activeSepAlert && (
        <div className="space-y-2">
          <p className="rounded-lg bg-status-red/15 px-3 py-2 text-sm font-semibold text-status-red" role="alert">
            Solar particle event: go to the radiation shelter now.
          </p>
          <EmergencyProtocolCard id={r.activeSepAlert.protocol as string ?? 'EMG-RADIATION-SHELTER'} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Cabin air (habitat sensors)">
          {env.isPending && <Loading />}
          {env.error && <ErrorNote error={env.error} />}
          <ul className="grid gap-3 sm:grid-cols-3">
            {env.data?.map((c) => (
              <li key={c.indicator} className="rounded-lg border border-line p-3">
                <p className="flex items-center gap-1 text-xs text-ink-muted"><ThermometerSun className="h-3.5 w-3.5" aria-hidden /> {c.name}</p>
                <p className={`font-mono text-xl ${c.status === 'out_of_range' ? 'text-status-yellow' : ''}`}>
                  {c.value != null ? formatValue(c.value, c.unit === 'mmHg' ? 2 : c.unit === '%' ? 0 : 1) : '—'}
                  <span className="text-sm text-ink-muted"> {c.unit}</span>
                </p>
                <p className="text-xs text-ink-muted">
                  {c.status === 'no_data' ? 'no data' : c.status === 'out_of_range' ? `outside ${c.low}–${c.high}` : `normal ${c.low}–${c.high}`}
                  {c.measuredAt && ` · ${timeAgo(c.measuredAt)}`}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-ink-muted">Illustrative ranges; shared by the whole crew.</p>
        </Panel>

        <Panel title="Radiation dose">
          {rad.isPending && <Loading />}
          {rad.error && <ErrorNote error={rad.error} />}
          {r && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="flex items-center justify-between"><span className="flex items-center gap-1"><Radiation className="h-4 w-4 text-accent" aria-hidden /> Mission total</span>
                  <span className="font-mono">{r.missionTotalMsv.toFixed(1)} / {r.limitMsv ?? '—'} mSv</span></p>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-subtle" role="meter" aria-valuenow={r.pctOfLimit ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the mission dose limit">
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, r.pctOfLimit ?? 0)}%` }} />
                </div>
                <p className="mt-1 text-xs text-ink-muted">{r.pctOfLimit?.toFixed(0)} % of the mission limit{r.neutronShare != null && ` · neutrons ${(r.neutronShare * 100).toFixed(0)} % of the dose`}</p>
              </div>
              <div>
                <p className="mb-1 text-xs text-ink-muted">Daily dose, last 30 days (<span className="text-accent">■</span> charged particles, <span className="text-ink">■</span> neutrons)</p>
                <svg viewBox={`0 0 ${Math.max(r.days.length, 1) * 6} 40`} className="h-16 w-full" preserveAspectRatio="none" aria-label="Daily radiation dose">
                  {r.days.map((d, i) => {
                    const total = (d.total / maxDay) * 38
                    const neutron = (d.neutron / maxDay) * 38
                    return (
                      <g key={d.day}>
                        <title>{d.day}: {d.total.toFixed(3)} mSv ({d.neutron.toFixed(3)} neutron)</title>
                        <rect x={i * 6} y={40 - total} width={4.5} height={total - neutron} fill="#38bdf8" />
                        <rect x={i * 6} y={40 - neutron} width={4.5} height={neutron} fill="#e6ecff" />
                      </g>
                    )
                  })}
                </svg>
              </div>
              <ul className="space-y-1 text-xs text-ink-muted">
                <li>{r.replayedStorm} — replayed on mission day 87 of the simulation.</li>
                {r.spaceWeatherEvents.slice(0, 2).map((e) => <li key={e.id}>NASA DONKI event {e.id} ({e.source}).</li>)}
                {r.lightTimeMinutes != null && (
                  <li className="flex items-center gap-1"><Satellite className="h-3.5 w-3.5" aria-hidden /> Earth–Mars light time today: {r.lightTimeMinutes.toFixed(1)} min (JPL Horizons)</li>
                )}
              </ul>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
