// Live events from the Habitat node over WebSocket (LLD §14).
// The token goes in the query string because browsers can't set headers on WebSockets.
import { create } from 'zustand'
import { websocketPath } from './nodes'

export interface LiveEvent {
  type: string
  payload: Record<string, unknown>
  at?: string
}

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'off'

export const useLiveStatus = create<{ status: LiveStatus; set: (s: LiveStatus) => void }>((set) => ({
  status: 'off',
  set: (status) => set({ status }),
}))

const PING_MS = 25_000
const MAX_BACKOFF_MS = 30_000

export class RealtimeClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private closed = false
  private pingTimer: number | undefined
  private retryTimer: number | undefined
  private readonly token: string
  private readonly onEvent: (event: LiveEvent) => void

  constructor(token: string, onEvent: (event: LiveEvent) => void) {
    this.token = token
    this.onEvent = onEvent
  }

  connect(): void {
    const status = useLiveStatus.getState()
    status.set(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(`${liveOrigin()}${websocketPath()}?token=${encodeURIComponent(this.token)}`)
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      useLiveStatus.getState().set('live')
      this.pingTimer = window.setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), PING_MS)
    }
    ws.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as LiveEvent
        if (event.type !== 'pong') this.onEvent(event)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      window.clearInterval(this.pingTimer)
      if (this.closed) return
      useLiveStatus.getState().set('reconnecting')
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt++)
      this.retryTimer = window.setTimeout(() => this.connect(), delay)
    }
  }

  close(): void {
    this.closed = true
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.retryTimer)
    this.ws?.close()
    useLiveStatus.getState().set('off')
  }
}

/**
 * Where live updates connect. Same server as the page by default (dev server, or one server with
 * Caddy). When the app is hosted elsewhere (Vercel, which cannot forward WebSockets), the build sets
 * VITE_LIVE_ORIGIN to the backend server, e.g. wss://34-93-12-7.sslip.io.
 */
function liveOrigin(): string {
  const configured = (import.meta.env.VITE_LIVE_ORIGIN as string | undefined)?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
}
