import { Box, Square } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EnvironmentPanel } from '../../components/ui/EnvironmentPanel'
import { ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { useAuth } from '../../lib/auth'
import { useBodySystems } from '../../lib/queries'
import { BodyMap2D } from './BodyMap2D'
import { RegionPanel } from './RegionPanel'
import { STATUS_FILL, STATUS_LABEL } from './regions'

const BodyModel3D = lazy(() => import('./BodyModel3D'))

/** Body Explorer (Step 10): click a region to see its readings, alerts and what changes in space. */
export function BodyExplorerPage({ code: forCode, staff = false }: { code?: string; staff?: boolean } = {}) {
  const user = useAuth((s) => s.user)
  const code = forCode ?? user?.astronautCode
  const [params, setParams] = useSearchParams()
  const selected = params.get('region') ?? 'heart'
  const view = params.get('model') === '3d' ? '3d' : '2d'
  const { data, error, isPending } = useBodySystems(code)
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    next.set(key, value)
    setParams(next, { replace: true })
  }
  const region = data?.regions.find((r) => r.id === selected)
  const alertsHref = (id: string) => (staff ? `/staff/astronaut/${code}?view=alerts&id=${id}` : `/astronaut/alerts?id=${id}`)

  return (
    <div className="max-w-6xl space-y-4">
      {!staff && (
        <div>
          <p className="font-mono text-sm text-accent">02</p>
          <h1 className="text-2xl font-semibold">Body Explorer</h1>
          <p className="mt-1 text-sm text-ink-muted">Choose a part of the body to see your readings against your own normal, any alerts, and what spaceflight does to it.</p>
        </div>
      )}
      {error && <ErrorNote error={error} />}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <Panel>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex rounded-lg border border-space-600 p-0.5" role="tablist" aria-label="View">
              {(['2d', '3d'] as const).map((v) => (
                <button key={v} role="tab" aria-selected={view === v} onClick={() => set('model', v)}
                  className={`inline-flex min-h-9 items-center gap-1 rounded-md px-3 text-sm ${view === v ? 'bg-space-700 text-ink' : 'text-ink-muted'}`}>
                  {v === '2d' ? <Square className="h-4 w-4" aria-hidden /> : <Box className="h-4 w-4" aria-hidden />} {v.toUpperCase()}
                </button>
              ))}
            </div>
            <button onClick={() => set('region', 'whole_body')} aria-pressed={selected === 'whole_body'}
              className={`min-h-9 rounded-md px-2 text-xs ${selected === 'whole_body' ? 'bg-space-700 text-ink' : 'text-ink-muted hover:bg-space-800'}`}>
              Whole body · radiation
            </button>
          </div>
          {isPending ? <Loading /> : view === '2d'
            ? <BodyMap2D regions={data?.regions} selected={selected} onSelect={(id) => set('region', id)} />
            : (
              <Suspense fallback={<Loading />}>
                <BodyModel3D regions={data?.regions} selected={selected} onSelect={(id) => set('region', id)} />
              </Suspense>
            )}
          <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted" aria-label="Legend">
            {(['GREEN', 'YELLOW', 'RED', 'GREY'] as const).map((s) => (
              <li key={s} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_FILL[s] }} aria-hidden />{STATUS_LABEL[s]}</li>
            ))}
          </ul>
        </Panel>
        <div className="min-w-0">{region ? <RegionPanel region={region} alertsHref={alertsHref} /> : !isPending && <Panel><p className="text-sm text-ink-muted">Choose a region.</p></Panel>}</div>
      </div>
      {code && (
        <section aria-label="Environment and radiation">
          <h2 className="mb-2 text-sm font-semibold tracking-wider text-ink-muted uppercase">Environment & radiation</h2>
          <EnvironmentPanel code={code} />
        </section>
      )}
    </div>
  )
}
