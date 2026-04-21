import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Rewrite /reference-app/session/* to index.html so the SPA handles routing. */
function spaFallback(): Plugin {
  return {
    name: 'spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/reference-app\/session\//.test(req.url)) {
          req.url = '/reference-app/'
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), spaFallback()],
  base: '/reference-app/',
  optimizeDeps: {
    exclude: ['@derec-alliance/web'],
  },
  server: {
    fs: {
      allow: ['..', '../../../lib-derec'],
    },
  },
})
