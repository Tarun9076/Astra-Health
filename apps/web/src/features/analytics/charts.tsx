// Charts for Health Analytics. Colour roles validated with the dataviz skill's validator on the app's
// light surface: series blue #1f6fd1 + magenta #c2417a pass every check (CVD ΔE 14.1, normal 26.3,
// contrast ≥ 3:1). Magenta was chosen over orange because amber/red are reserved for alert status here.
// The personal-normal band is neutral (not a data colour); alert periods use status colours with a text label.
import type { ReactElement } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Analytics, WellnessDay } from '../../lib/api'
import { formatValue } from '../../lib/mission'
import { dayLabel, toValueRows, VIZ, type ValueRow } from './viz'



const axisProps = {
  stroke: VIZ.grid,
  tick: { fill: VIZ.axis, fontSize: 11 },
  tickLine: false,
} as const

function TipBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line-strong bg-surface/95 px-3 py-2 text-xs shadow-lg">{children}</div>
  )
}

function alertBands(data: Analytics, rows: ValueRow[]): ReactElement[] {
  if (rows.length === 0) return []
  const first = rows[0].date
  const last = rows[rows.length - 1].date
  return data.alerts.flatMap((a) => {
    const from = a.firstDay < first ? first : a.firstDay
    const to = a.lastDay > last ? last : a.lastDay
    if (from > last || to < first) return []
    const x1 = rows.find((r) => r.date === from)?.label
    const x2 = rows.find((r) => r.date === to)?.label
    const colour = a.severity === 'Urgent' ? VIZ.urgent : VIZ.attention
    const label = { value: a.severity === 'Urgent' ? '⚠ Urgent' : '▲ Alert', position: 'insideTopLeft' as const, fill: colour, fontSize: 10 }
    return x1 === x2
      ? [<ReferenceLine key={a.id} x={x1} stroke={colour} strokeWidth={2} label={label} />]
      : [<ReferenceArea key={a.id} x1={x1} x2={x2} fill={colour} fillOpacity={0.08} stroke={colour} strokeOpacity={0.35} label={label} />]
  })
}

