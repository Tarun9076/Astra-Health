import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck, Send, Siren, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorNote, Loading, Panel } from '../../components/ui/Panel'
import { api, unwrap, type Schemas } from '../../lib/api'
import type { AssessmentOut } from '../../lib/treatment/engine'
import { describeEvent } from './runner'

type EpisodeOut = Schemas['EpisodeOut']

function when(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function flagged(e: EpisodeOut): boolean {
  return e.events.some((x) => x.flags.length > 0) || e.status === 'Escalated' || e.source === 'device'
}

/** Crew overview (flight surgeon): Act Now treatments not reviewed yet, those needing a look first. */
export function TreatmentsToReview() {
  const q = useQuery({ queryKey: ['treatment-episodes', 'all'], queryFn: () => unwrap(api.GET('/api/treatment/episodes')) })
  const todo = (q.data ?? []).filter((e) => !e.reviewedAt && e.status !== 'Cancelled').sort((a, b) => Number(flagged(b)) - Number(flagged(a)))
  if (!todo.length) return null
  return (
    <Panel title={`Treatments to review (${todo.length})`}>
      <ul className="space-y-2">
        {todo.slice(0, 6).map((e) => (
          <li key={e.id}>
            <Link to={`/staff/astronaut/${e.astronautCode}?view=treatments`} className="block rounded-lg border border-line px-3 py-2 text-sm hover:border-accent">
              <span className="font-semibold">{e.astronautCode}</span> · {e.title} · {e.status} · {when(e.startedAt)}
              {flagged(e) && <span className="mt-0.5 block text-xs text-status-yellow">Needs a look: escalated, a flagged dose, or planned on a device</span>}
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** One astronaut (flight surgeon): every Act Now treatment with its full log, and the review. */
export function StaffTreatmentPanel({ code }: { code: string }) {
  const q = useQuery({
    queryKey: ['treatment-episodes', code],
    queryFn: () => unwrap(api.GET('/api/treatment/episodes', { params: { query: { astronaut: code } } })),
  })
  return (
    <div className="space-y-4">
      {q.isPending && <Loading />}
      {q.error && <ErrorNote error={q.error} />}
      {q.data?.length === 0 && <Panel><p className="text-sm text-ink-muted">No Act Now treatment for {code} yet.</p></Panel>}
      {q.data?.map((e) => <EpisodeCard key={e.id} episode={e} />)}
      <ProtocolUpdatePanel />
    </div>
  )
}

function EpisodeCard({ episode: e }: { episode: EpisodeOut }) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const plan = e.plan as unknown as AssessmentOut
  const review = useMutation({
    mutationFn: () => unwrap(api.POST('/api/treatment/episodes/{episode_id}/review', { params: { path: { episode_id: e.id } }, body: { note } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['treatment-episodes'] }),
  })
  return (
    <Panel title={`${e.title} · ${e.status}`}>
      <p className="text-sm text-ink-muted">
        Started {when(e.startedAt)} by {e.startedBy}{e.endedAt && ` · ended ${when(e.endedAt)}`}
        {e.source === 'device' && ' · planned on a device while the server was down'}
        {e.source === 'checkin' && ' · from the daily check-in'}
      </p>
      {e.outcomeNote && <p className="mt-1 text-sm">Crew note: “{e.outcomeNote}”</p>}
      {plan?.critical?.length > 0 && (
        <p className="mt-2 text-sm"><strong>Why:</strong> {plan.critical.map((p) => `${p.title} (${p.matchedBy.join('; ')})`).join(' · ')}</p>
      )}
      <ol className="mt-3 space-y-1 border-l-2 border-line pl-3 text-sm">
        {e.events.map((x) => (
          <li key={x.id}>
            <span className="tabular-nums text-ink-muted">{when(x.at)}</span> · {x.byName}: {describeEvent(x.kind, x.stepId, x.data, plan)}
            {x.deviceTime && <span className="text-ink-muted"> (device time)</span>}
            {x.flags.map((f) => <span key={f} className="mt-0.5 flex gap-1 text-status-yellow"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{f}</span>)}
          </li>
        ))}
        {e.events.length === 0 && <li className="text-ink-muted">No steps logged yet.</li>}
      </ol>
      {e.reviewedAt ? (
        <p className="mt-3 inline-flex items-center gap-1 text-sm text-status-green"><CheckCheck className="h-4 w-4" aria-hidden />
          Reviewed by {e.reviewedBy}{e.reviewNote && `: “${e.reviewNote}”`}</p>
      ) : (
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={(ev) => { ev.preventDefault(); review.mutate() }}>
          <input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} placeholder="Note for the crew (optional)"
            aria-label={`Review note for ${e.title}`} className="min-h-11 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none focus:border-accent" />
          <Button type="submit" disabled={review.isPending}>Mark reviewed</Button>
        </form>
      )}
      {review.isError && <ErrorNote error={review.error} />}
    </Panel>
  )
}

/** The flight surgeon corrects a protocol from Earth: checked here, signed, and used onboard for new treatments. */
function ProtocolUpdatePanel() {
  const files = useQuery({ queryKey: ['treatment-protocols'], queryFn: () => unwrap(api.GET('/api/treatment/protocols')) })
  const [text, setText] = useState('')
  const send = useMutation({
    mutationFn: () => unwrap(api.POST('/api/treatment/protocols', { body: { protocol: JSON.parse(text) as Record<string, unknown> } })),
    onSuccess: () => void files.refetch(),
  })
  const load = (id: string) => {
    const f = files.data?.files.find((x) => x.id === id)
    if (f) setText(JSON.stringify(f, null, 2))
  }
  return (
    <Panel title="Update a treatment protocol">
      <p className="text-sm text-ink-muted">Pick a protocol, edit it and raise its version. It is checked here, signed, sent with the next link window, checked again onboard, and used for new treatments only.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {files.data?.files.map((f) => (
          <Button key={String(f.id)} variant="ghost" onClick={() => load(String(f.id))}><Siren className="h-4 w-4" aria-hidden /> {String(f.title)} v{String(f.version)}</Button>
        ))}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} aria-label="Protocol JSON"
        className="mt-3 w-full rounded-lg border border-line-strong bg-surface p-2 font-mono text-xs outline-none focus:border-accent" />
      <Button className="mt-2" disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}><Send className="h-4 w-4" aria-hidden /> Check, sign and send</Button>
      {send.isError && <ErrorNote error={send.error instanceof SyntaxError ? new Error('That is not valid JSON.') : send.error} />}
      {send.isSuccess && <p role="status" className="mt-2 text-sm text-status-green">Sent: {send.data.title} v{send.data.version}, signed. It reaches the habitat with the next link window.</p>}
    </Panel>
  )
}
