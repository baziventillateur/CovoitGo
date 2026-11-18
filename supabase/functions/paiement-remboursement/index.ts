// Remboursement d'un trajet payé par carte puis annulé. Appelée par la base avec { match_id } ;
// relit tout elle-même : seul un trajet annulé, payé et pas encore remboursé déclenche quelque chose.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  const body = await req.json().catch(() => null);
  const matchId = body?.match_id;
  if (typeof matchId !== 'string' || !UUID.test(matchId)) return json({ ok: false }, 400);
  if (!KEY.startsWith('sk_test_')) return json({ ok: false, reason: 'non_configure' });

  const { data: pi } = await supabase.rpc('match_refund_claim', { p_match_id: matchId });
  if (!pi) return json({ ok: true, refunded: false });
  try {
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `covoitgo-remboursement-${matchId}`,
      },
      body: new URLSearchParams({ payment_intent: pi, 'metadata[app]': 'covoitgo', 'metadata[match_id]': matchId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(String(res.status));
    await supabase.rpc('match_refund_notify', { p_match_id: matchId });
    return json({ ok: true, refunded: true });
  } catch (e) {
    console.error('remboursement', String(e));
    await supabase.rpc('match_refund_release', { p_match_id: matchId });
    return json({ ok: false });
  }
});