/** One indicator: daily value, the personal-normal band (median ± 2σ), pre-flight reference, alert periods. */
export function BaselineChart({ data, missionStart, height = 280 }: { data: Analytics; missionStart?: string | null; height?: number }) {
  const rows = toValueRows(data, missionStart)
  const unit = data.unit === 'score' ? '/10' : data.unit
  const dec = Math.max(data.decimals, data.unit === 'mSv' ? 3 : 0)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={VIZ.grid} vertical={false} />
          <XAxis dataKey="label" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={48} domain={['auto', 'auto']} tickFormatter={(v: number) => formatValue(v, dec)} />
          {alertBands(data, rows)}
          <Area dataKey="band" stroke={VIZ.bandEdge} strokeDasharray="2 3" fill={VIZ.band} isAnimationActive={false} connectNulls />
          {data.preflight && (
            <ReferenceLine y={data.preflight.median} stroke={VIZ.axis} strokeDasharray="6 4"
              label={{ value: 'pre-flight normal', position: 'insideBottomRight', fill: VIZ.axis, fontSize: 10 }} />
          )}
          <Line dataKey="value" stroke={VIZ.series1} strokeWidth={2} dot={rows.length <= 31 ? { r: 3, fill: VIZ.series1, strokeWidth: 0 } : false}
            activeDot={{ r: 5, stroke: VIZ.surface, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="flagged" stroke="none" isAnimationActive={false} legendType="none"
            dot={{ r: 5, fill: VIZ.surface, stroke: VIZ.axis, strokeWidth: 2 }} activeDot={false} />
          <Tooltip
            cursor={{ stroke: VIZ.axis, strokeDasharray: '3 3' }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as ValueRow | undefined
              if (!active || !row) return null
              return (
                <TipBox>
                  <p className="font-medium text-ink">{row.label} · {row.date}</p>
                  <p className="mt-1 font-mono text-sm text-ink">
                    {row.value != null ? `${formatValue(row.value, dec)} ${unit}` : 'no reading'}
                  </p>
                  {row.band && (
                    <p className="text-ink-muted">your normal {formatValue(row.band[0], dec)}–{formatValue(row.band[1], dec)} {unit}</p>
                  )}
                  {row.z != null && <p className="text-ink-muted">{row.z > 0 ? '+' : ''}{row.z.toFixed(1)}σ from your normal</p>}
                  {row.flagged != null && (
                    <p className="text-ink-muted">○ flagged {formatValue(row.flagged, dec)} {unit} ({row.flaggedReason}) — not used</p>
                  )}
                </TipBox>
              )
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

export interface DeviationRow {
  key: string
  label: string
  date: string
  a: number | null
  b: number | null
  aValue: number | null
  bValue: number | null
}

/** Two indicators on one axis, each as σ from its own normal: no dual axis, one shared "normal" band. */
export function DeviationChart({ a, b, missionStart, height = 320 }: {
  a: Analytics
  b: Analytics
  missionStart?: string | null
  height?: number
}) {
  const bByDay = new Map(b.days.map((d) => [d.day, d]))
  const rows: DeviationRow[] = a.days.map((d) => {
    const other = bByDay.get(d.day)
    return {
      key: d.day,
      label: dayLabel(missionStart, d.day),
      date: d.day,
      a: d.z ?? null,
      b: other?.z ?? null,
      aValue: d.value ?? null,
      bValue: other?.value ?? null,
    }
  })
  const zs = rows.flatMap((r) => [r.a, r.b]).filter((z): z is number => z != null)
  const lo = Math.floor(Math.min(-3, ...zs)) - 0.5
  const hi = Math.ceil(Math.max(3, ...zs)) + 0.5
  const lastA = rows.map((r) => r.a).lastIndexOf(rows.filter((r) => r.a != null).at(-1)?.a ?? NaN)
  const lastB = rows.map((r) => r.b).lastIndexOf(rows.filter((r) => r.b != null).at(-1)?.b ?? NaN)
  const endLabel = (name: string, colour: string, index: number) =>
    (props: { x?: number | string; y?: number | string; index?: number }) =>
      props.index === index ? (
        <text x={Number(props.x) + 8} y={Number(props.y) + 4} fill={VIZ.text} fontSize={11}>
          <tspan fill={colour}>●</tspan> {name}
        </text>
      ) : (
        <g />
      )
  const unitOf = (x: Analytics) => (x.unit === 'score' ? '/10' : x.unit)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 16, right: 110, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={VIZ.grid} vertical={false} />
          <ReferenceArea y1={-2} y2={2} fill={VIZ.band} stroke="none"
            label={{ value: 'your normal (±2σ)', position: 'insideTopLeft', fill: VIZ.axis, fontSize: 10 }} />
          <ReferenceLine y={0} stroke={VIZ.bandEdge} />
          <XAxis dataKey="label" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={44} domain={[lo, hi]} allowDecimals={false} tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v}σ`} />
          <Line dataKey="a" name={a.name} stroke={VIZ.series1} strokeWidth={2} dot={false} isAnimationActive={false}
            activeDot={{ r: 5, stroke: VIZ.surface, strokeWidth: 2 }} label={endLabel(a.name, VIZ.series1, lastA)} />
          <Line dataKey="b" name={b.name} stroke={VIZ.series2} strokeWidth={2} dot={false} isAnimationActive={false}
            activeDot={{ r: 5, stroke: VIZ.surface, strokeWidth: 2 }} label={endLabel(b.name, VIZ.series2, lastB)} />
          <Tooltip
            cursor={{ stroke: VIZ.axis, strokeDasharray: '3 3' }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as DeviationRow | undefined
              if (!active || !row) return null
              const line = (name: string, colour: string, z: number | null, v: number | null, unit: string) => (
                <p className="flex items-center gap-2 text-ink">
                  <span className="inline-block h-0.5 w-3" style={{ background: colour }} />
                  {name}: <span className="font-mono">{v != null ? `${formatValue(v, 2)} ${unit}` : '—'}</span>
                  <span className="text-ink-muted">{z != null ? `(${z > 0 ? '+' : ''}${z.toFixed(1)}σ)` : ''}</span>
                </p>
              )
              return (
                <TipBox>
                  <p className="mb-1 font-medium text-ink">{row.label} · {row.date}</p>
                  {line(a.name, VIZ.series1, row.a, row.aValue, unitOf(a))}
                  {line(b.name, VIZ.series2, row.b, row.bValue, unitOf(b))}
                </TipBox>
              )
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Daily wellness index with its alert caps (75 / 40). Single series: the title names it, no legend. */
export function WellnessTrendChart({ rows, missionStart, height = 200 }: {
  rows: WellnessDay[]
  missionStart?: string | null
  height?: number
}) {
  const data = rows.map((r) => ({ label: dayLabel(missionStart, r.day), date: r.day, overall: r.overall ?? null }))
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={VIZ.grid} vertical={false} />
          <XAxis dataKey="label" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} width={36} domain={[0, 100]} ticks={[0, 40, 75, 100]} />
          <ReferenceLine y={75} stroke={VIZ.attention} strokeDasharray="4 4" strokeOpacity={0.6}
            label={{ value: 'cap while an alert is active', position: 'insideBottomRight', fill: VIZ.axis, fontSize: 10 }} />
          <ReferenceLine y={40} stroke={VIZ.urgent} strokeDasharray="4 4" strokeOpacity={0.6}
            label={{ value: 'cap while urgent', position: 'insideBottomRight', fill: VIZ.axis, fontSize: 10 }} />
          <Line dataKey="overall" stroke={VIZ.series1} strokeWidth={2} dot={false} isAnimationActive={false}
            activeDot={{ r: 5, stroke: VIZ.surface, strokeWidth: 2 }} />
          <Tooltip
            cursor={{ stroke: VIZ.axis, strokeDasharray: '3 3' }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as (typeof data)[number] | undefined
              if (!active || !row) return null
              return (
                <TipBox>
                  <p className="font-medium text-ink">{row.label} · {row.date}</p>
                  <p className="font-mono text-sm text-ink">{row.overall ?? '—'} / 100</p>
                </TipBox>
              )
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
