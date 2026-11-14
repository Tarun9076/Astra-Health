import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FilePlus2, Printer } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { api, unwrap, type Report, type ReportItem } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { formatValue, timeAgo } from '../../lib/mission'
import { useReport, useReports } from '../../lib/queries'

const TYPE_LABEL: Record<ReportItem['type'], string> = {
  Daily: 'Daily',
  Weekly: 'Weekly',
  AlertTriggered: 'Alert',
  OnDemand: 'On demand',
}
const TX_STYLE: Record<ReportItem['transmissionStatus'], string> = {
  Queued: 'border-status-yellow/60 text-status-yellow',
  Sent: 'border-accent/60 text-accent',
  Delivered: 'border-status-green/60 text-status-green',
}

function TxChip({ status }: { status: ReportItem['transmissionStatus'] }) {
  const label = status === 'Queued' ? 'Queued for Earth' : status
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${TX_STYLE[status]}`}>{label}</span>
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

/** Reports for one astronaut: the astronaut's own page (07) or the surgeon's Reports tab. */
export function ReportsPage({ code: forCode, embedded = false }: { code?: string; embedded?: boolean } = {}) {
  const user = useAuth((s) => s.user)
  const code = forCode ?? user?.astronautCode
  const [params, setParams] = useSearchParams()
  const selected = params.get('report')
  const reports = useReports(code)
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: () => {
      const end = new Date()
      const start = new Date(end.getTime() - 6 * 86_400_000)
      return unwrap(
        api.POST('/api/astronauts/{astronaut}/reports', {
          params: { path: { astronaut: code! } },
          body: { start: isoDate(start), end: isoDate(end) },
        }),
      )
    },
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['reports', code] })
      select(r.id)
    },
  })
  const select = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('report', id)
    setParams(next, { replace: true })
  }
  const current = selected ?? reports.data?.[0]?.id ?? null

  return (
    <div className="max-w-6xl space-y-4">
      {!embedded && (
        <div className="no-print">
          <p className="font-mono text-sm text-accent">07</p>
          <h1 className="text-2xl font-semibold">Medical Reports</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Summaries of your health data for the flight surgeon: daily, weekly, after urgent alerts, or on request.
            They are queued and sent to Earth on the next link window.
          </p>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <Panel title="Reports" className="no-print" action={
          <Button variant="ghost" onClick={() => create.mutate()} disabled={create.isPending || !code}>
            <FilePlus2 className="h-4 w-4" aria-hidden /> {create.isPending ? 'Writing…' : 'New (last 7 days)'}
          </Button>
        }>
          {reports.isPending && <Loading />}
          {reports.error && <ErrorNote error={reports.error} />}
          {create.isError && <ErrorNote error={create.error} />}
          {reports.data?.length === 0 && <p className="text-sm text-ink-muted">No reports yet.</p>}
          <ul className="max-h-[65vh] space-y-1 overflow-y-auto">
            {reports.data?.map((r) => (
              <li key={r.id}>
                <button onClick={() => select(r.id)} aria-current={current === r.id}
                  className={`w-full rounded-lg p-2 text-left ${current === r.id ? 'bg-subtle' : 'hover:bg-subtle/50'}`}>
                  <span className="flex items-center justify-between gap-2 text-sm font-medium">
                    {TYPE_LABEL[r.type]} · {r.periodStart === r.periodEnd ? r.periodStart : `${r.periodStart} → ${r.periodEnd}`}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-ink-muted">
                    <TxChip status={r.transmissionStatus} /> {timeAgo(r.generatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <div className="min-w-0">{current && <ReportDetail id={current} />}</div>
      </div>
    </div>
  )
}

function ReportDetail({ id }: { id: string }) {
  const { data, error, isPending } = useReport(id)
  if (isPending) return <Loading />
  if (error) return <ErrorNote error={error} />
  return <ReportView report={data} />
}

export function ReportView({ report }: { report: Report }) {
  const s = report.summary as unknown as Summary
  return (
    <Panel>
      <article className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs tracking-wider text-ink-muted uppercase">ASTRA HEALTH · {TYPE_LABEL[report.type]} report</p>
            <h2 className="text-xl font-semibold">{s.displayName} · {s.astronautCode}</h2>
            <p className="text-sm text-ink-muted">
              {s.missionDays ? `Mission days ${s.missionDays[0]}–${s.missionDays[1]} · ` : ''}{s.periodStart} → {s.periodEnd} ·
              generated {new Date(report.generatedAt).toLocaleString()}
            </p>
          </div>
          <div className="no-print flex items-center gap-2">
            <TxChip status={report.transmissionStatus} />
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer className="h-4 w-4" aria-hidden /> Print / PDF
            </Button>
          </div>
        </header>

        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wider text-ink-muted uppercase">
            Summary <span className="font-normal normal-case">({report.narrativeProvider === 'claude' ? 'written by Claude from the data below' : 'generated from the data below'})</span>
          </h3>
          <p className="text-sm leading-relaxed">{report.narrative}</p>
        </section>

        <section className="overflow-x-auto">
          <h3 className="mb-1 text-xs font-semibold tracking-wider text-ink-muted uppercase">Readings vs personal normal</h3>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-muted">
              <tr><th className="py-1 pr-3 font-medium">Indicator</th><th className="py-1 pr-3 font-medium">Average (min–max)</th>
                <th className="py-1 pr-3 font-medium">Latest</th><th className="py-1 pr-3 font-medium">Normal</th><th className="py-1 font-medium">Difference</th></tr>
            </thead>
            <tbody className="font-mono">
              {s.indicators.map((i) => (
                <tr key={i.indicator} className="border-t border-line">
                  <td className="py-1 pr-3 font-sans">{i.name} <span className="text-ink-muted">({i.n})</span></td>
                  <td className="py-1 pr-3">{num(i.mean)} <span className="text-ink-muted">({num(i.min)}–{num(i.max)})</span> {unit(i.unit)}</td>
                  <td className="py-1 pr-3">{num(i.latest)}</td>
                  <td className="py-1 pr-3">{i.baseline != null ? `${num(i.baseline)} ± ${num(i.sigma)}` : '—'}</td>
                  <td className={`py-1 ${i.flag === 'above' || i.flag === 'below' ? 'font-semibold' : ''}`}>
                    {i.zMean != null ? `${i.zMean > 0 ? '+' : ''}${i.zMean.toFixed(1)}σ` : '—'}
                    {i.flag === 'above' ? ' ▲' : i.flag === 'below' ? ' ▼' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wider text-ink-muted uppercase">Alerts ({s.alerts.length})</h3>
          {s.alerts.length === 0 ? <p className="text-sm text-ink-muted">None in this period.</p> : (
            <ul className="space-y-1 text-sm">
              {s.alerts.map((a) => (
                <li key={a.id}><span className="font-medium">{a.severity}</span> · {a.title} · {a.status} · {a.firstDay} → {a.lastDay}
                  {a.resolutionNote && <span className="text-ink-muted"> — {a.resolutionNote}</span>}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-4 text-sm sm:grid-cols-3">
          <div><h3 className="text-xs font-semibold tracking-wider text-ink-muted uppercase">Wellness index</h3>
            <p>avg {s.wellness.mean ?? '—'} · min {s.wellness.min ?? '—'} · latest {s.wellness.latest ?? '—'}</p></div>
          <div><h3 className="text-xs font-semibold tracking-wider text-ink-muted uppercase">Adherence</h3>
            <p>check-ins {s.adherence.checkins}/{s.adherence.days} · tasks done {s.adherence.tasksDone}, pending {s.adherence.tasksPending}</p></div>
          <div><h3 className="text-xs font-semibold tracking-wider text-ink-muted uppercase">Radiation</h3>
            <p>{s.radiation.periodMsv.toFixed(2)} mSv in period · mission {s.radiation.missionMsv.toFixed(1)} mSv{s.radiation.pctOfLimit != null && ` (${s.radiation.pctOfLimit.toFixed(0)} % of limit)`}</p></div>
        </section>

        {s.insights.length > 0 && (
          <section>
            <h3 className="mb-1 text-xs font-semibold tracking-wider text-ink-muted uppercase">AI insights (advisory)</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm">{s.insights.slice(-4).map((i, n) => <li key={n}>{i.day}: {i.explanation}</li>)}</ul>
          </section>
        )}
        <p className="text-[11px] text-ink-muted">{report.disclaimer}</p>
      </article>
    </Panel>
  )
}

function num(v: number | null | undefined) {
  return v == null ? '—' : formatValue(v, Math.abs(v) >= 20 ? 0 : 1)
}
function unit(u: string) {
  return u === 'score' ? '/10' : u
}

interface Summary {
  astronautCode: string
  displayName: string
  periodStart: string
  periodEnd: string
  missionDays: [number, number] | null
  indicators: {
    indicator: string; name: string; unit: string; n: number; mean: number | null; min: number | null; max: number | null
    latest: number | null; baseline: number | null; sigma: number | null; zMean: number | null; flag: string
  }[]
  alerts: { id: string; title: string; severity: string; status: string; firstDay: string; lastDay: string; resolutionNote: string | null }[]
  insights: { kind: string; day: string; explanation: string }[]
  wellness: { mean: number | null; min: number | null; latest: number | null }
  adherence: { checkins: number; days: number; tasksDone: number; tasksPending: number; tasksSkipped: number }
  radiation: { periodMsv: number; missionMsv: number; limitMsv: number | null; pctOfLimit: number | null }
}
