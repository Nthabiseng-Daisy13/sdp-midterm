import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API base is empty in production (same origin, served by FastAPI);
// in development the Vite dev server proxies /api to the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
