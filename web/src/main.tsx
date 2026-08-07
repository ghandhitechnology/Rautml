import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import App from './App'
import { initTheme, useStore } from './state/store'
import './theme/fonts.css'
import './theme/tokens.css'
import 'katex/dist/katex.min.css'

// Stamp [data-theme] before React paints so there is no flash of the wrong palette.
// (index.html's inline boot script already stamped it ahead of this bundle.)
useStore.setState({ theme: initTheme() })

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    {/* Honour prefers-reduced-motion app-wide: framer animations collapse to
        their end state when the user asks for less motion. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
)
