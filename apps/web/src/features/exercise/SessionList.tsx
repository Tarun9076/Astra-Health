import { Clapperboard } from 'lucide-react'
import { ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import type { ExerciseSession } from '../../lib/api'
import { useExerciseSessions } from '../../lib/queries'

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Coached sessions, newest first: results only (no video is ever stored). */
export function SessionList({ sessions, empty }: { sessions: ExerciseSession[]; empty: string }) {
  if (!sessions.length) return <p className="text-sm text-ink-muted">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {sessions.map((s) => (
        <li key={s.id} className="py-3 text-sm">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{when(s.finishedAt)}</span>
            <span>{s.totalReps} reps</span>
            {s.formScore != null && <span>Form {s.formScore}%</span>}
            {s.source === 'demo' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs text-ink-muted">
                <Clapperboard className="h-3 w-3" aria-hidden /> Demo playback (simulated)
              </span>
            )}
          </p>
          <p className="mt-0.5 text-ink-muted">{s.summary}</p>
        </li>
      ))}
    </ul>
  )
}

/** Flight surgeon view (Staff → astronaut → Exercise). */
export function ExerciseSessionsPanel({ code }: { code: string }) {
  const { data, error, isPending } = useExerciseSessions(code)
  return (
    <Panel title="Coached exercise sessions">
      <p className="mb-3 text-sm text-ink-muted">Sessions done with the camera exercise coach onboard: reps, sets, form score and the posture tips given. Video never leaves the spacecraft.</p>
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && <SessionList sessions={data} empty="No coached sessions have arrived yet." />}
    </Panel>
  )
}
