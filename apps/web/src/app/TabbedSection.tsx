import { NavLink, Outlet } from 'react-router-dom'

/** A page with a title, one-line purpose and 2–3 tabs that are real routes (shareable, back button works). */
export function TabbedSection({ title, intro, tabs }: { title: string; intro: string; tabs: { to: string; label: string }[] }) {
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{intro}</p>
      </header>
      <nav aria-label={`${title} sections`} className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === ''}
            className={({ isActive }) =>
              `-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 px-4 text-sm font-medium transition-colors ${
                isActive ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:border-line-strong hover:text-ink'
              }`
            }>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
