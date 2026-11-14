// Offline outbox for writes (LLD §12.6, Step 9). If the Habitat server can't be reached, a write
// (daily check-in, task completion) is kept in IndexedDB and sent, in order, when it is back.
// The server is idempotent (client ids), so a write that did arrive but whose reply was lost is
// harmless to send again. Items belong to the user who made them and are only sent with their token.
import Dexie, { type Table } from 'dexie'
import { create } from 'zustand'
import { ApiError } from './api'
import { useAuth } from './auth'

interface OutboxItem {
  id?: number
  userId: string
  path: string
  body: unknown
  createdAt: string
  attempts: number
}

class OfflineDb extends Dexie {
  outbox!: Table<OutboxItem, number>

  constructor() {
    super('astra-offline')
    this.version(1).stores({ outbox: '++id, userId, createdAt' })
  }
}

const db = new OfflineDb()

export const useOutbox = create<{ pending: number; set: (n: number) => void }>((set) => ({
  pending: 0,
  set: (pending) => set({ pending }),
}))

async function refreshCount(): Promise<void> {
  const userId = useAuth.getState().user?.userId
  try {
    useOutbox.getState().set(userId ? await db.outbox.where('userId').equals(userId).count() : 0)
  } catch {
    useOutbox.getState().set(0) // IndexedDB unavailable (private window): nothing is queued
  }
}

class NetworkError extends Error {}

async function post(path: string, body: unknown): Promise<unknown> {
  const token = useAuth.getState().token
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  } catch {
    throw new NetworkError('offline')
  }
  // The dev proxy answers 502/503/504 when the Habitat server is down: treat as offline too.
  if ([502, 503, 504].includes(response.status)) throw new NetworkError(`HTTP ${response.status}`)
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail
    throw new ApiError(response.status, typeof detail === 'string' ? detail : 'Request failed')
  }
  return data
}

export type WriteResult<T> = { queued: false; data: T } | { queued: true }

/** Send now, or keep it on this device when the Habitat server is unreachable. */
export async function sendOrQueue<T>(path: string, body: unknown): Promise<WriteResult<T>> {
  try {
    return { queued: false, data: (await post(path, body)) as T }
  } catch (e) {
    const userId = useAuth.getState().user?.userId
    if (!(e instanceof NetworkError) || !userId) throw e
    await db.outbox.add({ userId, path, body, createdAt: new Date().toISOString(), attempts: 0 })
    await refreshCount()
    return { queued: true }
  }
}

let flushing = false

/** Send queued writes of the signed-in user, oldest first; stop at the first network failure. */
export async function flushOutbox(): Promise<number> {
  const userId = useAuth.getState().user?.userId
  if (flushing || !userId) return 0
  flushing = true
  let sent = 0
  try {
    const items = await db.outbox.where('userId').equals(userId).sortBy('id')
    for (const item of items) {
      try {
        await post(item.path, item.body)
      } catch (e) {
        if (e instanceof NetworkError) {
          await db.outbox.update(item.id!, { attempts: item.attempts + 1 })
          break
        }
        // the server rejected it (e.g. validation): it will never succeed, so drop it
      }
      await db.outbox.delete(item.id!)
      sent++
    }
  } catch {
    // IndexedDB unavailable
  } finally {
    flushing = false
    await refreshCount()
  }
  return sent
}

/** Flush on reconnect, every 15 s, and now. Returns a stop function. */
export function startOutboxSync(onSent: (count: number) => void): () => void {
  const run = () => void flushOutbox().then((n) => n > 0 && onSent(n))
  window.addEventListener('online', run)
  const timer = window.setInterval(run, 15_000)
  void refreshCount()
  run()
  return () => {
    window.removeEventListener('online', run)
    window.clearInterval(timer)
  }
}
