import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from './supabase';
import { PlaceInput } from './PlaceInput';
import { fetchRoute, type Place } from './geo';
import { euros, fmtDuration, nextQuarterLocal } from './format';
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
  // Devis du trajet : distance, prix conseillé et fourchette, calculés par la base.
  const [quote, setQuote] = useState<{ km: number; reco: number; min: number; max: number; route: string | null; minutes: number | null } | null>(null);
  const [price, setPrice] = useState(0);
  const [people, setPeople] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQuote(null);
    if (!driver || !from || !to) return;
    let cancelled = false;
    (async () => {
      const found = await fetchRoute(from, to);
      const route = found?.geojson ?? null;
      const { data, error } = await supabase.rpc('quote_trip', {
        p_origin_lng: from.lng,
        p_origin_lat: from.lat,
        p_dest_lng: to.lng,
        p_dest_lat: to.lat,
        p_route_geojson: route,
      });
      if (cancelled) return;
      if (error || !data?.[0]) return notify(error?.message ?? 'Prix indisponible pour ce trajet', 'err');
      const q = data[0];
      setQuote({ km: Number(q.km), reco: q.reco_cents, min: q.min_cents, max: q.max_cents, route, minutes: found?.minutes ?? null });
      setPrice(q.reco_cents);
    })();
    return () => {
      cancelled = true;
    };
  }, [driver, from, to, notify]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!from || !to) return notify('Choisis le départ et l’arrivée dans la liste proposée.', 'err');
    if (driver && !quote) return notify('Le prix du trajet est en cours de calcul, réessaie dans un instant.', 'err');
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
    const { data: created, error } = driver
      ? await supabase.rpc('publish_trip', {
          ...common,
          p_seats: seats,
          p_cost_share_cents: price,
          p_route_geojson: quote?.route ?? null,
        })
      : await supabase.rpc('publish_request', { ...common, p_seats: people, p_note: note });
    setBusy(false);
    if (error) return notify(error.message, 'err');
    // Durée de conduite calculée par l'itinéraire : enregistrée avec le trajet (sans bloquer si ça échoue).
    if (driver && created && quote?.minutes) {
      await supabase.rpc('set_trip_duration', { p_trip_id: created, p_minutes: quote.minutes });
    }
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
        <>
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
          <div className="field">
            <span>Prix par passager</span>
            {quote ? (
              <>
                <div className="price-box">
                  <button type="button" className="step" aria-label="Baisser le prix" disabled={price <= quote.min} onClick={() => setPrice(Math.max(quote.min, price - 50))}>
                    −
                  </button>
                  <div className="price-value">
                    <strong>{euros(price)}</strong>
                    <small>
                      {price === quote.reco ? 'Prix conseillé' : `Conseillé : ${euros(quote.reco)}`} · {String(quote.km).replace('.', ',')} km
                      {quote.minutes ? ` · ≈ ${fmtDuration(quote.minutes)}` : ''}
                    </small>
                  </div>
                  <button type="button" className="step" aria-label="Augmenter le prix" disabled={price >= quote.max} onClick={() => setPrice(Math.min(quote.max, price + 50))}>
                    +
                  </button>
                </div>
                <small>
                  Tu peux ajuster entre {euros(quote.min)} et {euros(quote.max)}. Un passager qui ne fait qu’une partie du trajet paie en proportion.
                </small>
              </>
            ) : (
              <small>{from && to ? 'Calcul du prix…' : 'Choisis le départ et l’arrivée pour voir le prix conseillé.'}</small>
            )}
          </div>
        </>
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
