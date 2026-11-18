import { useEffect, useRef, useState } from 'react';
import { reverseGeocode, type Place } from './geo';

// Fond de carte public de l'IGN (Plan IGN), sans clé ni compte.
const TILES =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2' +
  '&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

type Props = { title: string; initial: Place | null; onPick: (place: Place) => void; onClose: () => void };

// Choix d'un point sur la carte : elle s'ouvre sur la position du téléphone,
// puis on la fait glisser sous l'épingle centrale pour ajuster.
export function MapPicker({ title, initial, onPick, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [center, setCenter] = useState<{ lng: number; lat: number } | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [hint, setHint] = useState('Recherche de ta position…');

  useEffect(() => {
    let map: import('leaflet').Map | undefined;
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      await import('leaflet/dist/leaflet.css');
      if (cancelled || !box.current) return;
      map = L.map(box.current, { zoomControl: false }).setView(initial ? [initial.lat, initial.lng] : [48.8566, 2.3522], initial ? 17 : 11);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.tileLayer(TILES, { maxZoom: 19, attribution: '© IGN' }).addTo(map);
      const report = () => {
        const c = map!.getCenter();
        setCenter({ lng: c.lng, lat: c.lat });
      };
      map.on('moveend', report);
      report();

      if (initial) return setHint('Fais glisser la carte pour ajuster le point.');
      if (!navigator.geolocation) return setHint('Position indisponible sur cet appareil : place le point à la main.');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled || !map) return;
          const here: [number, number] = [pos.coords.latitude, pos.coords.longitude];
          // Pastille bleue : la position réelle, qui reste visible quand on déplace le point.
          L.circleMarker(here, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
          map.setView(here, 17);
          setHint('Te voilà. Fais glisser la carte pour ajuster le point.');
        },
        () => setHint('Position refusée ou introuvable : place le point à la main.'),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
      );
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [initial]);

  // Adresse du point sous l'épingle, recherchée une fois la carte immobile.
  useEffect(() => {
    if (!center) return;
    setLabel(null);
    const t = window.setTimeout(() => {
      reverseGeocode(center.lng, center.lat).then((found) =>
        setLabel(found ?? `Point choisi (${center.lat.toFixed(4)}, ${center.lng.toFixed(4)})`),
      );
    }, 450);
    return () => window.clearTimeout(t);
  }, [center]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet map-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        <div className="map-box">
          <div ref={box} className="map" />
          <div className="map-pin" aria-hidden="true">
            📍
          </div>
        </div>
        <small>{hint}</small>
        <p className="map-label">{label ?? 'Recherche de l’adresse…'}</p>
        <button
          type="button"
          className="primary big"
          disabled={!center || !label}
          onClick={() => center && label && onPick({ label, lng: center.lng, lat: center.lat })}
        >
          Valider ce point
        </button>
      </div>
    </div>
  );
}
