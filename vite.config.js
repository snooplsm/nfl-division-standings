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
      output: {
        manualChunks: undefined
      }
    }
  }
})
