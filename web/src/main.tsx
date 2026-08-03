import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initTheme, useStore } from './state/store'
import './theme/fonts.css'
import './theme/tokens.css'
import 'katex/dist/katex.min.css'

// Stamp [data-theme] before React paints so there is no flash of the wrong palette.
useStore.setState({ theme: initTheme() })

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
