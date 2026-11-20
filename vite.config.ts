import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

declare const process: { env: Record<string, string | undefined> };

// Chemins relatifs en production (VITE_BASE=./) : l'appli fonctionne aussi bien sous
// baziventillateur.github.io/CovoitGo/ que sur son propre domaine, à la racine.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Enregistré à la main dans main.tsx, pour vérifier les mises à jour au retour dans l'appli.
      injectRegister: false,
      includeAssets: ['icon.svg', 'icon-192.png', 'apple-touch-icon.png', 'favicon-v2.ico', 'favicon-v2.svg', 'favicon-v2-32.png', 'favicon-v2-16.png', 'push-sw.js'],
      // La page du support est une vraie page à part : le service worker ne doit pas la remplacer par l'appli.
      workbox: { navigateFallbackDenylist: [/support\.html/], importScripts: ['push-sw.js'] },
      manifest: {
        name: 'CovoitGo by PaceApp',
        short_name: 'CovoitGo',
        description: 'Covoiturage du quotidien',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
});
