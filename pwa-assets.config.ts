import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Icons for installing Skim as an app, drawn from public/logo.svg. Re-run with `npm run icons`.
const blue = { background: '#2F5BD3' };
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.1, resizeOptions: blue },
    apple: { ...minimal2023Preset.apple, padding: 0.1, resizeOptions: blue },
  },
  images: ['public/logo.svg'],
});
