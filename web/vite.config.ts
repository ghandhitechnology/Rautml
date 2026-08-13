import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const publicHost = process.env.RAU_PUBLIC_HOST?.trim()

/**
 * Vite injects an inline `type="module"` preamble for React refresh.
 * The app CSP's `'unsafe-inline'` does not cover module scripts, so the
 * preamble is blocked and every transformed file throws
 * "@vitejs/plugin-react can't detect preamble" — a white screen.
 * Production still ships the meta tag from index.html.
 */
function relaxCspInDev() {
  return {
    name: 'relax-csp-in-dev',
    transformIndexHtml(html: string) {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/i, '')
    },
  }
}

export default defineConfig({
  plugins: [react(), relaxCspInDev()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT) || 5174,
    strictPort: true,
    allowedHosts: publicHost ? [publicHost] : [],
    hmr: publicHost
      ? {
          overlay: true,
          protocol: 'wss',
          host: publicHost,
          clientPort: Number(process.env.RAU_PUBLIC_PORT) || 443,
        }
      : { overlay: true },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number(process.env.API_PORT) || 5175}`,
        headers: publicHost ? { 'X-Forwarded-Proto': 'https' } : undefined,
      },
    },
  },
})
