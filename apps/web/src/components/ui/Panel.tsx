import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

export function Panel({ title, action, children, className = '' }: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-xl border border-space-700 bg-space-800 p-4 md:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}
    </p>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong'
  return (
    <p className="rounded-lg border border-status-red/40 bg-status-red/10 px-3 py-2 text-sm text-status-red" role="alert">
      {message}
    </p>
  )
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-accent text-space-950 hover:bg-accent/90 disabled:bg-space-600 disabled:text-ink-muted',
    ghost: 'border border-space-600 text-ink hover:bg-space-700 disabled:text-ink-muted',
    danger: 'bg-status-red text-white hover:bg-status-red/90',
  }[variant]
  return (
    <button
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

/** Renders the small Markdown subset used in protocols/emergency/*.md: numbered steps, paragraphs, **bold**. */
export function ProtocolSteps({ markdown }: { markdown: string }) {
  const bold = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
    )
  const lines = markdown.split('\n').map((l) => l.trim()).filter(Boolean)
  const steps = lines.filter((l) => /^\d+\.\s/.test(l))
  const intro = lines.filter((l) => !/^\d+\.\s/.test(l))
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {intro.map((l, i) => <p key={i}>{bold(l)}</p>)}
      <ol className="list-decimal space-y-1.5 pl-5">
        {steps.map((l, i) => <li key={i}>{bold(l.replace(/^\d+\.\s/, ''))}</li>)}
      </ol>
    </div>
  )
}
