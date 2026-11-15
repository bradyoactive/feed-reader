import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker that makes Skim installable and work offline. A new URL per deploy makes
// the browser pick up each new version even while a CDN still caches the previous sw.js.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`./sw.js?v=${__BUILD_ID__}`, { scope: './' }).catch(() => {});
  });
}
