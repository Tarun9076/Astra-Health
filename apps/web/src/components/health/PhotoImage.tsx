import { useQuery } from '@tanstack/react-query'
import { ImageOff } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { routeUrl } from '../../lib/nodes'

/** A stored health photo. Images need the sign-in token, so they are fetched, not linked. */
export function PhotoImage({ code, id, alt, className = '' }: { code: string; id: string; alt: string; className?: string }) {
  const token = useAuth((s) => s.token)
  const { data: url, isError } = useQuery({
    queryKey: ['photo-image', code, id],
    queryFn: async () => {
      const response = await fetch(routeUrl(`/api/astronauts/${encodeURIComponent(code)}/photos/${encodeURIComponent(id)}/image`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) throw new ApiError(response.status, 'Photo not available')
      return URL.createObjectURL(await response.blob())
    },
    staleTime: Infinity,
    retry: false,
  })
  if (isError) {
    return (
      <p className="flex items-center gap-2 text-xs text-ink-muted">
        <ImageOff className="h-4 w-4" aria-hidden /> Photo not available here yet (it may still be on its way over the link).
      </p>
    )
  }
  if (!url) return <div className={`animate-pulse rounded-lg bg-subtle ${className}`} aria-hidden />
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block w-fit" title="Open full size">
      <img src={url} alt={alt} className={`rounded-lg border border-line object-cover ${className}`} />
    </a>
  )
}
