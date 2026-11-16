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

// Renvoie le tracé en GeoJSON (LineString) ou null : dans ce cas la base
// prend la ligne droite entre le départ et l'arrivée.
export async function routeGeoJSON(a: Place, b: Place): Promise<string | null> {
  try {
    const url =
      'https://data.geopf.fr/navigation/itineraire' +
      `?resource=bdtopo-osrm&start=${a.lng},${a.lat}&end=${b.lng},${b.lat}` +
      '&profile=car&geometryFormat=geojson&getSteps=false';
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const geometry = json.geometry ?? json.routes?.[0]?.geometry;
    return geometry?.type === 'LineString' ? JSON.stringify(geometry) : null;
  } catch {
    return null;
  }
}
