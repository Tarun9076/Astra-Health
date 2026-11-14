import { Table2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import type { Analytics } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { formatValue } from '../../lib/mission'
import { useAnalytics, useCatalog, useWellnessTrend, type Range } from '../../lib/queries'
import { BaselineChart, DeviationChart, WellnessTrendChart } from './charts'
import { toValueRows, VIZ } from './viz'

const INDICATORS = [
  'resting_hr', 'sleep_hours', 'sleep_quality', 'mood', 'stress', 'fatigue', 'bp_sys', 'bp_dia', 'body_temp',
  'spo2', 'glucose', 'activity_min', 'hydration_ml', 'body_weight', 'strength_index', 'exercise_sessions', 'radiation_dose',
]
const RANGES: { id: Range; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'mission', label: 'Mission' },
]

export function AnalyticsPage() {
  const user = useAuth((s) => s.user)
  const code = user?.astronautCode
  const [params, setParams] = useSearchParams()
  const mode = params.get('mode') === 'single' ? 'single' : 'compare'
  const a = params.get('a') ?? (mode === 'single' ? 'resting_hr' : 'sleep_hours')
  const b = params.get('b') ?? 'resting_hr'
  const range = (params.get('range') as Range | null) ?? '30d'
  const [showTable, setShowTable] = useState(false)
  const catalog = useCatalog().data ?? {}

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    next.set(key, value)
    setParams(next, { replace: true })
  }
  const qa = useAnalytics(code, a, range)
  const qb = useAnalytics(code, mode === 'compare' ? b : null, range)
  const wellness = useWellnessTrend(code, range)
  const name = (c: string) => catalog[c]?.name ?? c.replace('_', ' ')

  const select = (key: 'a' | 'b', value: string, colour?: string) => (
    <label className="flex items-center gap-2 text-sm">
      {colour && <span className="inline-block h-0.5 w-4" style={{ background: colour }} aria-hidden />}
      <select value={value} onChange={(e) => set(key, e.target.value)}
        className="min-h-10 rounded-lg border border-space-600 bg-space-900 px-2 text-sm outline-none focus:border-accent">
        {INDICATORS.map((c) => <option key={c} value={c}>{name(c)}</option>)}
      </select>
    </label>
  )

  return (
    <div className="max-w-6xl space-y-4">
      <div>
        <p className="font-mono text-sm text-accent">03</p>
        <h1 className="text-2xl font-semibold">Health Analytics</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Your readings against <em>your own</em> normal. The shaded band is your personal range (median ± 2σ of the
          previous 4 weeks); shaded periods mark alerts.
        </p>
      </div>

      {/* One control row above the charts */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-space-600 p-0.5" role="tablist">
          {(['compare', 'single'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => set('mode', m)}
              className={`min-h-9 rounded-md px-3 text-sm ${mode === m ? 'bg-space-700 text-ink' : 'text-ink-muted'}`}>
              {m === 'compare' ? 'Compare vs your normal' : 'Single indicator'}
            </button>
          ))}
        </div>
        {select('a', a, mode === 'compare' ? VIZ.series1 : undefined)}
        {mode === 'compare' && <>vs {select('b', b, VIZ.series2)}</>}
        <div className="ml-auto flex rounded-lg border border-space-600 p-0.5">
          {RANGES.map((r) => (
            <button key={r.id} onClick={() => set('range', r.id)} aria-pressed={range === r.id}
              className={`min-h-9 rounded-md px-3 text-sm ${range === r.id ? 'bg-space-700 text-ink' : 'text-ink-muted'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <Panel
        title={mode === 'compare' ? `${name(a)} and ${name(b)} — distance from your normal` : `${name(a)} vs your normal`}
        action={
          <button onClick={() => setShowTable((s) => !s)} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs text-ink-muted hover:bg-space-700 hover:text-ink">
            <Table2 className="h-4 w-4" aria-hidden /> {showTable ? 'Hide table' : 'Show table'}
          </button>
        }
      >
        {(qa.isPending || (mode === 'compare' && qb.isPending)) && <Loading />}
        {qa.error && <ErrorNote error={qa.error} />}
        {qb.error && <ErrorNote error={qb.error} />}
        {qa.data && mode === 'single' && <BaselineChart data={qa.data} missionStart={user?.missionStart} />}
        {qa.data && qb.data && mode === 'compare' && (
          <>
            <DeviationChart a={qa.data} b={qb.data} missionStart={user?.missionStart} />
            <p className="mt-2 text-xs text-ink-muted">
              0σ is your normal for each reading; the band is ±2σ. Different units share one axis by showing how far
              each is from <em>your</em> normal. Hover a day for the actual values.
            </p>
          </>
        )}
        {showTable && qa.data && <DataTable data={qa.data} missionStart={user?.missionStart} />}
      </Panel>

      {mode === 'compare' && qa.data && qb.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={name(a)}><BaselineChart data={qa.data} missionStart={user?.missionStart} height={200} /></Panel>
          <Panel title={name(b)}><BaselineChart data={qb.data} missionStart={user?.missionStart} height={200} /></Panel>
        </div>
      )}

      <Panel title="Wellness index">
        {wellness.isPending && <Loading />}
        {wellness.data && wellness.data.length > 0 ? (
          <>
            <WellnessTrendChart rows={wellness.data} missionStart={user?.missionStart} />
            <p className="mt-2 text-xs text-ink-muted">A summary of your readings vs your own normal — not a clinical score.</p>
          </>
        ) : (
          !wellness.isPending && <p className="text-sm text-ink-muted">No wellness history yet.</p>
        )}
      </Panel>
    </div>
  )
}

function DataTable({ data, missionStart }: { data: Analytics; missionStart?: string | null }) {
  const rows = toValueRows(data, missionStart).filter((r) => r.value != null).reverse()
  const dec = Math.max(data.decimals, data.unit === 'mSv' ? 3 : 1)
  return (
    <div className="mt-4 max-h-80 overflow-auto">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-space-800 text-xs text-ink-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Day</th>
            <th className="py-1 pr-3 font-medium">{data.name} ({data.unit})</th>
            <th className="py-1 pr-3 font-medium">Your normal</th>
            <th className="py-1 font-medium">Difference</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-space-700">
              <td className="py-1 pr-3 font-sans">{r.label} <span className="text-ink-muted">{r.date}</span></td>
              <td className="py-1 pr-3">{formatValue(r.value ?? 0, dec)}</td>
              <td className="py-1 pr-3">{r.band ? `${formatValue(r.band[0], dec)}–${formatValue(r.band[1], dec)}` : '—'}</td>
              <td className="py-1">{r.z != null ? `${r.z > 0 ? '+' : ''}${r.z.toFixed(1)}σ` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
