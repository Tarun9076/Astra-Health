import type { Wellness } from '../../lib/api'

/**
 * Wellness summary: one number, always shown with what it is made of and what lowered it.
 * A magnitude (single blue hue), not a status colour: it never says "normal" or "urgent".
 */
export function WellnessCard({ wellness }: { wellness: Wellness }) {
  const score = wellness.overall
  const reasons = wellness.domains.flatMap((d) => d.reasons).slice(0, 3)
  return (
    <section aria-labelledby="wellness-heading" className="rounded-xl border border-line bg-surface p-4 md:p-5">
      <h2 id="wellness-heading" className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Wellness summary</h2>
      <p className="mt-2 text-3xl font-semibold tracking-tight">
        {score ?? '—'}
        <span className="ml-1 text-base font-normal text-ink-muted">out of 100</span>
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        Based on {wellness.indicatorsSeen} of {wellness.indicatorsTotal} measurements.{' '}
        {wellness.capReason && `${wellness.capReason[0].toUpperCase()}${wellness.capReason.slice(1)}.`}
      </p>
      <ul className="mt-4 space-y-2">
        {wellness.domains.map((d) => (
          <li key={d.domain} className="text-xs">
            <div className="flex justify-between">
              <span className="text-ink">{d.domain}</span>
              <span className="font-medium text-ink">{d.score != null ? Math.round(d.score) : 'no data'}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-subtle" aria-hidden>
              {d.score != null && <div className="h-1.5 rounded-full bg-accent" style={{ width: `${d.score}%` }} />}
            </div>
          </li>
        ))}
      </ul>
      {reasons.length > 0 && (
        <p className="mt-3 border-t border-line pt-2 text-xs text-ink">
          <span className="font-medium">Lowered by:</span> {reasons.join(' · ')}
        </p>
      )}
      <details className="mt-2 text-xs text-ink-muted">
        <summary className="cursor-pointer font-medium text-accent">What is this number?</summary>
        <p className="mt-1">
          A simple summary of how far your recent readings are from your own normal, grouped by area (100 = all within
          your normal). It is calculated by fixed formulas, not by AI, and it is not a medical score. {wellness.note}
        </p>
      </details>
    </section>
  )
}
