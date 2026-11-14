// Emergency procedures bundled into the web app at build time (from protocols/emergency/*.md),
// so the steps still show if the Habitat backend is unreachable (LLD §11, Step 7).

export interface EmergencyProtocol {
  id: string
  title: string
  disclaimer: string
  body: string
}

const files = import.meta.glob('../../../../protocols/emergency/EMG-*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function parse(raw: string): EmergencyProtocol | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!match) return null
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(match[1])?.[1].trim() ?? ''
  const id = field('id')
  return id ? { id, title: field('title'), disclaimer: field('disclaimer'), body: match[2].trim() } : null
}

export const EMERGENCY_PROTOCOLS: Record<string, EmergencyProtocol> = Object.fromEntries(
  Object.values(files)
    .map(parse)
    .filter((p): p is EmergencyProtocol => p !== null)
    .map((p) => [p.id, p]),
)
