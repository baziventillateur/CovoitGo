import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from './supabase';
import { PlaceInput } from './PlaceInput';
import { WhenPicker, toLocal } from './WhenPicker';
import { fetchRoute, type Place } from './geo';
import { euros, fmtDuration, fmtTime, nextQuarterLocal, serviceFee } from './format';
import { api, type EditTrip, type Mode, type Notify } from './api';

const FLEX = [
  { min: 30, label: '30 min' },
  { min: 60, label: '1 h' },
  { min: 120, label: '2 h' },
  { min: 240, label: '4 h' },
];

type Props = { mode: Mode; notify: Notify; onDone: (message?: string) => void; onCancel: () => void; edit?: EditTrip };

const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const weekday = (d: Date) => (d.getDay() + 6) % 7; // lundi = 0
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
// Retour proposé le même jour : 9 h après l'aller, sans dépasser 23 h.
function defaultBack(when: string): string {
  const d = new Date(when);
  let b = new Date(d.getTime() + 9 * 3600_000);
  if (b.toDateString() !== d.toDateString()) {
    b = new Date(d);
    b.setHours(23, 0, 0, 0);
  }
  if (b.getTime() - d.getTime() < 3600_000) b = new Date(d.getTime() + 2 * 3600_000);
  return toLocal(b);
}

