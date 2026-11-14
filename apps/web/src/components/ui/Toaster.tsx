import { AlertOctagon, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useToasts, type ToastTone } from '../../lib/toasts'

const TONE: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: 'border-accent/40' },
  success: { icon: CheckCircle2, cls: 'border-status-green/50' },
  attention: { icon: AlertTriangle, cls: 'border-status-yellow/60' },
  urgent: { icon: AlertOctagon, cls: 'border-status-red/70 bg-status-red/15' },
}

export function Toaster() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="pointer-events-none fixed right-4 bottom-12 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const { icon: Icon, cls } = TONE[t.tone]
        const body = (
          <>
            <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t.title}</p>
              {t.body && <p className="mt-0.5 text-xs text-ink-muted">{t.body}</p>}
            </div>
          </>
        )
        return (
          <div key={t.id} className={`pointer-events-auto flex items-start gap-3 rounded-xl border bg-space-800 p-3 shadow-lg ${cls}`}>
            {t.href ? (
              <Link to={t.href} className="flex flex-1 items-start gap-3" onClick={() => dismiss(t.id)}>
                {body}
              </Link>
            ) : (
              body
            )}
            <button onClick={() => dismiss(t.id)} className="text-ink-muted hover:text-ink" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
