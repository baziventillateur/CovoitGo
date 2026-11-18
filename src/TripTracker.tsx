import { useEffect, useState } from 'react';
import type { Match } from './api';
import { fmtTime } from './format';

const X0 = 26; // départ du chauffeur
const XP = 118; // point de rendez-vous
const XD = 292; // arrivée
const Y = 50; // hauteur de la route

function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

function Head({ x, y, name, soft }: { x: number; y: number; name: string; soft?: boolean }) {
  return (
    <g>
      <circle cx={x} cy={y} r="9" fill={soft ? '#fff' : 'var(--brand-soft)'} stroke="var(--brand)" strokeWidth="1.5" />
      <text x={x} y={y + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--brand-dark)">
        {name.charAt(0).toUpperCase()}
      </text>
    </g>
  );
}

// Suivi animé du trajet. Sans GPS : la voiture avance selon le temps écoulé depuis
// la dernière étape validée par le chauffeur, au prorata de la durée estimée.
export function TripTracker({ m, meName }: { m: Match; meName: string }) {
  const now = useNow(4000);
  const driver = m.role === 'driver';
  const driverName = driver ? meName || '?' : m.other_name;
  const passengerName = driver ? m.other_name : meName || '?';
  const start = new Date(m.updated_at).getTime();
  const elapsed = Math.max(0, (now - start) / 60_000);
  const total = m.ride_minutes ?? 20;

  let x = X0;
  let moving = false;
  let aboard = false;
  let caption = `Départ prévu vers ${fmtTime(m.meet_at)}`;

  if (m.stage === 'driver_en_route') {
    // Distance d'approche inconnue : progression douce, qui ralentit sans jamais « arriver » seule.
    x = X0 + (XP - 28 - X0) * Math.min(0.92, 1 - Math.exp(-elapsed / 6));
    moving = true;
    caption = driver ? 'En route vers le rendez-vous' : `${driverName} est en route · position estimée`;
  } else if (m.stage === 'driver_arrived' || m.stage === 'on_board') {
    const p = Math.min(1, elapsed / total);
    x = XP + (XD - 26 - XP) * p;
    aboard = true;
    moving = p < 1;
    const left = Math.ceil(total - elapsed);
    caption = p < 1 ? `Arrivée estimée vers ${fmtTime(new Date(start + total * 60_000).toISOString())} · ≈ ${left} min` : 'Arrivée imminente';
  }

  return (
    <div className="tracker">
      <svg viewBox="0 0 320 78" role="img" aria-label={caption}>
        <line x1={X0} y1={Y} x2={XD} y2={Y} stroke="#cbd5e1" strokeWidth="7" strokeLinecap="round" />
        <line x1={X0} y1={Y} x2={x} y2={Y} stroke="var(--brand)" strokeWidth="7" strokeLinecap="round" className="track-done" />
        <line x1={X0} y1={Y} x2={XD} y2={Y} stroke="#fff" strokeWidth="1.2" strokeDasharray="6 7" />

        {[X0, XP, XD].map((px) => (
          <circle key={px} cx={px} cy={Y} r="4.5" fill="#fff" stroke="var(--brand)" strokeWidth="2" />
        ))}
        <text x={X0} y={Y + 20} textAnchor="middle" className="track-label">Départ</text>
        <text x={XP} y={Y + 20} textAnchor="middle" className="track-label">Rendez-vous</text>
        <text x={XD} y={Y + 20} textAnchor="end" className="track-label">Arrivée</text>
        <text x={XD} y={Y - 12} textAnchor="middle" fontSize="15">🏁</text>

        {!aboard && <Head x={XP} y={Y - 19} name={passengerName} soft />}

        <g className="car-move" style={{ transform: `translateX(${x}px)` }}>
          <g className={moving ? 'car jit' : 'car'}>
            <Head x={aboard ? -7 : 0} y={Y - 34} name={driverName} />
            {aboard && <Head x={11} y={Y - 34} name={passengerName} soft />}
            <path d={`M-17 ${Y - 7} v-7 q0 -3 3 -3 h4 l4 -6 h11 l5 6 h4 q3 0 3 3 v7 z`} fill="var(--brand)" />
            <path d={`M-4.5 ${Y - 17.5} l3 -4.2 h7 l3.4 4.2 z`} fill="#fff" opacity="0.85" />
            <circle cx="-9" cy={Y - 6} r="4" fill="#0f172a" />
            <circle cx="9" cy={Y - 6} r="4" fill="#0f172a" />
            <circle cx="-9" cy={Y - 6} r="1.5" fill="#fff" />
            <circle cx="9" cy={Y - 6} r="1.5" fill="#fff" />
          </g>
        </g>
      </svg>
      <small className="track-caption">
        {aboard && moving && <span className="mini-spin" />}
        {caption}
      </small>
    </div>
  );
}
