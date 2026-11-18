import { useEffect, useState } from 'react';
import { api } from './api';

const KEY = 'covoitgo-approche';

// Chauffeur en route : s'il le veut, sa position sert à prévenir le passager quand il approche.
// La position n'est pas enregistrée : le serveur ne garde que la distance au rendez-vous.
export function Approach({ matchId, name }: { matchId: string; name: string }) {
  const [on, setOn] = useState(() => localStorage.getItem(KEY) === '1');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!on || !('geolocation' in navigator)) return;
    let last = 0;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        if (Date.now() - last < 20_000) return;
        last = Date.now();
        api.driverPing(matchId, pos.coords.longitude, pos.coords.latitude).catch(() => {});
      },
      () => {
        setError('Position indisponible : autorise la localisation pour ce site.');
        setOn(false);
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [on, matchId]);

  if (!('geolocation' in navigator)) return null;
  return (
    <div className="approach">
      {on ? (
        <small>
          📍 {name} sera prévenu à ton approche. Garde l’appli ouverte.{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              localStorage.removeItem(KEY);
              setOn(false);
            }}
          >
            Arrêter
          </button>
        </small>
      ) : (
        <button
          type="button"
          className="chip"
          onClick={() => {
            localStorage.setItem(KEY, '1');
            setError('');
            setOn(true);
          }}
        >
          📍 Prévenir {name} à mon approche
        </button>
      )}
      {error && <small className="error">{error}</small>}
    </div>
  );
}
