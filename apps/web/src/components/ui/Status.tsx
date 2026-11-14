import { AlertOctagon, AlertTriangle, CheckCircle2 } from 'lucide-react'

type Status = 'GREEN' | 'YELLOW' | 'RED'

const STATUS = {
  GREEN: { label: 'Normal', icon: CheckCircle2, cls: 'border-status-green/50 bg-surface text-status-green' },
  YELLOW: { label: 'Attention', icon: AlertTriangle, cls: 'border-status-yellow/40 bg-status-yellow/10 text-status-yellow' },
  RED: { label: 'Urgent', icon: AlertOctagon, cls: 'border-status-red/50 bg-status-red/15 text-status-red' },
} as const

/** Overall status: colour is never the only signal (icon + text too). */
export function StatusBadge({ status, large = false }: { status: Status; large?: boolean }) {
  const s = STATUS[status]
  const Icon = s.icon
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border font-semibold ${s.cls} ${
        large ? 'px-4 py-2 text-base' : 'px-2.5 py-0.5 text-xs'
      }`}
    >
      <Icon className={large ? 'h-5 w-5' : 'h-3.5 w-3.5'} aria-hidden />
      {s.label}
    </span>
  )
}

export function SeverityBadge({ severity }: { severity: 'Attention' | 'Urgent' }) {
  return <StatusBadge status={severity === 'Urgent' ? 'RED' : 'YELLOW'} />
}

export function AlertStatusChip({ status }: { status: string }) {
  const label = status === 'InReview' ? 'In review' : status
  const tone =
    status === 'Open'
      ? 'border-accent/40 text-accent'
      : status === 'Resolved' || status === 'Dismissed'
        ? 'border-line-strong text-ink-muted'
        : 'border-ink-muted/40 text-ink'
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>
}
