/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `base: './'` keeps asset URLs relative, so the built `dist/` folder works
// from any path on any static host (a sub-folder, GitHub Pages, a NAS share…).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'happy-dom',
  },
});
