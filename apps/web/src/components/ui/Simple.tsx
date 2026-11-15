// Building blocks for the simplified astronaut screens (Step 14): every page starts by saying what it is
// for, shows one clear answer, and keeps the details folded away until asked for.
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Level } from '../../lib/plain'
import { LEVEL_STYLE } from './levelStyle'

/** Page title + one line saying what this page is for (in the astronaut's words). */
export function PageHeader({ title, purpose, children }: { title: string; purpose: string; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-base text-ink-muted">{purpose}</p>
      </div>
      {children}
    </header>
  )
}

/** Details on demand: folded by default, opened with a clear label. */
export function MoreDetail({ label = 'More detail', children, className = '' }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <details className={`group ${className}`}>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg text-sm font-medium text-accent hover:underline [&::-webkit-details-marker]:hidden">
        {label} <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-2 text-sm text-ink-muted">{children}</div>
    </details>
  )
}

/** The one clear answer at the top of a page: icon + headline + one or two sentences + actions. */
export function AnswerCard({ level, headline, children, actions, role }: {
  level: Level
  headline: string
  children?: ReactNode
  actions?: ReactNode
  role?: 'alert' | 'status'
}) {
  const s = LEVEL_STYLE[level]
  const Icon = s.icon
  return (
    <section role={role} className={`rounded-2xl border p-5 md:p-6 ${s.box}`}>
      <div className="flex items-start gap-4">
        <Icon className={`mt-0.5 h-8 w-8 shrink-0 ${s.text}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={`text-xl font-semibold md:text-2xl ${s.text}`}>{headline}</p>
          {children && <div className="mt-1.5 text-base leading-relaxed text-ink">{children}</div>}
          {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
    </section>
  )
}

/** A small pill with an icon and a word for a status (never colour alone). */
export function LevelPill({ level, children }: { level: Level; children?: ReactNode }) {
  const s = LEVEL_STYLE[level]
  const Icon = s.icon
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${s.box} ${s.text}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden /> {children ?? s.word}
    </span>
  )
}
