import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { fetchRoute } from './geo';

const TILES =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2' +
  '&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

type Props = { tripId: string; requestId: string; name: string; onClose: () => void };

// Carte pour le conducteur : d'où part le passager (A), où il va (B), son cheminement,
// le tracé du conducteur en pointillé et sa position actuelle.
export function RouteMap({ tripId, requestId, name, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('Chargement de la carte…');

  useEffect(() => {
    let map: import('leaflet').Map | undefined;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('request_map', { p_trip_id: tripId, p_request_id: requestId });
      const p = data?.[0];
      if (error || !p) return setNote(error?.message ?? 'Carte indisponible');
      const L = (await import('leaflet')).default;
      await import('leaflet/dist/leaflet.css');
      if (cancelled || !box.current) return;

      const a: [number, number] = [p.a_lat, p.a_lng];
      const b: [number, number] = [p.b_lat, p.b_lng];
      map = L.map(box.current, { zoomControl: false });
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.tileLayer(TILES, { maxZoom: 19, attribution: '© IGN' }).addTo(map);
      map.fitBounds(L.latLngBounds([a, b]).pad(0.25));

      // Tracé du conducteur, discret.
      if (p.trip_route) {
        try {
          const line = (JSON.parse(p.trip_route).coordinates as [number, number][]).map(([x, y]) => [y, x] as [number, number]);
          L.polyline(line, { color: '#64748b', weight: 3, opacity: 0.7, dashArray: '6 7' }).addTo(map);
        } catch {
          /* tracé illisible : la carte reste utilisable */
        }
      }
      // Points du passager : exacts une fois en relation, sinon une zone d'environ 400 m.
      const mark = (at: [number, number], color: string, letter: string) => {
        if (!p.exact) L.circle(at, { radius: 400, color, weight: 1, fillColor: color, fillOpacity: 0.18 }).addTo(map!);
        L.marker(at, {
          icon: L.divIcon({ className: '', html: `<span class="map-pin" style="background:${color}">${letter}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).addTo(map!);
      };
      mark(a, '#16a34a', 'A');
      mark(b, '#dc2626', 'B');
      setNote(p.exact ? '' : 'Positions approximatives : l’adresse précise s’affiche une fois la proposition faite.');

      // Cheminement du passager de A à B.
      fetchRoute({ label: '', lng: p.a_lng, lat: p.a_lat }, { label: '', lng: p.b_lng, lat: p.b_lat }).then((r) => {
        if (cancelled || !map || !r) return;
        const line = (JSON.parse(r.geojson).coordinates as [number, number][]).map(([x, y]) => [y, x] as [number, number]);
        L.polyline(line, { color: '#4f46e5', weight: 5, opacity: 0.85 }).addTo(map);
      });

      navigator.geolocation?.getCurrentPosition(
        (pos) => {
          if (cancelled || !map) return;
          L.circleMarker([pos.coords.latitude, pos.coords.longitude], { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
        },
        () => {},
        { timeout: 8000, maximumAge: 60_000 },
      );
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [tripId, requestId]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet map-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Trajet de {name}</h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        <div ref={box} className="route-map" />
        <small className="map-legend">
          <span className="map-pin" style={{ background: '#16a34a' }}>A</span> montée
          <span className="map-pin" style={{ background: '#dc2626' }}>B</span> dépose
          <i className="leg-line pass" /> son trajet <i className="leg-line mine" /> ta route <i className="leg-dot" /> toi
        </small>
        {note && <small className="money-note">{note}</small>}
      </div>
    </div>
  );
}
