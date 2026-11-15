import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, LifeBuoy, Satellite, Send, ShieldAlert, Sparkles, WifiOff, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { EmergencyProtocolCard } from '../../components/ui/EmergencyProtocolCard'
import { ErrorNote, LinkButton, Loading, Panel } from '../../components/ui/Panel'
import { MoreDetail, PageHeader } from '../../components/ui/Simple'
import { api, unwrap, type ChatCitation, type ChatOut, type ChatTurn } from '../../lib/api'
import { EMERGENCY_PROTOCOLS } from '../../lib/emergency'
import { useAssistantHistory, useAssistantStatus } from '../../lib/queries'

const SUGGESTED = [
  'Why am I so tired?',
  'Is my heart OK?',
  'How can I sleep better?',
  'What should I do today?',
  'What happens in a solar storm?',
  'Why are my eyes checked?',
]

interface Message {
  id: string
  role: ChatTurn['role']
  text: string
  shortAnswer?: string
  detail?: string
  getHelp?: string | null
  mode?: string | null
  provider?: string | null
  citations?: ChatCitation[]
  suggestedActions?: string[]
  emergencyProtocolId?: string | null
  alertId?: string | null
  safetyFlags?: string[]
}

function fromChat(out: ChatOut): Message {
  return {
    id: out.messageId,
    role: 'assistant',
    text: out.answer,
    shortAnswer: out.shortAnswer,
    detail: out.detail,
    getHelp: out.getHelp ?? null,
    mode: out.mode,
    provider: out.provider,
    citations: out.citations,
    suggestedActions: out.suggestedActions,
    emergencyProtocolId: out.emergencyProtocolId,
    alertId: out.alertId ?? null,
    safetyFlags: out.safetyFlags,
  }
}

function ProviderBadge({ provider }: { provider?: string | null }) {
  if (provider === 'redflag')
    return <span className="inline-flex items-center gap-1 rounded-full bg-status-red/15 px-2 py-0.5 text-xs text-status-red"><ShieldAlert className="h-3 w-3" aria-hidden /> Emergency · no AI</span>
  if (provider === 'claude')
    return <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent"><Satellite className="h-3 w-3" aria-hidden /> Earth relay · Claude</span>
  return <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs text-ink-muted"><WifiOff className="h-3 w-3" aria-hidden /> Onboard · offline</span>
}

function Citations({ citations }: { citations: ChatCitation[] }) {
  if (citations.length === 0) return null
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Sources">
      {citations.map((c) => (
        <li key={c.chunkId}>
          <a href={c.source} target="_blank" rel="noreferrer" title={c.source}
            className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-xs text-ink-muted hover:border-accent hover:text-ink">
            <BookOpen className="h-3 w-3" aria-hidden /> {c.title}
          </a>
        </li>
      ))}
    </ul>
  )
}

/** One answer: the short answer first, then up to 3 steps, when to get help; everything else folded. */
function Bubble({ m }: { m: Message }) {
  if (m.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-accent-soft px-4 py-2.5 text-base">{m.text}</div>
    )
  }
  const fallback = m.safetyFlags?.find((f) => f.startsWith('fallback:'))
  const [first, ...rest] = m.text.split('\n\n')
  const short = m.shortAnswer || first
  const detail = m.shortAnswer ? m.detail ?? '' : rest.join('\n\n')
  const steps = (m.suggestedActions ?? []).slice(0, 3)
  return (
    <div className="max-w-[92%] space-y-3 rounded-2xl rounded-bl-sm border border-line bg-surface px-5 py-4">
      <p className="text-base font-semibold leading-relaxed">{short}</p>
      {m.emergencyProtocolId && <EmergencyProtocolCard id={m.emergencyProtocolId} reported={Boolean(m.alertId)} />}
      {steps.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-accent">What helps</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-base">{steps.map((a) => <li key={a}>{a}</li>)}</ol>
        </div>
      )}
      {m.getHelp && (
        <p className="flex items-start gap-2 rounded-lg bg-status-yellow/10 px-3 py-2 text-sm text-status-yellow">
          <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {m.getHelp}
        </p>
      )}
      {(detail || (m.citations?.length ?? 0) > 0) && (
        <MoreDetail>
          <div className="space-y-2 text-ink">
            {detail.split('\n\n').filter(Boolean).map((p, i) => <p key={i} className="text-sm leading-relaxed">{p}</p>)}
          </div>
          <Citations citations={m.citations ?? []} />
          <div className="mt-2 flex flex-wrap items-center gap-2"><ProviderBadge provider={m.provider} />
            {fallback && <span className="text-xs">Claude unavailable ({fallback.slice(10)}), answered offline</span>}
          </div>
        </MoreDetail>
      )}
    </div>
  )
}

