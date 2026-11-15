/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// `base: './'` keeps asset URLs relative, so the built `dist/` folder works
// from any path on any static host (a sub-folder, GitHub Pages, a NAS share…).
// Identifies this build; the service worker is registered as sw.js?v=<id> (see main.tsx).
const buildId = (process.env.GITHUB_SHA ?? Date.now().toString(36)).slice(0, 12);

export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    tailwindcss(),
    // Installable app: a web manifest plus a service worker that caches Skim's own files, so it opens
    // instantly and offline. Requests to your RSS server are cross-origin and always go to the network.
    VitePWA({
      registerType: 'autoUpdate',
      // Registered in main.tsx with the build id in the URL: GitHub Pages' CDN can keep serving an old
      // sw.js for hours, and a new URL per deploy means it can't hold an update back.
      injectRegister: false,
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
        // The page itself isn't precached: it's loaded network-first below, so an online visit always
        // gets the latest deploy and the cached copy is only used offline. Scripts, styles and icons
        // are precached (their names change with every build).
        globPatterns: ['**/*.{js,css,svg,png,ico}'],
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: { cacheName: 'skim-pages', networkTimeoutSeconds: 4 },
          },
        ],
        cleanupOutdatedCaches: true,
        // A new version takes over as soon as it's installed; with network-first pages nothing is left stale.
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  test: {
    environment: 'happy-dom',
  },
});
