import { useState, type FormEvent } from 'react';
import { supabase } from './supabase';
import { PlaceInput } from './PlaceInput';
import { routeGeoJSON, type Place } from './geo';
import { fmt, toIso } from './format';

type Row = Record<string, any>;

export function Trips() {
  return (
    <>
      <Driver />
      <Passenger />
    </>
  );
}

function Driver() {
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [seats, setSeats] = useState(3);
  const [share, setShare] = useState(0);
  const [tripId, setTripId] = useState<string | null>(null);
  const [passengers, setPassengers] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPassengers(id: string) {
    const { data, error } = await supabase.rpc('find_requests_for_trip', { p_trip_id: id, p_radius_m: 1000 });
    if (error) setMsg(error.message);
    else setPassengers(data ?? []);
  }

  async function publish(e: FormEvent) {
    e.preventDefault();
    if (!from || !to) return setMsg('Choisis les adresses dans la liste.');
    setBusy(true);
    setMsg(null);
    const route = await routeGeoJSON(from, to);
    const { data, error } = await supabase.rpc('publish_trip', {
      p_origin_label: from.label,
      p_origin_lng: from.lng,
      p_origin_lat: from.lat,
      p_dest_label: to.label,
      p_dest_lng: to.lng,
      p_dest_lat: to.lat,
      p_window_start: toIso(start),
      p_window_end: toIso(end),
      p_seats: seats,
      p_cost_share_cents: Math.round(share * 100),
      p_route_geojson: route,
    });
    if (error) {
      setMsg(error.message);
    } else {
      setTripId(data as string);
      setMsg('Trajet publié. Voici les passagers compatibles.');
      await loadPassengers(data as string);
    }
    setBusy(false);
  }

  async function invite(requestId: string) {
    if (!tripId) return;
    const { error } = await supabase.rpc('propose_match', { p_trip_id: tripId, p_request_id: requestId });
    setMsg(error ? error.message : 'Proposition envoyée. Suis-la dans « Mes trajets ».');
  }

  return (
    <section>
      <h2>Je conduis</h2>
      <form onSubmit={publish}>
        <PlaceInput label="Départ" value={from} onChange={setFrom} />
        <PlaceInput label="Arrivée" value={to} onChange={setTo} />
        <label>
          Je pars entre
          <input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          … et
          <input type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label>
          Places libres
          <input type="number" min={1} max={6} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />
        </label>
        <label>
          Participation demandée (€, indicatif)
          <input type="number" min={0} max={200} step={0.5} value={share} onChange={(e) => setShare(Number(e.target.value))} />
        </label>
        <button disabled={busy}>Publier mon trajet</button>
      </form>

      {tripId && (
        <div>
          <h3>Passagers compatibles</h3>
          {passengers.length === 0 ? (
            <p>Aucun passager pour l'instant.</p>
          ) : (
            <ul className="list">
              {passengers.map((p) => (
                <li key={p.request_id}>
                  <div>
                    <strong>{p.passenger_name}</strong>
                    <small>
                      {p.origin_label} → {p.dest_label}
                    </small>
                    <small>
                      Montée à {p.pickup_m} m du tracé · {p.shared_km} km en commun
                    </small>
                  </div>
                  <button onClick={() => invite(p.request_id)}>Proposer</button>
                </li>
              ))}
            </ul>
          )}
          <button className="link" onClick={() => loadPassengers(tripId)}>
            Actualiser
          </button>
        </div>
      )}
      {msg && <p className="msg">{msg}</p>}
    </section>
  );
}

function Passenger() {
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [trips, setTrips] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadTrips(id: string) {
    const { data, error } = await supabase.rpc('find_trips_for_request', { p_request_id: id, p_radius_m: 1000 });
    if (error) setMsg(error.message);
    else setTrips(data ?? []);
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!from || !to) return setMsg('Choisis les adresses dans la liste.');
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc('publish_request', {
      p_origin_label: from.label,
      p_origin_lng: from.lng,
      p_origin_lat: from.lat,
      p_dest_label: to.label,
      p_dest_lng: to.lng,
      p_dest_lat: to.lat,
      p_window_start: toIso(start),
      p_window_end: toIso(end),
    });
    if (error) {
      setMsg(error.message);
    } else {
      setRequestId(data as string);
      await loadTrips(data as string);
    }
    setBusy(false);
  }

  async function ask(tripId: string) {
    if (!requestId) return;
    const { error } = await supabase.rpc('propose_match', { p_trip_id: tripId, p_request_id: requestId });
    setMsg(error ? error.message : 'Demande envoyée au conducteur. Suis-la dans « Mes trajets ».');
  }

  return (
    <section>
      <h2>Je cherche un trajet</h2>
      <form onSubmit={search}>
        <PlaceInput label="Je pars de" value={from} onChange={setFrom} />
        <PlaceInput label="Je vais à" value={to} onChange={setTo} />
        <label>
          Au plus tôt
          <input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          Au plus tard
          <input type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button disabled={busy}>Chercher</button>
      </form>

      {requestId && (
        <div>
          <h3>Trajets qui passent par là</h3>
          {trips.length === 0 ? (
            <p>Rien pour l'instant. Reviens plus tard, ta demande reste active.</p>
          ) : (
            <ul className="list">
              {trips.map((t) => (
                <li key={t.trip_id}>
                  <div>
                    <strong>{t.driver_name}</strong>
                    <small>
                      {t.origin_label} → {t.dest_label}
                    </small>
                    <small>
                      Départ possible {fmt(t.overlap_start)} · {t.seats_left} place(s)
                      {t.cost_share_cents > 0 && ` · ${(t.cost_share_cents / 100).toFixed(2)} €`}
                    </small>
                  </div>
                  <button onClick={() => ask(t.trip_id)}>Demander</button>
                </li>
              ))}
            </ul>
          )}
          <button className="link" onClick={() => loadTrips(requestId)}>
            Actualiser
          </button>
        </div>
      )}
      {msg && <p className="msg">{msg}</p>}
    </section>
  );
}