export function AssistantPage() {
  const status = useAssistantStatus()
  const history = useAssistantHistory()
  const queryClient = useQueryClient()
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [draft, setDraft] = useState('')
  const [offline, setOffline] = useState(false)
  const [protocol, setProtocol] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const shown = messages ?? history.data ?? []

  const ask = useMutation({
    mutationFn: (question: string) =>
      unwrap(api.POST('/api/assistant/chat', { body: { question, provider: offline ? 'template' : 'auto' } })),
    onMutate: (question) =>
      setMessages([...shown, { id: `pending-${Date.now()}`, role: 'user', text: question, citations: [], suggestedActions: [] }]),
    onSuccess: (out) => {
      setMessages((prev) => [...(prev ?? []), fromChat(out)])
      if (out.alertId) {
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        void queryClient.invalidateQueries({ queryKey: ['alerts'] })
      }
    },
  })

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [shown.length, ask.isPending])

  const send = (question: string) => {
    const q = question.trim()
    if (!q || ask.isPending) return
    setDraft('')
    ask.mutate(q)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(draft)
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 xl:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-4">
        <PageHeader title="AI Assistant" purpose="Ask anything about your health. You get a short, simple answer first." />

        <div className="flex flex-wrap items-center gap-3 text-sm">
          {status.data && (status.data.claudeConfigured
            ? <ProviderBadge provider={offline ? 'template' : 'claude'} />
            : <ProviderBadge provider="template" />)}
          {status.data?.claudeConfigured && (
            <label className="inline-flex items-center gap-2 text-xs text-ink-muted">
              <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} /> Answer offline only
            </label>
          )}
          {status.data && !status.data.claudeConfigured && (
            <span className="text-xs text-ink-muted">No Earth relay configured; answers come from the onboard template.</span>
          )}
        </div>

        <Panel>
          <div className="max-h-[60vh] min-h-64 space-y-4 overflow-y-auto pr-1" aria-live="polite">
            {history.isPending && <Loading />}
            {history.error && <ErrorNote error={history.error} />}
            {shown.length === 0 && !history.isPending && (
              <div className="py-6 text-center text-sm text-ink-muted">
                <Sparkles className="mx-auto mb-2 h-6 w-6 text-accent" aria-hidden />
                Tap a question below, or type your own.
              </div>
            )}
            {shown.map((m) => <Bubble key={m.id} m={m} />)}
            {ask.isPending && <p className="text-sm text-ink-muted">Thinking…</p>}
            <div ref={end} />
          </div>
          {ask.isError && <ErrorNote error={ask.error} />}

          <div className="mt-4 flex flex-wrap gap-2">
            {SUGGESTED.map((q) => (
              <button key={q} onClick={() => send(q)} disabled={ask.isPending}
                className="min-h-10 rounded-full border border-line-strong px-4 text-sm hover:border-accent hover:bg-accent-soft disabled:opacity-50">
                {q}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="mt-3 flex items-end gap-2">
            <label className="sr-only" htmlFor="question">Your question</label>
            <textarea id="question" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={2000}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft) } }}
              placeholder="Type your question, e.g. Why do I feel dizzy?"
              className="min-h-12 flex-1 resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-base outline-none focus:border-accent" />
            <button type="submit" disabled={!draft.trim() || ask.isPending} aria-label="Send"
              className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-40">
              <Send className="h-5 w-5" aria-hidden />
            </button>
          </form>
          <p className="mt-2 text-[11px] text-ink-muted">Health information, not a diagnosis. All data is simulated. In an emergency, follow the protocol.</p>
        </Panel>
      </div>

      <aside className="space-y-4">
        <Panel title="In an emergency">
          <p className="text-sm">Don't wait for an answer: open the emergency steps and call the crew medical officer.</p>
          <LinkButton to="/astronaut/emergency" variant="danger" className="mt-3 w-full">
            <ShieldAlert className="h-4 w-4" aria-hidden /> Emergency steps
          </LinkButton>
          <MoreDetail label="All procedures" className="mt-2">
            <ul className="space-y-1">
              {Object.values(EMERGENCY_PROTOCOLS).sort((a, b) => a.title.localeCompare(b.title)).map((p) => (
                <li key={p.id}>
                  <button onClick={() => setProtocol(protocol === p.id ? null : p.id)} aria-expanded={protocol === p.id}
                    className="min-h-9 w-full rounded-md px-2 py-1 text-left text-sm text-ink hover:bg-subtle">{p.title}</button>
                  {protocol === p.id && <div className="mt-2"><EmergencyProtocolCard id={p.id} /></div>}
                </li>
              ))}
            </ul>
          </MoreDetail>
        </Panel>
        <Panel title="About the assistant">
          <ul className="space-y-1.5 text-sm">
            {['Explains your readings in plain words', 'Says what helps', 'Shows its sources'].map((t) => (
              <li key={t} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-status-green" aria-hidden />{t}</li>
            ))}
            {['Never diagnoses', 'Never prescribes medicine'].map((t) => (
              <li key={t} className="flex items-start gap-2"><X className="mt-0.5 h-4 w-4 shrink-0 text-status-red" aria-hidden />{t}</li>
            ))}
          </ul>
          {status.data && (
            <MoreDetail label="Where answers come from" className="mt-2">
              Your own records and {status.data.knowledgeNotes} approved notes written from NASA Human Research Program and
              Canadian Space Agency pages. Emergencies are recognised instantly, without any AI. A broken or unsafe AI answer is
              replaced by the offline answer.
            </MoreDetail>
          )}
        </Panel>
      </aside>
    </div>
  )
}
