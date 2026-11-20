import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-semi-condensed/700.css';
import './index.css';

// Une appli installée reste souvent ouverte en arrière-plan sans jamais être rechargée : on vérifie
// les mises à jour à chaque retour dans l'appli (au plus toutes les 5 min) et toutes les heures.
// Une nouvelle version s'installe puis recharge la page d'elle-même.
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    let last = Date.now();
    const check = () => {
      if (!navigator.onLine || Date.now() - last < 5 * 60_000) return;
      last = Date.now();
      reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    setInterval(() => {
      last = 0;
      check();
    }, 60 * 60_000);
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
