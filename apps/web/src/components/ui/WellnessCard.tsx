import type { Wellness } from '../../lib/api'

const RING = { size: 112, stroke: 10, colour: '#3987e5', track: '#1c2742' }

/** Wellness index ring + per-domain bars. A magnitude (single hue), not a status colour. */
export function WellnessCard({ wellness }: { wellness: Wellness }) {
  const r = (RING.size - RING.stroke) / 2
  const circumference = 2 * Math.PI * r
  const score = wellness.overall
  return (
    <section className="rounded-xl border border-space-700 bg-space-800 p-5">
      <div className="flex flex-wrap items-center gap-5">
        <svg width={RING.size} height={RING.size} viewBox={`0 0 ${RING.size} ${RING.size}`} role="img"
          aria-label={score == null ? 'Wellness index unavailable' : `Wellness index ${score} out of 100`}>
          <circle cx={RING.size / 2} cy={RING.size / 2} r={r} fill="none" stroke={RING.track} strokeWidth={RING.stroke} />
          {score != null && (
            <circle cx={RING.size / 2} cy={RING.size / 2} r={r} fill="none" stroke={RING.colour} strokeWidth={RING.stroke}
              strokeLinecap="round" strokeDasharray={`${(score / 100) * circumference} ${circumference}`}
              transform={`rotate(-90 ${RING.size / 2} ${RING.size / 2})`} />
          )}
          <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle" className="fill-ink font-mono text-3xl font-semibold">
            {score ?? '—'}
          </text>
          <text x="50%" y="70%" textAnchor="middle" className="fill-ink-muted text-[10px]">/ 100</text>
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-wider text-ink-muted uppercase">Wellness index</p>
          <p className="mt-1 text-xs text-ink-muted">
            Based on {wellness.indicatorsSeen} of {wellness.indicatorsTotal} indicators.{' '}
            {wellness.capReason && `${wellness.capReason[0].toUpperCase()}${wellness.capReason.slice(1)}.`}
          </p>
          <ul className="mt-3 space-y-1.5">
            {wellness.domains.map((d) => (
              <li key={d.domain} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-2 text-xs" title={d.reasons.join(' · ') || undefined}>
                <span className="text-ink-muted">{d.domain}</span>
                <span className="h-1.5 rounded-full bg-space-700">
                  {d.score != null && <span className="block h-1.5 rounded-full" style={{ width: `${d.score}%`, background: RING.colour }} />}
                </span>
                <span className="text-right font-mono text-ink">{d.score != null ? Math.round(d.score) : '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {wellness.domains.some((d) => d.reasons.length) && (
        <p className="mt-3 border-t border-space-700 pt-2 text-xs text-ink-muted">
          Lowered by: {wellness.domains.flatMap((d) => d.reasons).slice(0, 3).join(' · ')}
        </p>
      )}
      <p className="mt-2 text-[11px] text-ink-muted">{wellness.note}</p>
    </section>
  )
}
