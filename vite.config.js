import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    headers: {
      'Cache-Control': 'no-store'
    }
  },
  preview: {
    headers: {
      'Cache-Control': 'public, max-age=600'
    }
  },
  build: {
    cssCodeSplit: false,
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        retard: resolve(__dirname, 'retard/index.html')
      },
      output: {
        manualChunks: undefined
      }
    }
  }
})