export function PublishForm({ mode, notify, onDone, onCancel, edit }: Props) {
  const driver = mode === 'driver';
  const [from, setFrom] = useState<Place | null>(edit?.from ?? null);
  const [to, setTo] = useState<Place | null>(edit?.to ?? null);
  const [when, setWhen] = useState(() =>
    edit && new Date(edit.start).getTime() > Date.now() ? toLocal(new Date(edit.start)) : nextQuarterLocal(),
  );
  const [flex, setFlex] = useState(edit?.flex ?? 120);
  const [seats, setSeats] = useState(edit?.seats ?? 3);
  // À la modification, le prix déjà choisi est conservé s'il reste dans la fourchette.
  const keepPrice = useRef<number | null>(edit?.price ?? null);
  // Options : aller-retour et trajet récurrent (désactivées par défaut).
  const [roundTrip, setRoundTrip] = useState(false);
  const [back, setBack] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [weeks, setWeeks] = useState(2);
  const [progress, setProgress] = useState<string | null>(null);
  // Devis du trajet : distance, prix conseillé et fourchette, calculés par la base.
  const [quote, setQuote] = useState<{ km: number; reco: number; min: number; max: number; route: string | null; minutes: number | null } | null>(null);
  const [price, setPrice] = useState(0);
  const [people, setPeople] = useState(1);
  const [note, setNote] = useState('');
  const [payBy, setPayBy] = useState<'cash' | 'card'>('cash');
  const [busy, setBusy] = useState(false);
  // Créneaux comparés selon la circulation : uniquement si le conducteur le demande.
  const [slots, setSlots] = useState<{ at: string; minutes: number; delay_min: number }[] | 'loading' | 'none' | null>(null);

  useEffect(() => setSlots(null), [from, to, flex]);

  async function loadSlots() {
    if (!from || !to) return;
    setSlots('loading');
    const found = await api.trafficSlots(from, to, new Date(when).toISOString(), flex);
    setSlots(found?.length ? found : 'none');
  }

  function pickSlot(iso: string) {
    setWhen(toLocal(new Date(iso)));
  }

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
      const keep = keepPrice.current;
      keepPrice.current = null;
      setPrice(keep ? Math.min(q.max_cents, Math.max(q.min_cents, keep)) : q.reco_cents);
    })();
    return () => {
      cancelled = true;
    };
  }, [driver, from, to, notify]);

  function changeWhen(v: string) {
    setWhen(v);
    setSlots(null);
    if (!roundTrip) return;
    // Le retour suit le jour de l'aller, en gardant son heure.
    const b = new Date(back);
    const d = new Date(v);
    b.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    setBack(b.getTime() > d.getTime() ? toLocal(b) : defaultBack(v));
  }

  const offsets = recurring
    ? Array.from({ length: weeks * 7 }, (_, i) => i).filter((i) => days.includes(weekday(addDays(new Date(when), i))))
    : [0];
  const total = offsets.length * (roundTrip ? 2 : 1);

  // Publie un trajet (ou une recherche) ; renvoie son identifiant ou le message d'erreur.
  async function publishOne(a: Place, b: Place, start: Date, route: string | null, cents: number, minutes: number | null) {
    const common = {
      p_origin_label: a.label,
      p_origin_lng: a.lng,
      p_origin_lat: a.lat,
      p_dest_label: b.label,
      p_dest_lng: b.lng,
      p_dest_lat: b.lat,
      p_window_start: start.toISOString(),
      p_window_end: new Date(start.getTime() + flex * 60_000).toISOString(),
    };
    const { data, error } = driver
      ? edit
        ? await supabase.rpc('replace_trip', { p_trip_id: edit.id, ...common, p_seats: seats, p_cost_share_cents: cents, p_route_geojson: route })
        : await supabase.rpc('publish_trip', { ...common, p_seats: seats, p_cost_share_cents: cents, p_route_geojson: route })
      : await supabase.rpc('publish_request', { ...common, p_seats: people, p_note: note });
    if (error) return { error: error.message };
    // Durée de conduite calculée par l'itinéraire : enregistrée avec le trajet (sans bloquer si ça échoue).
    if (driver && data && minutes) await supabase.rpc('set_trip_duration', { p_trip_id: data, p_minutes: minutes });
    if (!driver && data && payBy === 'card') await api.setPayMethod(data as string, 'card').catch(() => {});
    return { id: data as string };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!from || !to) return notify('Choisis le départ et l’arrivée dans la liste proposée.', 'err');
    if (driver && !quote) return notify('Le prix du trajet est en cours de calcul, réessaie dans un instant.', 'err');
    if (!offsets.length) return notify('Coche au moins un jour.', 'err');
    if (total > 40) return notify('Trop de trajets d’un coup : réduis la durée ou les jours.', 'err');
    if (roundTrip && new Date(back).getTime() <= new Date(when).getTime()) return notify('Le retour doit être après l’aller.', 'err');
    setBusy(true);

    // Trajet retour du conducteur : son propre tracé, et un prix ajusté dans les mêmes proportions que l'aller.
    let ret: { route: string | null; minutes: number | null; price: number } | null = null;
    if (roundTrip && driver && quote) {
      const found = await fetchRoute(to, from);
      const { data } = await supabase.rpc('quote_trip', {
        p_origin_lng: to.lng, p_origin_lat: to.lat, p_dest_lng: from.lng, p_dest_lat: from.lat,
        p_route_geojson: found?.geojson ?? null,
      });
      const q = data?.[0];
      const scaled = q ? Math.round(((price / quote.reco) * q.reco_cents) / 50) * 50 : 0;
      ret = {
        route: found?.geojson ?? null,
        minutes: found?.minutes ?? null,
        price: q ? Math.min(q.max_cents, Math.max(q.min_cents, scaled)) : 0,
      };
    }

    let ok = 0;
    let lastError = '';
    // Récurrence : les allers d'un côté, les retours de l'autre, chacun dans sa série.
    const series = [crypto.randomUUID(), crypto.randomUUID()];
    const seriesIds: string[][] = [[], []];
    const first: string[] = [];
    let n = 0;
    for (const off of offsets) {
      const legs: [Place, Place, Date, string | null, number, number | null][] = [
        [from, to, addDays(new Date(when), off), quote?.route ?? null, price, quote?.minutes ?? null],
      ];
      if (roundTrip) legs.push([to, from, addDays(new Date(back), off), ret?.route ?? null, ret?.price ?? 0, ret?.minutes ?? null]);
      for (const [k, leg] of legs.entries()) {
        if (total > 1) setProgress(`${++n}/${total}`);
        const r = await publishOne(...leg);
        if (r.id) {
          ok++;
          seriesIds[k].push(r.id);
          if (off === offsets[0]) first.push(r.id);
        } else lastError = r.error ?? '';
      }
    }
    setProgress(null);
    if (recurring && !edit) {
      await Promise.all(seriesIds.map((ids, k) => (ids.length > 1 ? api.setSeries(ids, series[k]) : null))).catch(() => {});
    }
    if (!ok) {
      setBusy(false);
      return notify(lastError || 'Publication impossible', 'err');
    }
    // Durée avec la circulation pour les premiers trajets ; les suivants seront vus à l'approche du jour.
    if (driver) await Promise.all(first.map((id) => api.traffic(id, false)));
    setBusy(false);
    if (ok < total) notify(`${ok} sur ${total} publiés. Les autres ont été ignorés : ${lastError}`, 'err');
    onDone(edit ? 'Trajet modifié' : ok > 1 ? `${ok} ${driver ? 'trajets publiés' : 'recherches lancées'} !` : undefined);
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{edit ? 'Modifier le trajet' : driver ? 'Publier un trajet' : 'Chercher un trajet'}</h2>
      <PlaceInput label="Départ" value={from} onChange={setFrom} />
      <PlaceInput label="Arrivée" value={to} onChange={setTo} />
      <WhenPicker
        label={driver ? 'Je pars à partir de' : 'Je suis prêt à partir de'}
        value={when}
        onChange={changeWhen}
      />
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
        {driver && from && to && slots === null && (
          <button type="button" className="link slots-link" onClick={loadSlots}>
            Voir les meilleurs créneaux selon le trafic
          </button>
        )}
        {slots === 'loading' && <small>Comparaison des créneaux…</small>}
        {slots === 'none' && <small>Créneaux indisponibles pour le moment.</small>}
        {Array.isArray(slots) &&
          (() => {
            const best = Math.min(...slots.map((s) => s.minutes));
            const flat = Math.max(...slots.map((s) => s.minutes)) - best < 3;
            return (
              <>
                <div className="chips">
                  {slots.map((s) => (
                    <button type="button" key={s.at} className={!flat && s.minutes === best ? 'chip slot best' : 'chip slot'} onClick={() => pickSlot(s.at)}>
                      {fmtTime(s.at)} · {fmtDuration(s.minutes)}
                    </button>
                  ))}
                </div>
                <small>
                  {flat ? 'Peu d’écart sur ta fenêtre : pars quand tu veux.' : 'Le plus rapide est en vert. Touche un créneau pour partir à cette heure.'} Durées
                  estimées.
                </small>
              </>
            );
          })()}
      </div>
      {!edit && (
        <div className="field">
          <div className="chips">
            <button
              type="button"
              className={roundTrip ? 'chip on' : 'chip'}
              onClick={() => {
                if (!roundTrip) setBack(defaultBack(when));
                setRoundTrip(!roundTrip);
              }}
            >
              ↔ Aller-retour
            </button>
            <button type="button" className={recurring ? 'chip on' : 'chip'} onClick={() => setRecurring(!recurring)}>
              🔁 Récurrent
            </button>
          </div>
        </div>
      )}
      {roundTrip && <WhenPicker label="Retour à partir de" value={back} onChange={setBack} />}
      {recurring && (
        <div className="field options">
          <span>Quels jours ?</span>
          <div className="chips">
            {DAYS.map((d, i) => (
              <button
                type="button"
                key={i}
                className={days.includes(i) ? 'chip day on' : 'chip day'}
                onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}
              >
                {d}
              </button>
            ))}
          </div>
          <span>Pendant</span>
          <div className="chips">
            {[1, 2, 4].map((w) => (
              <button type="button" key={w} className={weeks === w ? 'chip on' : 'chip'} onClick={() => setWeeks(w)}>
                {w} sem.
              </button>
            ))}
          </div>
          <small>
            {total
              ? `${total} ${driver ? 'trajet(s)' : 'recherche(s)'} à partir du ${new Date(when).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}.`
              : 'Coche au moins un jour.'}
          </small>
        </div>
      )}
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
                <small className="you-get">
                  Tu reçois <b>{euros(price - serviceFee(price))}</b> par passager · frais de service {euros(serviceFee(price))}
                </small>
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
          <div className="field">
            <span>Je paie</span>
            <div className="chips">
              <button type="button" className={payBy === 'cash' ? 'chip on' : 'chip'} onClick={() => setPayBy('cash')}>
                💶 En espèces
              </button>
              <button type="button" className={payBy === 'card' ? 'chip on' : 'chip'} onClick={() => setPayBy('card')}>
                💳 Par carte
              </button>
            </div>
            <small>{payBy === 'card' ? 'Tu règles dans l’appli une fois le trajet accepté.' : 'Tu remets le montant au chauffeur au début du trajet.'}</small>
          </div>
          <label>
            Un mot pour le chauffeur (facultatif)
            <textarea rows={2} maxLength={200} placeholder="Bagages, trottinette, siège enfant…" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </>
      )}
      {edit && <small>Les propositions en attente sur ce trajet seront annulées.</small>}
      <button className="primary big" disabled={busy}>
        {busy ? (progress ? `Publication ${progress}…` : 'Un instant…') : edit ? 'Enregistrer' : driver ? (total > 1 ? `Publier ${total} trajets` : 'Publier') : total > 1 ? `Lancer ${total} recherches` : 'Chercher'}
      </button>
      <button type="button" className="link center" onClick={onCancel}>
        Annuler
      </button>
    </form>
  );
}
