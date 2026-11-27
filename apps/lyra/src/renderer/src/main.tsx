// The interface system's three faces, bundled so nothing is fetched at runtime (all SIL OFL).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/400-italic.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource-variable/literata/opsz.css'
import '@fontsource-variable/literata/opsz-italic.css'
import './assets/app.css'
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Overlay } from './components/Overlay'
import { applyDensity } from './lib/density'
import { log } from './lib/log'

// The overlay window shares this bundle; loading the app on demand keeps the editor and search
// out of the small floating pill.
const App = lazy(() => import('./App'))

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

// Errors outside React's render (event handlers, timers, promises) would otherwise only reach
// the devtools console. The message and where it came from; never the arguments or note text.
window.addEventListener('error', (event) => {
  log('ui', 'uncaught error', {
    message: event.message,
    source: event.filename ? `${event.filename.split('/').pop() ?? ''}:${String(event.lineno)}` : null
  })
})
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  log('ui', 'unhandled rejection', {
    name: reason instanceof Error ? reason.name : typeof reason,
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

// The same bundle renders the floating recording pill in its own window.
const isOverlay = window.location.hash === '#overlay'
if (isOverlay) document.documentElement.classList.add('is-overlay')
// Platform conventions that reach portaled layers too (dialog button order).
document.documentElement.dataset.platform = window.api.platform
applyDensity()

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary scope={isOverlay ? 'overlay' : 'app'}>
      {isOverlay ? (
        <Overlay />
      ) : (
        <Suspense fallback={null}>
          <App />
        </Suspense>
      )}
    </ErrorBoundary>
  </StrictMode>
)
