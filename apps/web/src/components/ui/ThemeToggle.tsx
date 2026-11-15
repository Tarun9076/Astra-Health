import { Moon, Sun } from 'lucide-react'
import { setTheme, useTheme } from '../../lib/theme'

/** Header switch between Calm light and Mission dark. */
export function ThemeToggle() {
  const theme = useTheme()
  const dark = theme === 'dark'
  return (
    <button type="button" onClick={() => setTheme(dark ? 'light' : 'dark')} aria-pressed={dark}
      title={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-ink-muted hover:bg-subtle hover:text-ink">
      {dark ? <Moon className="h-5 w-5" aria-hidden /> : <Sun className="h-5 w-5" aria-hidden />}
      <span className="sr-only">Dark theme</span>
    </button>
  )
}
