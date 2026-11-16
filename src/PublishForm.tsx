import { useState, type FormEvent } from 'react';
import { supabase } from './supabase';
import { PlaceInput } from './PlaceInput';
import { routeGeoJSON, type Place } from './geo';
import { nextQuarterLocal } from './format';
import type { Mode, Notify } from './api';

const FLEX = [
  { min: 30, label: '30 min' },
  { min: 60, label: '1 h' },
  { min: 120, label: '2 h' },
  { min: 240, label: '4 h' },
];

type Props = { mode: Mode; notify: Notify; onDone: () => void; onCancel: () => void };

export function PublishForm({ mode, notify, onDone, onCancel }: Props) {
  const driver = mode === 'driver';
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [when, setWhen] = useState(nextQuarterLocal());
  const [flex, setFlex] = useState(120);
  const [seats, setSeats] = useState(3);
  const [share, setShare] = useState('');
  const [people, setPeople] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!from || !to) return notify('Choisis le départ et l’arrivée dans la liste proposée.', 'err');
    const start = new Date(when);
    const end = new Date(start.getTime() + flex * 60_000);
    setBusy(true);
    const common = {
      p_origin_label: from.label,
      p_origin_lng: from.lng,
      p_origin_lat: from.lat,
      p_dest_label: to.label,
      p_dest_lng: to.lng,
      p_dest_lat: to.lat,
      p_window_start: start.toISOString(),
      p_window_end: end.toISOString(),
    };
    const { error } = driver
      ? await supabase.rpc('publish_trip', {
          ...common,
          p_seats: seats,
          p_cost_share_cents: Math.round((parseFloat(share.replace(',', '.')) || 0) * 100),
          p_route_geojson: await routeGeoJSON(from, to),
        })
      : await supabase.rpc('publish_request', { ...common, p_seats: people, p_note: note });
    setBusy(false);
    if (error) return notify(error.message, 'err');
    notify(driver ? 'Trajet publié !' : 'Recherche lancée !');
    onDone();
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{driver ? 'Publier un trajet' : 'Chercher un trajet'}</h2>
      <PlaceInput label="Départ" value={from} onChange={setFrom} />
      <PlaceInput label="Arrivée" value={to} onChange={setTo} />
      <label>
        {driver ? 'Je pars à partir de' : 'Je suis prêt à partir de'}
        <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <div className="field">
        <span>{driver ? 'Je peux partir jusqu’à' : 'Je peux attendre jusqu’à'}</span>
        <div className="chips">
          {FLEX.map((f) => (
            <button type="button" key={f.min} className={flex === f.min ? 'chip on' : 'chip'} onClick={() => setFlex(f.min)}>
              + {f.label}
            </button>
          ))}
        </div>
        <small>Plus ta fenêtre est large, plus tu as de chances de trouver.</small>
      </div>
      {driver && (
        <div className="row2">
          <div className="field">
            <span>Places</span>
            <div className="chips">
              {[1, 2, 3, 4].map((n) => (
                <button type="button" key={n} className={seats === n ? 'chip on' : 'chip'} onClick={() => setSeats(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label>
            Participation (€)
            <input inputMode="decimal" placeholder="0" value={share} onChange={(e) => setShare(e.target.value.replace(/[^0-9.,]/g, ''))} />
          </label>
        </div>
      )}
      {!driver && (
        <>
          <div className="field">
            <span>Combien de personnes ?</span>
            <div className="chips">
              {[1, 2, 3].map((n) => (
                <button type="button" key={n} className={people === n ? 'chip on' : 'chip'} onClick={() => setPeople(n)}>
                  {n === 1 ? 'Moi seul' : `${n} personnes`}
                </button>
              ))}
            </div>
          </div>
          <label>
            Un mot pour le chauffeur (facultatif)
            <textarea rows={2} maxLength={200} placeholder="Bagages, trottinette, siège enfant…" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </>
      )}
      <button className="primary big" disabled={busy}>
        {busy ? 'Un instant…' : driver ? 'Publier' : 'Chercher'}
      </button>
      <button type="button" className="link center" onClick={onCancel}>
        Annuler
      </button>
    </form>
  );
}
