import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { StatusBadge } from '../../components/ui/Status'
import { api, unwrap, type Astronaut } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useDashboard } from '../../lib/queries'
import { OverviewPage } from '../overview/OverviewPage'

/** Minimal crew list for staff roles. The full flight-surgeon dashboard is Step 8. */
export function CrewPage() {
  const role = useAuth((s) => s.user?.role)
  const { data, error, isPending } = useQuery({
    queryKey: ['crew'],
    queryFn: () => unwrap(api.GET('/api/astronauts')),
  })
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Crew</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {role === 'FlightSurgeon'
            ? 'Live status of every crew member. Full review tools arrive with the flight-surgeon dashboard (Step 8).'
            : role === 'Admin'
              ? 'The demo control panel arrives in Step 9.'
              : 'Mission control sees crew status only (Step 8).'}
        </p>
      </div>
      {isPending && <Loading />}
      {error && <ErrorNote error={error} />}
      <ul className="space-y-2">
        {data?.map((a) => <CrewRow key={a.id} astronaut={a} canView={role === 'FlightSurgeon'} />)}
      </ul>
    </div>
  )
}

function CrewRow({ astronaut, canView }: { astronaut: Astronaut; canView: boolean }) {
  const dash = useDashboard(canView ? astronaut.code : null)
  const content = (
    <Panel className="flex items-center justify-between gap-3">
      <div>
        <p className="font-medium">{astronaut.displayName}</p>
        <p className="text-xs text-ink-muted">{astronaut.code} · {astronaut.roleTitle}</p>
      </div>
      <div className="flex items-center gap-3">
        {dash.data && <StatusBadge status={dash.data.status} />}
        {canView && <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden />}
      </div>
    </Panel>
  )
  return <li>{canView ? <Link to={`/staff/astronaut/${astronaut.code}`}>{content}</Link> : content}</li>
}

export function StaffAstronautPage() {
  const { code } = useParams()
  return <OverviewPage code={code} readOnly />
}
