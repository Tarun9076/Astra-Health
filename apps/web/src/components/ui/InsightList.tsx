import { ScanSearch, TrendingUp } from 'lucide-react'
import type { Insight } from '../../lib/api'
import { dayOf } from '../../lib/mission'

export const INSIGHT_NOTE =
  'Pattern-finding by machine learning on your own history. It never sets alert severity — not a diagnosis.'

function sigma(v: number) {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}σ`
}

/** ML insights: unusual days (Anomaly) and rising recovery strain (Trend). Advisory, so accent colour, not status. */
export function InsightList({ insights, missionStart }: { insights: Insight[]; missionStart?: string | null }) {
  return (
    <ul className="space-y-3">
      {insights.map((i) => {
        const Icon = i.kind === 'Trend' ? TrendingUp : ScanSearch
        const when = missionStart ? `Day ${dayOf(missionStart, `${i.day}T12:00:00Z`)}` : i.day
        return (
          <li key={i.id} className="flex gap-3 rounded-lg border border-space-700 bg-space-900/50 p-3">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                {i.kind === 'Trend' ? 'Recovery strain rising' : 'Unusual day'}
                <span className="font-mono text-xs text-ink-muted">
                  {i.kind === 'Trend' ? `strain ${sigma(i.score)}` : `anomaly score ${i.score.toFixed(2)}`}
                </span>
                <span className="text-xs text-ink-muted">· {when}</span>
              </p>
              <p className="mt-1 text-sm text-ink-muted">{i.explanation}</p>
              {i.contributors.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Biggest contributors">
                  {i.contributors.map((c) => (
                    <li key={c.indicator} className="rounded-full border border-space-600 px-2 py-0.5 text-xs">
                      {c.name}{' '}
                      <span className="font-mono text-ink-muted">
                        {i.kind === 'Trend' ? `up ${Math.abs(c.value).toFixed(1)}σ` : sigma(c.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
