import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

declare const process: { env: Record<string, string | undefined> };

// Chemins relatifs en production (VITE_BASE=./) : l'appli fonctionne aussi bien sous
// baziventillateur.github.io/CovoitGo/ que sur son propre domaine, à la racine.
const base = process.env.VITE_BASE ?? '/';

// Numéro de version (comme NexBim) : 1.<nombre de publications>, avec la date et les dernières
// nouveautés (titres des publications), lus dans l'historique git au moment du build.
function version() {
  const git = (cmd: string) => execSync(`git ${cmd}`, { encoding: 'utf-8' }).trim();
  try {
    const total = Number(git('rev-list --count HEAD'));
    const lines = git('log -15 --date=iso-strict --pretty=format:%cd%x09%s').split('\n');
    return {
      number: `1.${total}`,
      date: new Date().toISOString(),
      history: lines.map((line, i) => {
        const [date, ...title] = line.split('\t');
        return { number: `1.${total - i}`, date, title: title.join(' ') };
      }),
    };
  } catch {
    return { number: 'locale', date: new Date().toISOString(), history: [] };
  }
}

export default defineConfig({
  base,
  define: { __VERSION__: JSON.stringify(version()) },
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
