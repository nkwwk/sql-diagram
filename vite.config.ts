import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves project sites from /<repo>/; CI sets BASE_PATH accordingly.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
})
