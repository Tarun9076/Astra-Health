import { Globe2, Orbit, Radio, Rocket, Truck, type LucideIcon } from 'lucide-react'
import type { MissionProfile } from '../../lib/api'
import { formatValue } from '../../lib/mission'
import { Panel } from '../ui/Panel'

const ICON: Record<string, LucideIcon> = {
  'Space station': Orbit,
  Spacecraft: Rocket,
  'Pressurized rover': Truck,
  'Planetary base': Globe2,
}

function gravityText(g: number): string {
  return g === 0 ? 'Weightless (microgravity)' : `${formatValue(g, 2)} g · ${Math.round(g * 100)} % of Earth’s gravity`
}

function delayText(minMinutes: number, maxMinutes: number): string {
  if (maxMinutes * 60 < 1) return 'Under a second (live voice and video)'
  if (maxMinutes < 1) return `About ${formatValue(((minMinutes + maxMinutes) / 2) * 60, 1)} seconds each way`
  return `${formatValue(minMinutes, 0)} to ${formatValue(maxMinutes, 0)} minutes each way`
}

/** Where the crew is and what that means for health: the environment changes the risks. */
export function EnvironmentCard({ profile }: { profile: MissionProfile }) {
  const Icon = ICON[profile.environment] ?? Globe2
  return (
    <Panel title="Your environment">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon className="h-6 w-6" aria-hidden />
        </span>
        <div>
          <p className="text-lg font-semibold">{profile.name}</p>
          <p className="text-sm text-ink-muted">{profile.environment} · {profile.location}</p>
        </div>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">Gravity</dt>
          <dd className="font-medium">{gravityText(profile.gravityG)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs text-ink-muted"><Radio className="h-3.5 w-3.5" aria-hidden />Delay to Earth</dt>
          <dd className="font-medium">{delayText(profile.commsDelayMinMinutes, profile.commsDelayMaxMinutes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">If someone gets seriously ill</dt>
          <dd className="font-medium">{profile.evacuation}</dd>
        </div>
      </dl>
      <h3 className="mt-5 text-sm font-semibold">What matters most for your health here</h3>
      <ul className="mt-2 grid gap-3 md:grid-cols-2">
        {profile.healthFocus.map((f) => (
          <li key={f.title} className="rounded-lg bg-canvas p-3 text-sm">
            <p className="font-medium">{f.title}</p>
            <p className="mt-0.5 text-ink-muted">{f.detail}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">
        Targets for this environment: {formatValue(profile.hydrationTargetMlPerDay / 1000, 1)} L of fluid a day,{' '}
        exercise on {profile.exerciseTargetSessionsPerWeek} days a week, radiation limit {formatValue(profile.radiationLimitMsv, 0)} mSv. {profile.disclaimer}
      </p>
    </Panel>
  )
}
