import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT) || 5174,
    proxy: {
      '/api': {
        target: `http://localhost:${Number(process.env.API_PORT) || 5175}`,
        changeOrigin: true,
      },
    },
  },
})
