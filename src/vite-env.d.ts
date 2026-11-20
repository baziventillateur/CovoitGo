/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Version de l'appli, calculée au build (voir vite.config.ts).
declare const __VERSION__: {
  number: string;
  date: string;
  history: { number: string; date: string; title: string }[];
};
