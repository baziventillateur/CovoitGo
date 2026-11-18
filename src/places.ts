import { supabase } from './supabase';
import type { Place } from './geo';

// Adresses déjà validées et favoris. Gardés sur l'appareil, séparément pour chaque compte.
export type SavedPlace = Place & { fav: boolean; used: number };

const MAX_RECENT = 30;

async function storageKey(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session ? `covoitgo-adresses-${data.session.user.id}` : null;
}

function sort(list: SavedPlace[]): SavedPlace[] {
  // Favoris d'abord, puis les plus récemment utilisées.
  return [...list].sort((a, b) => Number(b.fav) - Number(a.fav) || b.used - a.used);
}

export async function loadPlaces(): Promise<SavedPlace[]> {
  try {
    const key = await storageKey();
    const raw = key && localStorage.getItem(key);
    return raw ? sort(JSON.parse(raw) as SavedPlace[]) : [];
  } catch {
    return [];
  }
}

async function save(list: SavedPlace[]): Promise<SavedPlace[]> {
  const sorted = sort(list);
  const favs = sorted.filter((p) => p.fav);
  const kept = [...favs, ...sorted.filter((p) => !p.fav).slice(0, MAX_RECENT)];
  try {
    const key = await storageKey();
    if (key) localStorage.setItem(key, JSON.stringify(kept));
  } catch {
    /* stockage plein ou indisponible : la liste vaut pour cette session */
  }
  return kept;
}

export async function rememberPlace(place: Place): Promise<SavedPlace[]> {
  const list = await loadPlaces();
  const known = list.find((p) => p.label === place.label);
  const rest = list.filter((p) => p.label !== place.label);
  return save([{ ...place, fav: known?.fav ?? false, used: Date.now() }, ...rest]);
}

export async function toggleFavorite(label: string): Promise<SavedPlace[]> {
  const list = await loadPlaces();
  return save(list.map((p) => (p.label === label ? { ...p, fav: !p.fav } : p)));
}

export async function forgetPlace(label: string): Promise<SavedPlace[]> {
  return save((await loadPlaces()).filter((p) => p.label !== label));
}
