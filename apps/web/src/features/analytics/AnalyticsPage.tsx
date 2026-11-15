import { Table2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import type { Analytics } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { infoFor, unitLabel } from '../../lib/indicators'
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
  { id: '90d', label: '90 days' },
  { id: 'mission', label: 'Whole mission' },
]
/** Ready-made views for the questions astronauts ask most. */
const PRESETS: { label: string; mode: 'compare' | 'single'; a: string; b?: string }[] = [
  { label: 'Sleep and fatigue', mode: 'compare', a: 'sleep_hours', b: 'fatigue' },
  { label: 'Mood and stress', mode: 'compare', a: 'mood', b: 'stress' },
  { label: 'Heart rate and sleep', mode: 'compare', a: 'resting_hr', b: 'sleep_hours' },
  { label: 'Exercise', mode: 'single', a: 'activity_min' },
  { label: 'Strength', mode: 'single', a: 'strength_index' },
  { label: 'Blood pressure', mode: 'compare', a: 'bp_sys', b: 'bp_dia' },
]

export function AnalyticsPage({ code: forCode, embedded = false }: { code?: string; embedded?: boolean } = {}) {
  const user = useAuth((s) => s.user)
  const code = forCode ?? user?.astronautCode
  const [params, setParams] = useSearchParams()
  const linked = params.get('indicator') // from "View history" links
  const mode = linked || params.get('mode') === 'single' ? 'single' : 'compare'
  const a = linked ?? params.get('a') ?? (mode === 'single' ? 'resting_hr' : 'sleep_hours')
  const b = params.get('b') ?? 'fatigue'
  const range = (params.get('range') as Range | null) ?? '30d'
  const [table, setTable] = useState<'off' | 'daily' | 'weekly'>('off')
  const catalog = useCatalog().data ?? {}

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params)
    next.delete('indicator')
    if (linked && !('a' in changes)) next.set('a', linked)
    if (linked && !('mode' in changes)) next.set('mode', 'single')
    for (const [k, v] of Object.entries(changes)) next.set(k, v)
    setParams(next, { replace: true })
  }
  const qa = useAnalytics(code, a, range)
  const qb = useAnalytics(code, mode === 'compare' ? b : null, range)
  const wellness = useWellnessTrend(code, range)
  const name = (c: string) => infoFor(c)?.label ?? catalog[c]?.name ?? c.replace('_', ' ')

  const select = (key: 'a' | 'b', value: string, label: string, colour?: string) => (
    <label className="flex items-center gap-2 text-sm">
      {colour && <span className="inline-block h-1 w-5 rounded" style={{ background: colour }} aria-hidden />}
      <span className="text-ink-muted">{label}</span>
      <select value={value} onChange={(e) => update({ [key]: e.target.value })}
        className="min-h-10 rounded-lg border border-line-strong bg-surface px-2 text-sm outline-none focus:border-accent">
        {INDICATORS.map((c) => <option key={c} value={c}>{name(c)}</option>)}
      </select>
    </label>
  )

  return (
    <div className="space-y-4">
      {!embedded && <h1 className="text-2xl font-semibold">Health trends</h1>}

      <div className="space-y-3 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quick views">
          <span className="text-sm text-ink-muted">Quick views:</span>
          {PRESETS.map((p) => {
            const on = p.mode === mode && p.a === a && (p.mode === 'single' || p.b === b)
            return (
              <button key={p.label} type="button" aria-pressed={on}
                onClick={() => update(p.b ? { mode: p.mode, a: p.a, b: p.b } : { mode: p.mode, a: p.a })}
                className={`min-h-9 rounded-full border px-3 text-xs font-medium ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong hover:bg-subtle'}`}>
                {p.label}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="Chart type">
            {(['single', 'compare'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => update({ mode: m })}
                className={`min-h-9 rounded-md px-3 text-sm ${mode === m ? 'bg-accent text-on-accent' : 'text-ink hover:bg-subtle'}`}>
                {m === 'compare' ? 'Compare two' : 'One measurement'}
              </button>
            ))}
          </div>
          {select('a', a, mode === 'compare' ? 'First' : 'Measurement', mode === 'compare' ? VIZ.series1 : undefined)}
          {mode === 'compare' && select('b', b, 'Second', VIZ.series2)}
          <div className="ml-auto flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.id} type="button" onClick={() => update({ range: r.id })} aria-pressed={range === r.id}
                className={`min-h-9 rounded-md px-3 text-sm ${range === r.id ? 'bg-accent text-on-accent' : 'text-ink hover:bg-subtle'}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {qa.data && <WhatChanged data={qa.data} name={name(a)} />}
      {mode === 'compare' && qb.data && <WhatChanged data={qb.data} name={name(b)} />}

      <Panel
        title={mode === 'compare' ? `${name(a)} and ${name(b)}: distance from your normal` : `${name(a)} compared with your normal`}
        action={
          <div className="flex items-center gap-1" role="group" aria-label="Table view">
            <Table2 className="h-4 w-4 text-ink-muted" aria-hidden />
            {(['off', 'daily', 'weekly'] as const).map((t) => (
              <button key={t} type="button" aria-pressed={table === t} onClick={() => setTable(t)}
                className={`min-h-9 rounded-md px-2 text-xs ${table === t ? 'bg-subtle font-semibold text-ink' : 'text-ink-muted hover:bg-subtle'}`}>
                {{ off: 'Chart only', daily: 'Daily table', weekly: 'Weekly table' }[t]}
              </button>
            ))}
          </div>
        }
      >
        {(qa.isPending || (mode === 'compare' && qb.isPending)) && <Loading />}
        {qa.error && <ErrorNote error={qa.error} />}
        {qb.error && <ErrorNote error={qb.error} />}
        {qa.data && mode === 'single' && (
          <>
            <BaselineChart data={qa.data} missionStart={user?.missionStart} />
            <p className="mt-2 text-xs text-ink-muted">
              Line: your daily value. Shaded band: your normal range (your typical value ± 2σ over the previous 4 weeks).
              Dashed line: before flight. Shaded periods: alerts. Hover or tap a day for exact values.
            </p>
          </>
        )}
        {qa.data && qb.data && mode === 'compare' && (
          <>
            <DeviationChart a={qa.data} b={qb.data} missionStart={user?.missionStart} />
            <p className="mt-2 text-xs text-ink-muted">
              Both lines show how far each measurement is from <em>your</em> normal (0 = normal, the band is ±2σ), so
              different units fit on one axis. When both move together, they may be related. Hover a day for the actual values.
            </p>
          </>
        )}
        {table !== 'off' && qa.data && <DataTable data={qa.data} missionStart={user?.missionStart} weekly={table === 'weekly'} />}
        {table !== 'off' && mode === 'compare' && qb.data && <DataTable data={qb.data} missionStart={user?.missionStart} weekly={table === 'weekly'} />}
      </Panel>

      {mode === 'compare' && qa.data && qb.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={name(a)}><BaselineChart data={qa.data} missionStart={user?.missionStart} height={200} /></Panel>
          <Panel title={name(b)}><BaselineChart data={qb.data} missionStart={user?.missionStart} height={200} /></Panel>
        </div>
      )}

      <Panel title="Wellness summary over time">
        {wellness.isPending && <Loading />}
        {wellness.data && wellness.data.length > 0 ? (
          <>
            <WellnessTrendChart rows={wellness.data} missionStart={user?.missionStart} />
            <p className="mt-2 text-xs text-ink-muted">A summary of your readings against your own normal (100 = all within normal). Not a clinical score.</p>
          </>
        ) : (
          !wellness.isPending && <p className="text-sm text-ink-muted">No wellness history yet.</p>
        )}
      </Panel>
    </div>
  )
}

/** Plain-language summary of the selected period: latest vs normal, overall change, days outside normal. */
function WhatChanged({ data, name }: { data: Analytics; name: string }) {
  const rows = toValueRows(data).filter((r) => r.value != null)
  if (rows.length === 0) return <p className="rounded-xl border border-line bg-surface p-3 text-sm text-ink-muted">{name}: no readings in this period.</p>
  const dec = Math.max(data.decimals, data.unit === 'mSv' ? 3 : 0)
  const u = unitLabel(data.unit)
  const fmt = (v: number) => `${formatValue(v, dec)}${u.startsWith('/') ? '' : ' '}${u}`
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const first = rows[0], last = rows[rows.length - 1]
  const change = (last.value ?? 0) - (first.value ?? 0)
  const outside = rows.filter((r) => r.z != null && Math.abs(r.z) >= 2)
  const max = rows.reduce((m, r) => ((r.value ?? -Infinity) > (m.value ?? -Infinity) ? r : m))
  const min = rows.reduce((m, r) => ((r.value ?? Infinity) < (m.value ?? Infinity) ? r : m))
  const sentences = [
    `Latest ${fmt(last.value!)}${last.median != null ? ` (your normal ${fmt(last.median)})` : ''}.`,
    rows.length > 1 ? `Since ${day(first.date)}: ${Math.abs(change) < 10 ** -dec ? 'no overall change' : `${change > 0 ? 'up' : 'down'} ${fmt(Math.abs(change))}`}.` : null,
    `${outside.length} of ${rows.length} day${rows.length === 1 ? '' : 's'} outside your normal range${outside.length ? ` (most recent ${day(outside[outside.length - 1].date)})` : ''}.`,
    rows.length > 2 ? `Lowest ${fmt(min.value!)} (${day(min.date)}), highest ${fmt(max.value!)} (${day(max.date)}).` : null,
  ].filter(Boolean)
  return (
    <section className={`rounded-xl border bg-surface p-4 ${outside.length ? 'border-status-yellow/50' : 'border-line'}`} aria-label={`What changed: ${name}`}>
      <h2 className="text-sm font-semibold">What changed · {name}</h2>
      <p className="mt-1 text-sm">{sentences.join(' ')}</p>
    </section>
  )
}

function DataTable({ data, missionStart, weekly }: { data: Analytics; missionStart?: string | null; weekly: boolean }) {
  const daily = toValueRows(data, missionStart).filter((r) => r.value != null)
  const dec = Math.max(data.decimals, data.unit === 'mSv' ? 3 : 1)
  const rows = weekly
    ? Object.values(
        daily.reduce<Record<string, { label: string; values: number[]; outside: number }>>((acc, r) => {
          const d = new Date(`${r.date}T00:00:00Z`)
          const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
          acc[monday] ??= { label: `Week of ${monday}`, values: [], outside: 0 }
          acc[monday].values.push(r.value!)
          if (r.z != null && Math.abs(r.z) >= 2) acc[monday].outside += 1
          return acc
        }, {}),
      ).reverse()
    : null
  return (
    <div className="mt-4 max-h-80 overflow-auto">
      <table className="w-full text-left text-sm">
        <caption className="mb-1 text-left text-xs font-semibold">{data.name} ({unitLabel(data.unit)}) — {weekly ? 'weekly averages' : 'daily values'}</caption>
        {weekly ? (
          <>
            <thead className="sticky top-0 bg-surface text-xs text-ink-muted">
              <tr><th className="py-1 pr-3 font-medium">Week</th><th className="py-1 pr-3 font-medium">Average</th><th className="py-1 pr-3 font-medium">Lowest–highest</th><th className="py-1 font-medium">Days outside normal</th></tr>
            </thead>
            <tbody>
              {rows!.map((w) => (
                <tr key={w.label} className="border-t border-line">
                  <td className="py-1 pr-3">{w.label}</td>
                  <td className="py-1 pr-3">{formatValue(w.values.reduce((x, y) => x + y, 0) / w.values.length, dec)}</td>
                  <td className="py-1 pr-3">{formatValue(Math.min(...w.values), dec)}–{formatValue(Math.max(...w.values), dec)}</td>
                  <td className="py-1">{w.outside} of {w.values.length}</td>
                </tr>
              ))}
            </tbody>
          </>
        ) : (
          <>
            <thead className="sticky top-0 bg-surface text-xs text-ink-muted">
              <tr><th className="py-1 pr-3 font-medium">Day</th><th className="py-1 pr-3 font-medium">Value</th><th className="py-1 pr-3 font-medium">Your normal</th><th className="py-1 font-medium">Difference</th></tr>
            </thead>
            <tbody>
              {[...daily].reverse().map((r) => (
                <tr key={r.key} className="border-t border-line">
                  <td className="py-1 pr-3">{r.label} <span className="text-ink-muted">{r.date}</span></td>
                  <td className="py-1 pr-3">{formatValue(r.value ?? 0, dec)}</td>
                  <td className="py-1 pr-3">{r.band ? `${formatValue(r.band[0], dec)}–${formatValue(r.band[1], dec)}` : '—'}</td>
                  <td className="py-1">{r.z != null ? `${r.z > 0 ? '+' : ''}${r.z.toFixed(1)}σ${Math.abs(r.z) >= 2 ? ' · outside normal' : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </>
        )}
      </table>
    </div>
  )
}
