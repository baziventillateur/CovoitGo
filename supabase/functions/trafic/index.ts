// Durée d'un trajet avec la circulation (TomTom). Appelée par l'appli du conducteur
// avec { trip_id, live } : à la publication (circulation habituelle à l'heure du départ)
// puis au départ (circulation du moment). La clé TomTom ne quitte jamais le serveur.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, reason: 'methode' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await supabase.auth.getUser(token);
  if (!auth?.user) return json({ ok: false, reason: 'connexion' }, 401);

  const body = await req.json().catch(() => null);
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

  const url = new URL(
    `https://api.tomtom.com/routing/1/calculateRoute/${r.o_lat},${r.o_lng}:${r.d_lat},${r.d_lng}/json`,
  );
  url.searchParams.set('key', TOMTOM_API_KEY);
  url.searchParams.set('traffic', 'true');
  url.searchParams.set('travelMode', 'car');
  url.searchParams.set('routeRepresentation', 'summaryOnly');
  if (r.depart_at) url.searchParams.set('departAt', new Date(r.depart_at).toISOString());

  let summary: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error('TomTom', res.status);
      return json({ ok: false, reason: 'fournisseur' });
    }
    summary = (await res.json())?.routes?.[0]?.summary;
  } catch {
    return json({ ok: false, reason: 'fournisseur' });
  }
  const seconds = Number(summary?.travelTimeInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return json({ ok: false, reason: 'fournisseur' });

  const minutes = Math.round(seconds / 60);
  const delay = Math.round((Number(summary?.trafficDelayInSeconds) || 0) / 60);
  const { data: kept } = await supabase.rpc('traffic_apply', {
    p_trip_id: tripId, p_minutes: minutes, p_delay_min: delay,
  });
  return json({ ok: kept === true, minutes, delay_min: delay });
});
