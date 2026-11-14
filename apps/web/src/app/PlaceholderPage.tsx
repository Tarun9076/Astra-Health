interface Props {
  num: string
  title: string
  blurb: string
}

/** Temporary page for sections that are built in later steps of the implementation plan. */
export function PlaceholderPage({ num, title, blurb }: Props) {
  return (
    <section className="max-w-3xl">
      <p className="font-mono text-sm text-accent">{num}</p>
      <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-ink-muted">{blurb}</p>
      <div className="mt-8 rounded-xl border border-dashed border-space-600 bg-space-800 p-6 text-sm text-ink-muted">
        Not built yet — see docs/04-Implementation-Plan.md for the step that delivers this section.
      </div>
    </section>
  )
}
