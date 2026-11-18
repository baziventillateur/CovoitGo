export const fmt = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export const euros = (cents: number) => (cents / 100).toFixed(2).replace('.', ',') + ' €';

// Valeur par défaut d'un champ datetime-local : prochain quart d'heure, en heure locale.
export function nextQuarterLocal(): string {
  const d = new Date(Date.now() + 15 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  if (min < 1440) return `il y a ${Math.round(min / 60)} h`;
  return `il y a ${Math.round(min / 1440)} j`;
}

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

// Frais de service : 0,35 € + 5 %, arrondis à 5 centimes (même calcul que la base).
export const serviceFee = (cents: number) => (cents <= 0 ? 0 : Math.min(cents, Math.round((35 + 0.05 * cents) / 5) * 5));
