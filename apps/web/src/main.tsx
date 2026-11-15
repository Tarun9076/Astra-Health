import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import { router } from './app/router'
import { useAuth } from './lib/auth'
import './index.css'
import { initInstall } from './lib/install'
import { initTheme } from './lib/theme'

initTheme()
initInstall() // before rendering: the browser's install offer can arrive early

const DAY_MS = 24 * 60 * 60 * 1000
const CACHE_KEY = 'astra-cache'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, gcTime: DAY_MS, refetchOnWindowFocus: false } },
})

// Offline reads (LLD §12.6): the last successful screens are kept on this device for a day, so the
// app still shows them (with an "offline" banner) when the Habitat server can't be reached.
const storage = (() => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
})()
const persister = createSyncStoragePersister({ storage, key: CACHE_KEY })

// A shared tablet: signing out (or switching user) removes the previous person's cached health data.
useAuth.subscribe((state, prev) => {
  if (prev.user?.userId !== state.user?.userId) {
    queryClient.clear()
    storage?.removeItem(CACHE_KEY)
  }
})

registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: DAY_MS,
        buster: 'astra-v1',
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => q.state.status === 'success' && !String(q.queryKey[0]).startsWith('assistant'),
        },
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
)
