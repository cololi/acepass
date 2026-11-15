import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './styles/app.css'
import { AppRoot } from './app/AppRoot'
import { ensureThemeRuntime } from './app/theme'

// `katex/dist/katex.min.css` is intentionally NOT imported here: it is fetched
// together with the KaTeX renderer the first time a formula is rendered (see
// src/components/Content.tsx), so the first screen never pays for it.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
})

// Mark the standalone document so the panel's reset rules apply here and only
// here: inside DSH the shell owns <body>.
document.documentElement.setAttribute('data-acepass-standalone', '')
ensureThemeRuntime()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="acepass-root">
          <AppRoot />
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
