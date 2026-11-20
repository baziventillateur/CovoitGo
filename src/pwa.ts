// Mises à jour de l'appli installée. Le service worker se met à jour de lui-même (main.tsx) ;
// ici, la vérification à la demande depuis la fenêtre des versions.
let registration: ServiceWorkerRegistration | undefined;
export const setRegistration = (r: ServiceWorkerRegistration) => {
  registration = r;
};

// Le script principal de la page affichée, comparé à celui de la page publiée.
const current = [...document.querySelectorAll<HTMLScriptElement>('script[type=module][src]')]
  .map((s) => s.getAttribute('src') ?? '')
  .find((src) => /assets\/index-/.test(src));

export async function newVersionOnline(): Promise<boolean> {
  if (!current) return false;
  const page = await fetch(`./?v=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
  const published = page.match(/assets\/index-[^"']+\.js/)?.[0];
  return !!published && !current.endsWith(published);
}

// Installe la nouvelle version : le service worker la récupère puis la page se recharge.
export async function installUpdate() {
  try {
    await registration?.update();
  } catch {
    /* hors ligne : rechargement simple */
  }
  window.setTimeout(() => window.location.reload(), 3500);
}
