import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.BASE_PATH || './',
  plugins: [
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        id: './',
        name: 'Tic Tac Toe',
        short_name: 'Tic Tac Toe',
        description: 'Play against T-3PO, pass the screen, or invite a friend.',
        start_url: './#from=tictactoe-app',
        scope: './',
        display: 'standalone',
        theme_color: '#131323',
        background_color: '#131323',
        related_applications: [{ platform: 'webapp', url: './manifest.webmanifest', id: './' }],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
