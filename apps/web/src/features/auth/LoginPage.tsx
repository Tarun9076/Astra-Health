import { useMutation } from '@tanstack/react-query'
import { LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Button, ErrorNote } from '../../components/ui/Panel'
import { api, unwrap } from '../../lib/api'
import { homeFor, useAuth } from '../../lib/auth'

// Local demo accounts from services/backend/seed.example.json (never real credentials).
const DEMO = [
  { username: 'ast1', password: 'astra-demo-ast1', label: 'Astronaut AST-001 (fatigue story)' },
  { username: 'ast3', password: 'astra-demo-ast3', label: 'Astronaut AST-003' },
  { username: 'surgeon1', password: 'astra-demo-surgeon', label: 'Flight surgeon' },
]

export function LoginPage() {
  const { token, user, signIn } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const login = useMutation({
    mutationFn: (creds: { username: string; password: string }) => unwrap(api.POST('/api/auth/login', { body: creds })),
    onSuccess: (data) => {
      signIn(data.accessToken, data.user)
      navigate(homeFor(data.user), { replace: true })
    },
  })

  if (token && user) return <Navigate to={homeFor(user)} replace />

  const submit = (e: FormEvent) => {
    e.preventDefault()
    login.mutate({ username: username.trim(), password })
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <p className="text-2xl font-bold tracking-[0.3em] text-accent">ASTRA HEALTH</p>
          <p className="mt-1 text-xs tracking-[0.2em] text-ink-muted uppercase">Crew health intelligence · ARES-1</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-6">
          <label className="block text-sm">
            <span className="text-ink-muted">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              className="mt-1 block min-h-12 w-full rounded-lg border border-line-strong bg-surface px-3 text-base outline-none focus:border-accent"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-muted">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="mt-1 block min-h-12 w-full rounded-lg border border-line-strong bg-surface px-3 text-base outline-none focus:border-accent"
            />
          </label>
          {login.isError && <ErrorNote error={login.error} />}
          <Button type="submit" className="w-full" disabled={login.isPending}>
            <LogIn className="h-4 w-4" aria-hidden /> {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <div className="rounded-xl border border-dashed border-line-strong p-4 text-sm">
          <p className="mb-2 text-xs tracking-wider text-ink-muted uppercase">Demo accounts (simulated data)</p>
          <div className="space-y-1">
            {DEMO.map((d) => (
              <button
                key={d.username}
                type="button"
                onClick={() => login.mutate({ username: d.username, password: d.password })}
                className="flex min-h-10 w-full items-center justify-between rounded-lg px-2 text-left hover:bg-subtle"
              >
                <span>{d.label}</span>
                <span className="font-mono text-xs text-accent">{d.username}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
