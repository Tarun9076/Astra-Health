import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import type { components } from './api-types'

type Me = components['schemas']['MeOut']

interface AuthState {
  token: string | null
  user: Me | null
  signIn: (token: string, user: Me) => void
  signOut: () => void
}

// localStorage can be unavailable (private windows, blocked storage); fall back to memory.
const memory = new Map<string, string>()
const safeStorage: StateStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return memory.get(key) ?? null
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      memory.set(key, value)
    }
  },
  removeItem: (key) => {
    try {
      window.localStorage.removeItem(key)
    } catch {
      memory.delete(key)
    }
  },
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      signIn: (token, user) => set({ token, user }),
      signOut: () => set({ token: null, user: null }),
    }),
    { name: 'astra-auth', storage: createJSONStorage(() => safeStorage) },
  ),
)

export function homeFor(user: Me | null): string {
  if (!user) return '/login'
  return user.role === 'Astronaut' ? '/astronaut/overview' : '/staff'
}
