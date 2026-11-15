import { Award, CheckCircle2, Flame, Info, Lock } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Badge, Progress } from '../../lib/api'
import { Panel } from '../ui/Panel'

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((100 * value) / max)) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-subtle" role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  )
}

/** "3 of 5 days", or "6 days · goal met" once the goal is reached (never "6 of 5"). */
const goalText = (g: Progress['weekly'][number]) =>
  g.done >= g.target ? `${g.done} day${g.done === 1 ? '' : 's'} · goal met` : `${g.done} of ${g.target} days`

const FAIR_PLAY = 'Points reward what you do, never your readings: a worrying value never costs points, so always record it as it is.'

function LevelLine({ p }: { p: Progress }) {
  const next = p.level.nextPoints
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold">Level {p.level.number} · {p.level.title}</p>
        <p className="text-sm"><span className="text-xl font-semibold text-accent">{p.points}</span> points</p>
      </div>
      {next != null ? (
        <>
          <div className="mt-2"><Bar value={p.points - p.level.minPoints} max={next - p.level.minPoints} label="Progress to the next level" /></div>
          <p className="mt-1 text-xs text-ink-muted">{next - p.points} points to level {p.level.number + 1}{p.pointsToday > 0 && ` · +${p.pointsToday} today`}</p>
        </>
      ) : <p className="mt-1 text-xs text-ink-muted">Top level reached{p.pointsToday > 0 && ` · +${p.pointsToday} today`}</p>}
    </div>
  )
}

/** Compact progress for Home: level, check-in streak and this week's goals. */
export function ProgressSummary({ progress: p }: { progress: Progress }) {
  const checkin = p.streaks.find((s) => s.id === 'checkin')
  const earned = p.badges.filter((b) => b.earned).length
  return (
    <Panel title="My progress" action={<Link to="/astronaut/wellness#progress" className="text-sm font-medium text-accent hover:underline">Badges</Link>}>
      <LevelLine p={p} />
      {checkin && (
        <p className="mt-3 flex items-center gap-2 text-sm">
          <Flame className={`h-5 w-5 shrink-0 ${checkin.current > 0 ? 'text-accent' : 'text-ink-muted'}`} aria-hidden />
          {checkin.current > 0
            ? <span><span className="font-semibold">{checkin.current} day{checkin.current === 1 ? '' : 's'}</span> of check-ins in a row{!checkin.doneToday && ' — check in today to keep it going'}</span>
            : <span>Send today’s check-in to start a streak</span>}
        </p>
      )}
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">This week (last 7 days)</h3>
      <ul className="mt-2 space-y-2">
        {p.weekly.map((g) => (
          <li key={g.id} className="text-sm">
            <div className="flex justify-between gap-2">
              <span>{g.label}</span>
              <span className={g.done >= g.target ? 'font-semibold' : 'text-ink-muted'}>
                {g.done >= g.target && <CheckCircle2 className="mr-1 inline h-4 w-4 text-status-green" aria-hidden />}
                {goalText(g)}
              </span>
            </div>
            <div className="mt-1"><Bar value={g.done} max={g.target} label={`${g.label}: ${g.done} of ${g.target} days`} /></div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">{earned} of {p.badges.length} badges earned. {FAIR_PLAY}</p>
    </Panel>
  )
}

function BadgeTile({ b }: { b: Badge }) {
  return (
    <li className={`flex gap-3 rounded-lg border p-3 ${b.earned ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface'}`}>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${b.earned ? 'bg-accent text-on-accent' : 'bg-subtle text-ink-muted'}`}>
        {b.earned ? <Award className="h-5 w-5" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{b.title}<span className="sr-only">{b.earned ? ', earned' : ', not earned yet'}</span></p>
        <p className="text-sm text-ink-muted">{b.description}</p>
        {b.earned ? (
          b.earnedOn && <p className="mt-1 text-xs text-ink-muted">Earned on {new Date(`${b.earnedOn}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</p>
        ) : (
          <div className="mt-2">
            <Bar value={b.progress} max={b.target} label={`${b.title}: ${b.progress} of ${b.target}`} />
            <p className="mt-1 text-xs text-ink-muted">{b.progress} of {b.target}</p>
          </div>
        )}
      </div>
    </li>
  )
}

/** Full progress view (Wellness): level, streaks, weekly goals, badges and how points work. */
export function ProgressDetails({ progress: p }: { progress: Progress }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      <Panel title="Level and points">
        <LevelLine p={p} />
        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-ink-muted">How you earn points</h3>
        <table className="mt-1 w-full text-sm">
          <caption className="sr-only">Points for each action</caption>
          <tbody>
            {p.howPointsWork.map((r) => (
              <tr key={r.action} className="border-b border-line last:border-0">
                <td className="py-1.5 pr-2">{r.action}</td>
                <td className="py-1.5 text-right font-semibold">+{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 flex items-start gap-2 text-xs text-ink-muted"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{FAIR_PLAY}</p>
      </Panel>
      <Panel title="Streaks">
        <ul className="space-y-3">
          {p.streaks.map((s) => (
            <li key={s.id} className="flex items-center gap-3">
              <Flame className={`h-6 w-6 shrink-0 ${s.current > 0 ? 'text-accent' : 'text-ink-muted'}`} aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{s.label}</p>
                <p className="text-ink-muted">Best: {s.best} day{s.best === 1 ? '' : 's'}{s.doneToday ? ' · done today' : ''}</p>
              </div>
              <p className="text-right"><span className="text-2xl font-semibold">{s.current}</span><span className="block text-xs text-ink-muted">in a row</span></p>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="This week (last 7 days)">
        <ul className="space-y-3">
          {p.weekly.map((g) => (
            <li key={g.id} className="text-sm">
              <div className="flex justify-between gap-2">
                <span>{g.label}</span>
                <span className={g.done >= g.target ? 'font-semibold' : 'text-ink-muted'}>{goalText(g)}</span>
              </div>
              <div className="mt-1"><Bar value={g.done} max={g.target} label={`${g.label}: ${g.done} of ${g.target} days`} /></div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title={`Badges · ${p.badges.filter((b) => b.earned).length} of ${p.badges.length} earned`} className="md:col-span-2 2xl:col-span-3">
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {p.badges.map((b) => <BadgeTile key={b.id} b={b} />)}
        </ul>
      </Panel>
    </div>
  )
}
