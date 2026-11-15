import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EnvironmentPanel } from '../../components/ui/EnvironmentPanel'
import { ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { MoreDetail } from '../../components/ui/Simple'
import { useAuth } from '../../lib/auth'
import { useBodySystems } from '../../lib/queries'
import { BodyMap2D } from './BodyMap2D'
import { RegionPanel } from './RegionPanel'
import { STATUS_FILL, STATUS_ICON, STATUS_LABEL, statusOf, SYSTEM_INFO, SYSTEM_ORDER } from './regions'

const BodyModel3D = lazy(() => import('./BodyModel3D'))

/**
 * My Health → Body systems. Pick a system from the list (large targets) or the body diagram; the
 * panel explains it and shows the astronaut's own readings against their normal.
 */
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
  const alertsHref = (id: string) => (staff ? `/staff/astronaut/${code}?view=alerts&id=${id}` : `/astronaut/guidance/alerts?id=${id}`)
  const historyHref = staff ? undefined : (indicator: string) => `/astronaut/health/trends?indicator=${indicator}`

  return (
    <div className="space-y-5">
      {error && <ErrorNote error={error} />}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="space-y-4">
          <Panel>
            <h2 className="mb-2 text-sm font-semibold">Choose a part of your body</h2>
            <ul className="space-y-1" aria-label="Choose a body system">
              {SYSTEM_ORDER.map((id) => {
                const status = statusOf(data?.regions, id)
                const Icon = STATUS_ICON[status]
                const active = selected === id
                return (
                  <li key={id}>
                    <button type="button" onClick={() => set('region', id)} aria-pressed={active}
                      className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm ${active ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-subtle'}`}>
                      <Icon className="h-4 w-4 shrink-0" style={{ color: STATUS_FILL[status] }} aria-hidden />
                      <span className="flex-1">{SYSTEM_INFO[id]?.name ?? id}</span>
                      <span className="sr-only">: {STATUS_LABEL[status]}</span>
                      {status !== 'GREEN' && <span className="text-[11px] font-normal text-ink-muted" aria-hidden>{STATUS_LABEL[status]}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </Panel>
          <Panel>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Body diagram</h2>
              <div className="flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="Diagram type">
                {(['2d', '3d'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={view === v} onClick={() => set('model', v)}
                    className={`min-h-9 rounded-md px-3 text-xs font-medium ${view === v ? 'bg-accent text-on-accent' : 'text-ink-muted hover:bg-subtle'}`}>
                    {v === '2d' ? 'Flat' : '3D'}
                  </button>
                ))}
              </div>
            </div>
            {isPending ? <Loading /> : view === '2d'
              ? <BodyMap2D regions={data?.regions} selected={selected} onSelect={(id) => set('region', id)} />
              : (
                <Suspense fallback={<Loading />}>
                  <BodyModel3D regions={data?.regions} selected={selected} onSelect={(id) => set('region', id)} />
                </Suspense>
              )}
            <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted" aria-label="Colour key">
              {(['GREEN', 'YELLOW', 'RED', 'GREY'] as const).map((s) => (
                <li key={s} className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_FILL[s] }} aria-hidden />{STATUS_LABEL[s]}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
        <div className="min-w-0">
          {region ? <RegionPanel region={region} alertsHref={alertsHref} historyHref={historyHref} readOnly={staff} />
            : !isPending && <Panel><p className="text-sm text-ink-muted">Choose a body system.</p></Panel>}
        </div>
      </div>
      {code && (
        <section aria-labelledby="env-heading" className="rounded-xl border border-line bg-surface p-4 md:p-5">
          <h2 id="env-heading" className="text-lg font-semibold">Cabin air and radiation</h2>
          <p className="text-sm text-ink-muted">The air you breathe and the radiation you receive. A storm warning appears on Home.</p>
          <MoreDetail label="Show the cabin readings and your radiation dose" className="mt-1">
            <div className="text-ink"><EnvironmentPanel code={code} /></div>
          </MoreDetail>
        </section>
      )}
    </div>
  )
}
