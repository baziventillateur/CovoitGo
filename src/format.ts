// datetime-local (heure locale) -> ISO UTC pour Postgres
export const toIso = (local: string) => new Date(local).toISOString();

export const fmt = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
