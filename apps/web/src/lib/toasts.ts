import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'attention' | 'urgent'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  body?: string
  href?: string
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }))
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), toast.tone === 'urgent' ? 15_000 : 8_000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
