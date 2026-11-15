// Light ("Calm light") or dark ("Mission dark") theme (Step 14). Until the user chooses, the app follows
// the device setting. The choice is kept on this device only. index.html applies it before the first
// paint, so the page never flashes the wrong colours.
import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'
const KEY = 'astra-theme'
const listeners = new Set<() => void>()

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

function deviceTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function currentTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme | undefined) ?? stored() ?? deviceTheme()
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* private window: not remembered */
  }
  listeners.forEach((l) => l())
}

/** Applies the stored or device theme and keeps following the device until the user chooses. */
export function initTheme(): void {
  document.documentElement.dataset.theme = stored() ?? deviceTheme()
  matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!stored()) {
      document.documentElement.dataset.theme = deviceTheme()
      listeners.forEach((l) => l())
    }
  })
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    currentTheme,
    () => 'light',
  )
}
