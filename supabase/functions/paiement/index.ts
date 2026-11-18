// Paiements CovoitGo (Stripe Connect). Réservée à une personne connectée ; la clé Stripe reste côté serveur.
//  - { action: 'status' }   : état du compte de versement du chauffeur (relu chez Stripe)
//  - { action: 'onboard' }  : crée le compte de versement si besoin et renvoie le lien Stripe pour saisir identité et RIB
//  - { action: 'withdraw' } : vire tout le solde du porte-monnaie vers le compte du chauffeur (25 € minimum)
//  - { action: 'pay', match_id }     : le passager règle son trajet accepté par carte (page de paiement Stripe)
//  - { action: 'confirm', match_id } : relit le paiement chez Stripe et marque le trajet comme payé
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const APP_URL = 'https://baziventillateur.github.io/CovoitGo/';
// Tant que le passage en réel n'est pas décidé, seule une clé de test est acceptée.
const USABLE = KEY.startsWith('sk_test_');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function stripe(method: 'GET' | 'POST', path: string, params?: Record<string, string>, idempotency?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${KEY}` };
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotency) headers['Idempotency-Key'] = idempotency;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers, body: method === 'POST' ? new URLSearchParams(params ?? {}) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Stripe', path.split('/')[0], res.status, data?.error?.code ?? data?.error?.type ?? '');
    throw new Error(data?.error?.message ?? 'Stripe indisponible');
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await supabase.auth.getUser(token);
  const user = auth?.user;
  if (!user) return json({ ok: false, reason: 'connexion' }, 401);

  const body = await req.json().catch(() => null);
  const action = body?.action;
  if (!USABLE) return json({ ok: false, reason: KEY ? 'cle_reelle_refusee' : 'non_configure' });

  const { data: rows } = await supabase.from('payout_accounts').select('stripe_account_id').eq('user_id', user.id);
  let accountId: string | null = rows?.[0]?.stripe_account_id ?? null;

  // Relit l'état du compte chez Stripe et le range en base.
  const refresh = async () => {
    if (!accountId) return { has_account: false, details_submitted: false, payouts_enabled: false };
    const a = await stripe('GET', `accounts/${accountId}`);
    await supabase.rpc('payout_account_save', {
      p_user: user.id, p_account: accountId, p_details: !!a.details_submitted, p_payouts: !!a.payouts_enabled,
    });
    return { has_account: true, details_submitted: !!a.details_submitted, payouts_enabled: !!a.payouts_enabled };
  };

  try {
    if (action === 'status') return json({ ok: true, test: true, ...(await refresh()) });

    if (action === 'onboard') {
      if (!accountId) {
        const a = await stripe('POST', 'accounts', {
          type: 'express', country: 'FR', email: user.email ?? '', business_type: 'individual',
          'capabilities[transfers][requested]': 'true',
          'business_profile[product_description]': 'Conducteur en covoiturage sur CovoitGo (partage de frais)',
          'business_profile[url]': APP_URL,
          'settings[payouts][schedule][interval]': 'daily',
          'metadata[app]': 'covoitgo', 'metadata[user_id]': user.id,
        }, `covoitgo-compte-${user.id}`);
        accountId = a.id as string;
        await supabase.rpc('payout_account_save', { p_user: user.id, p_account: accountId, p_details: false, p_payouts: false });
      }
      const link = await stripe('POST', 'account_links', {
        account: accountId, type: 'account_onboarding',
        refresh_url: `${APP_URL}?versement=reprendre`, return_url: `${APP_URL}?versement=retour`,
      });
      return json({ ok: true, url: link.url });
    }

    if (action === 'withdraw') {
      await refresh();
      const { data: reserved, error } = await supabase.rpc('wallet_withdraw_reserve', { p_user: user.id });
      if (error) return json({ ok: false, message: error.message });
      const r = reserved?.[0];
      if (!r) return json({ ok: false, message: 'Retrait impossible pour le moment' });
      try {
        const t = await stripe('POST', 'transfers', {
          amount: String(r.cents), currency: 'eur', destination: r.stripe_account_id,
          description: 'Retrait CovoitGo',
          'metadata[app]': 'covoitgo', 'metadata[user_id]': user.id, 'metadata[wallet_entry]': String(r.entry_id),
        }, `covoitgo-retrait-${r.entry_id}`);
        await supabase.rpc('wallet_withdraw_confirm', { p_entry_id: r.entry_id, p_stripe_ref: t.id });
        return json({ ok: true, cents: r.cents });
      } catch (e) {
        // Le virement n'est pas parti : le solde est rendu.
        await supabase.rpc('wallet_withdraw_cancel', { p_entry_id: r.entry_id });
        return json({ ok: false, message: (e as Error).message });
      }
    }
    if (action === 'pay' || action === 'confirm') {
      const matchId = body?.match_id;
      if (typeof matchId !== 'string' || !UUID.test(matchId)) return json({ ok: false, reason: 'trajet' }, 400);
      const { data: info } = await supabase.rpc('match_pay_info', { p_match_id: matchId, p_user: user.id });
      const m = info?.[0];
      if (!m || m.pay_method !== 'card') return json({ ok: false, message: 'Ce trajet ne se règle pas par carte' });
      if (m.paid) return json({ ok: true, paid: true });

      // Un paiement déjà commencé est relu chez Stripe avant toute chose (évite de payer deux fois).
      if (m.checkout_session_id) {
        const s = await stripe('GET', `checkout/sessions/${m.checkout_session_id}`);
        if (s.payment_status === 'paid') {
          await supabase.rpc('match_mark_paid', { p_match_id: matchId, p_payment_intent: String(s.payment_intent ?? '') });
          return json({ ok: true, paid: true });
        }
        if (action === 'pay' && s.status === 'open' && s.url) return json({ ok: true, url: s.url });
      }
      if (action === 'confirm') return json({ ok: true, paid: false });

      if (m.role !== 'passenger') return json({ ok: false, message: 'Seul le passager règle le trajet' });
      if (m.status !== 'accepted') return json({ ok: false, message: 'Ce trajet n’est pas confirmé' });
      if (m.price_cents < 50) return json({ ok: false, message: 'Montant trop faible pour un paiement par carte' });
      const s = await stripe('POST', 'checkout/sessions', {
        mode: 'payment', locale: 'fr', client_reference_id: matchId, customer_email: user.email ?? '',
        success_url: `${APP_URL}?paiement=ok`, cancel_url: `${APP_URL}?paiement=annule`,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][unit_amount]': String(m.price_cents),
        'line_items[0][price_data][product_data][name]': `Covoiturage ${m.from_label} → ${m.to_label}`.slice(0, 120),
        'payment_intent_data[statement_descriptor_suffix]': 'COVOITGO',
        'payment_intent_data[transfer_group]': `covoitgo-${matchId}`,
        'payment_intent_data[metadata][app]': 'covoitgo',
        'payment_intent_data[metadata][match_id]': matchId,
        'metadata[app]': 'covoitgo', 'metadata[match_id]': matchId,
      });
      await supabase.rpc('match_checkout_save', { p_match_id: matchId, p_session: s.id });
      return json({ ok: true, url: s.url });
    }
    return json({ ok: false, reason: 'action' }, 400);
  } catch (e) {
    return json({ ok: false, message: (e as Error).message });
  }
});
