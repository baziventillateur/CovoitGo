// Durée d'un trajet avec la circulation (TomTom). La clé TomTom ne quitte jamais le serveur.
// Deux usages, réservés à une personne connectée :
//  - { trip_id, live } : durée du trajet publié (circulation habituelle à l'heure du départ,
//    ou circulation du moment quand live = true) ;
//  - { slots: { from, to, start, flex_min } } : comparaison de trois heures de départ ;
//  - { detours: { trip_id, request_ids } } : minutes de détour pour passer prendre chaque passager.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const TOMTOM_API_KEY = Deno.env.get('TOMTOM_API_KEY');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Point = { lat: number; lng: number };
const point = (p: any): Point | null => {
  const lat = Number(p?.lat), lng = Number(p?.lng);
  return lat >= 41 && lat <= 52 && lng >= -6 && lng <= 10 ? { lat, lng } : null;
};

// Durée et retard dû à la circulation, en minutes ; null si le fournisseur ne répond pas.
async function travel(a: Point, b: Point, departAt: Date | null, via: Point[] = []) {
  const path = [a, ...via, b].map((p) => `${p.lat},${p.lng}`).join(':');
  const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${path}/json`);
  url.searchParams.set('key', TOMTOM_API_KEY!);
  url.searchParams.set('traffic', 'true');
  url.searchParams.set('travelMode', 'car');
  url.searchParams.set('routeRepresentation', 'summaryOnly');
  if (departAt) url.searchParams.set('departAt', departAt.toISOString());
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error('TomTom', res.status);
      return null;
    }
    const summary = (await res.json())?.routes?.[0]?.summary;
    const seconds = Number(summary?.travelTimeInSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return {
      minutes: Math.round(seconds / 60),
      delay_min: Math.round((Number(summary?.trafficDelayInSeconds) || 0) / 60),
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, reason: 'methode' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await supabase.auth.getUser(token);
  if (!auth?.user) return json({ ok: false, reason: 'connexion' }, 401);

  const body = await req.json().catch(() => null);

  // ---- Meilleurs créneaux -------------------------------------------------
  if (body?.slots) {
    const from = point(body.slots.from), to = point(body.slots.to);
    const flex = Number(body.slots.flex_min);
    const start = new Date(body.slots.start);
    const now = Date.now();
    if (!from || !to || !(flex >= 30 && flex <= 240) || Number.isNaN(start.getTime())
        || start.getTime() < now - 3600_000 || start.getTime() > now + 30 * 86400_000) {
      return json({ ok: false, reason: 'demande' }, 400);
    }
    if (!TOMTOM_API_KEY) return json({ ok: false, reason: 'non_configure' });
    const { data: allowed } = await supabase.rpc('traffic_reserve_slots', { p_user: auth.user.id, p_n: 3 });
    if (allowed !== true) return json({ ok: false, reason: 'limite' });

    const times = [0, flex / 2, flex].map((m) => new Date(Math.max(start.getTime() + m * 60_000, now + 120_000)));
    const results = await Promise.all(times.map((t) => travel(from, to, t)));
    const slots = times.flatMap((t, i) => (results[i] ? [{ at: t.toISOString(), ...results[i]! }] : []));
    return json({ ok: slots.length > 0, slots });
  }

  // ---- Détour réel par passager -------------------------------------------
  if (body?.detours) {
    const trip = body.detours.trip_id;
    const ids = Array.isArray(body.detours.request_ids) ? body.detours.request_ids.filter((x: unknown) => typeof x === 'string' && UUID.test(x)).slice(0, 5) : [];
    if (typeof trip !== 'string' || !UUID.test(trip) || !ids.length) return json({ ok: false, reason: 'demande' }, 400);
    if (!TOMTOM_API_KEY) return json({ ok: false, reason: 'non_configure' });
    const { data: rows, error } = await supabase.rpc('traffic_detour_inputs', { p_trip_id: trip, p_user: auth.user.id, p_request_ids: ids });
    if (error) return json({ ok: false, reason: 'trajet' }, 404);
    if (!rows?.length) return json({ ok: true, done: 0 });

    const r0 = rows[0];
    const depart = r0.depart_at ? new Date(r0.depart_at) : null;
    const o = { lat: r0.o_lat, lng: r0.o_lng }, d = { lat: r0.d_lat, lng: r0.d_lng };
    const direct = r0.direct_min ?? (await travel(o, d, depart))?.minutes;
    if (!direct) return json({ ok: false, reason: 'fournisseur' });
    let done = 0;
    await Promise.all(rows.map(async (r: any) => {
      const withStop = await travel(o, d, depart, [{ lat: r.p_lat, lng: r.p_lng }, { lat: r.q_lat, lng: r.q_lng }]);
      if (!withStop) return;
      await supabase.rpc('traffic_detour_save', {
        p_trip_id: trip, p_request_id: r.request_id, p_detour_min: Math.max(0, withStop.minutes - direct),
      });
      done++;
    }));
    return json({ ok: true, done });
  }

  // ---- Durée d'un trajet publié --------------------------------------------
  const tripId = body?.trip_id;
  if (typeof tripId !== 'string' || !UUID.test(tripId)) return json({ ok: false, reason: 'trajet' }, 400);
  // Sans clé, l'appli garde simplement la durée de l'itinéraire.
  if (!TOMTOM_API_KEY) return json({ ok: false, reason: 'non_configure' });

  const { data: rows, error } = await supabase.rpc('traffic_reserve', {
    p_trip_id: tripId, p_user: auth.user.id, p_live: body?.live === true,
  });
  if (error) return json({ ok: false, reason: 'trajet' }, 404);
  const r = rows?.[0];
  if (!r) return json({ ok: false, reason: 'saute' });

  const found = await travel(
    { lat: r.o_lat, lng: r.o_lng }, { lat: r.d_lat, lng: r.d_lng }, r.depart_at ? new Date(r.depart_at) : null,
  );
  if (!found) return json({ ok: false, reason: 'fournisseur' });
  const { data: kept } = await supabase.rpc('traffic_apply', {
    p_trip_id: tripId, p_minutes: found.minutes, p_delay_min: found.delay_min,
  });
  return json({ ok: kept === true, ...found });
});
