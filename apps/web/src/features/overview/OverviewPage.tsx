import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, CheckSquare, ChevronRight, ClipboardCheck, Square } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { SeverityBadge, StatusBadge } from '../../components/ui/Status'
import { VitalCard } from '../../components/ui/VitalCard'
import { api, unwrap, type Dashboard, type Task } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { dayOf, timeAgo } from '../../lib/mission'
import { useDashboard } from '../../lib/queries'

/** Overview for one astronaut. `readOnly` = a flight surgeon viewing someone else. */
export function OverviewPage({ code, readOnly = false }: { code?: string; readOnly?: boolean }) {
  const user = useAuth((s) => s.user)
  const astronautCode = code ?? user?.astronautCode
  const { data, error, isPending } = useDashboard(astronautCode)

  if (isPending) return <Loading />
  if (error) return <ErrorNote error={error} />
  const start = user?.missionStart
  const urgent = data.activeAlerts.filter((a) => a.severity === 'Urgent')

  return (
    <div className="max-w-6xl space-y-6">
      <StatusHeader data={data} readOnly={readOnly} />

      {urgent.length > 0 && (
        <section className="rounded-xl border-2 border-status-red bg-status-red/10 p-4" role="alert">
          <p className="flex items-center gap-2 font-semibold text-status-red">
            <AlertOctagon className="h-5 w-5" aria-hidden /> Urgent: follow the emergency protocol now
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {urgent.map((a) => (
              <li key={a.id}>
                <Link to={readOnly ? '#' : `/astronaut/alerts?id=${a.id}`} className="underline">
                  {a.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold tracking-wider text-ink-muted uppercase">Vitals vs your normal</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {data.vitals.map((v) => (
            <VitalCard key={v.indicator} vital={v} />
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={`Active alerts (${data.activeAlerts.length})`}>
          {data.activeAlerts.length === 0 ? (
            <p className="text-sm text-ink-muted">No active alerts.</p>
          ) : (
            <ul className="divide-y divide-space-700">
              {data.activeAlerts.map((a) => (
                <li key={a.id}>
                  <Link
                    to={readOnly ? '#' : `/astronaut/alerts?id=${a.id}`}
                    className="flex items-start gap-3 py-3 hover:bg-space-700/40"
                  >
                    <SeverityBadge severity={a.severity} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{a.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-sm text-ink-muted">{a.reason}</p>
                      <p className="mt-1 text-xs text-ink-muted">
                        {start ? `Since day ${dayOf(start, a.firstTriggeredAt)}` : timeAgo(a.firstTriggeredAt)} ·
                        seen {a.triggerCount}× {a.escalationRequired && '· flagged for the flight surgeon'}
                      </p>
                    </div>
                    {!readOnly && <ChevronRight className="mt-1 h-4 w-4 text-ink-muted" aria-hidden />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <TaskList tasks={data.tasks} code={data.astronautCode} readOnly={readOnly} />
      </div>
    </div>
  )
}

function StatusHeader({ data, readOnly }: { data: Dashboard; readOnly: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-space-700 bg-space-800 p-5">
      <div>
        <p className="text-sm text-ink-muted">
          {data.displayName} · {data.astronautCode}
          {data.missionDay != null && ` · mission day ${data.missionDay}`}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <StatusBadge status={data.status} large />
          <span className="text-sm">{data.statusReason}</span>
        </div>
        {data.lastReadingAt && <p className="mt-2 text-xs text-ink-muted">Last reading {timeAgo(data.lastReadingAt)}</p>}
      </div>
      {!readOnly && (
        <Link to="/astronaut/checkin">
          <Button>
            <ClipboardCheck className="h-4 w-4" aria-hidden /> Start daily check-in
          </Button>
        </Link>
      )}
    </div>
  )
}

function TaskList({ tasks, code, readOnly }: { tasks: Task[]; code: string; readOnly: boolean }) {
  const queryClient = useQueryClient()
  const complete = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/api/tasks/{task_id}/complete', { params: { path: { task_id: id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard', code] }),
  })
  return (
    <Panel title={`Today's tasks (${tasks.length})`}>
      {tasks.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing to do right now.</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                disabled={readOnly || complete.isPending}
                onClick={() => complete.mutate(t.id)}
                className="flex min-h-12 w-full items-start gap-3 rounded-lg p-2 text-left hover:bg-space-700/40 disabled:hover:bg-transparent"
                title={readOnly ? undefined : 'Mark as done'}
              >
                {t.status === 'Done' ? (
                  <CheckSquare className="mt-0.5 h-5 w-5 shrink-0 text-status-green" aria-hidden />
                ) : (
                  <Square className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t.title}</span>
                  <span className="block text-xs text-ink-muted">{t.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {complete.isError && <ErrorNote error={complete.error} />}
    </Panel>
  )
}
