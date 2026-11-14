import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquareText } from 'lucide-react'
import { api, unwrap } from '../../lib/api'
import { timeAgo } from '../../lib/mission'
import { useInstructions } from '../../lib/queries'
import { Button, ErrorNote } from './Panel'

/** Instructions from the flight surgeon that the astronaut hasn't acknowledged yet (arrive live). */
export function InstructionsBanner({ code }: { code: string }) {
  const { data } = useInstructions(code)
  const queryClient = useQueryClient()
  const ack = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/instructions/{instruction_id}/acknowledge', { params: { path: { instruction_id: id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instructions', code] }),
  })
  const open = (data ?? []).filter((i) => !i.acknowledgedAt)
  if (open.length === 0) return null
  return (
    <section className="space-y-3 rounded-xl border-2 border-accent/70 bg-accent/10 p-4" aria-live="polite">
      {open.map((i) => (
        <div key={i.id} className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 font-semibold text-accent">
              <MessageSquareText className="h-5 w-5" aria-hidden /> Message from {i.fromName}
              <span className="text-xs font-normal text-ink-muted">· {timeAgo(i.createdAt)}</span>
            </p>
            <p className="mt-1 text-sm">{i.text}</p>
          </div>
          <Button onClick={() => ack.mutate(i.id)} disabled={ack.isPending}>Got it — acknowledge</Button>
        </div>
      ))}
      {ack.isError && <ErrorNote error={ack.error} />}
    </section>
  )
}
