// Adresses et itinéraires via les services publics de l'IGN (Géoplateforme).

export type Place = { label: string; lng: number; lat: number };

export async function searchPlaces(query: string): Promise<Place[]> {
  if (query.trim().length < 3) return [];
  const res = await fetch(
    `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(query)}&limit=5`,
  );
  if (!res.ok) throw new Error("Recherche d'adresse indisponible pour le moment");
  const json = await res.json();
  return (json.features ?? []).map((f: any) => ({
    label: f.properties.label as string,
    lng: f.geometry.coordinates[0] as number,
    lat: f.geometry.coordinates[1] as number,
  }));
}

export type Route = { geojson: string; minutes: number | null };

// Tracé du trajet (GeoJSON LineString) et durée de conduite, ou null : dans ce cas
// la base prend la ligne droite entre le départ et l'arrivée et estime la durée.
export async function fetchRoute(a: Place, b: Place): Promise<Route | null> {
  try {
    const url =
      'https://data.geopf.fr/navigation/itineraire' +
      `?resource=bdtopo-osrm&start=${a.lng},${a.lat}&end=${b.lng},${b.lat}` +
      '&profile=car&geometryFormat=geojson&getSteps=false';
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const geometry = json.geometry ?? json.routes?.[0]?.geometry;
    if (geometry?.type !== 'LineString') return null;
    // La durée est exprimée dans l'unité annoncée par le service ; sans unité claire, on s'en passe.
    const raw = Number(json.duration);
    const perMinute: Record<string, number> = { minute: 1, second: 1 / 60, hour: 60 };
    const factor = perMinute[String(json.timeUnit)];
    const minutes = Number.isFinite(raw) && raw > 0 && factor ? Math.round(raw * factor) : null;
    return { geojson: JSON.stringify(geometry), minutes };
  } catch {
    return null;
  }
}

// Adresse la plus proche d'un point (pour la position choisie sur la carte).
export async function reverseGeocode(lng: number, lat: number): Promise<string | null> {
  try {
    const res = await fetch(`https://data.geopf.fr/geocodage/reverse?lon=${lng}&lat=${lat}&limit=1`);
    if (!res.ok) return null;
    const json = await res.json();
    return (json.features?.[0]?.properties?.label as string | undefined) ?? null;
  } catch {
    return null;
  }
}
