/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// `base: './'` keeps asset URLs relative, so the built `dist/` folder works
// from any path on any static host (a sub-folder, GitHub Pages, a NAS share…).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    // Installable app: a web manifest plus a service worker that caches Skim's own files, so it opens
    // instantly and offline. Requests to your RSS server are cross-origin and always go to the network.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['favicon.ico', 'logo.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: './',
        name: 'Skim',
        short_name: 'Skim',
        description: 'A fast reader for your Miniflux or Google Reader–compatible RSS server.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#FBFAF8',
        theme_color: '#FBFAF8',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'happy-dom',
  },
});
