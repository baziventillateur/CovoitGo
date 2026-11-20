import type { Listing, Match, Mode } from './api';

// Une « proposition » (conducteur) ou une « demande » (passager) : ce qui a été publié d'un coup.
// Un aller-retour forme une seule proposition ; une série récurrente aussi. On n'en montre que la
// prochaine date de l'aller et la prochaine date du retour : le reste est replié.
export type Leg = { next: Listing | null; upcoming: Listing[] };
export type Offer = {
  key: string;
  round: boolean;
  recurring: boolean;
  aller: Leg;
  retour: Leg | null;
  upcoming: Listing[];
};

const time = (iso: string) => new Date(iso).getTime();

export function groupOffers(list: Listing[], now = Date.now()): Offer[] {
  const groups = new Map<string, Listing[]>();
  for (const l of list) {
    const key = l.round_id ?? l.series_id ?? l.id;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const offers: Offer[] = [];
  for (const [key, items] of groups) {
    const upcoming = items.filter((l) => time(l.window_end) > now).sort((a, b) => time(a.window_start) - time(b.window_start));
    if (!upcoming.length) continue;
    const leg = (ret: boolean): Leg => {
      const u = upcoming.filter((l) => !!l.is_return === ret);
      return { next: u[0] ?? null, upcoming: u };
    };
    const aller = leg(false);
    const retour = leg(true);
    const round = aller.upcoming.length > 0 && retour.upcoming.length > 0;
    offers.push({
      key,
      round,
      recurring: items.some((l) => !!l.series_id),
      // Il ne reste qu'un sens (l'autre a été supprimé) : il s'affiche seul.
      aller: round ? aller : { next: upcoming[0], upcoming },
      retour: round ? retour : null,
      upcoming,
    });
  }
  return offers.sort((a, b) => time(a.upcoming[0].window_start) - time(b.upcoming[0].window_start));
}

// La prochaine date de chaque sens, plus les dates où il se passe quelque chose : ce sont les seules
// où l'appli cherche des passagers (ou des conducteurs).
export function shownIds(offers: Offer[], busy: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const o of offers) {
    if (o.aller.next) ids.add(o.aller.next.id);
    if (o.retour?.next) ids.add(o.retour.next.id);
    for (const l of o.upcoming) if (busy.has(l.id)) ids.add(l.id);
  }
  return ids;
}

export const listingOf = (m: Match, mode: Mode) => (mode === 'driver' ? m.trip_id : m.request_id);

export function busyListings(all: Match[], mode: Mode) {
  return new Set(
    all.filter((m) => m.role === mode && (m.status === 'proposed' || m.status === 'accepted')).map((m) => listingOf(m, mode)),
  );
}

// « lun – ven jusqu'au 16 déc. » pour une série récurrente.
const DAYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
export function recurrenceLabel(dates: Listing[]): string {
  if (!dates.length) return '';
  const days = [...new Set(dates.map((l) => new Date(l.window_start).getDay()))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const order = days.map((d) => (d + 6) % 7);
  const contiguous = order.length > 2 && order.every((d, i) => i === 0 || d === order[i - 1] + 1);
  const label = contiguous ? `${DAYS[days[0]]} – ${DAYS[days[days.length - 1]]}` : days.map((d) => DAYS[d]).join(', ');
  const last = new Date(dates[dates.length - 1].window_start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `${label} jusqu’au ${last}`;
}

export const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
