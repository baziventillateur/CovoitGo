// Notifications sur le téléphone (Web Push). Appelée par la base avec { notification_id } ;
// relit tout elle-même. { init: true } renvoie la clé publique, créée au premier appel :
// la clé privée reste en base, dans une table que l'appli ne peut pas lire.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const APP_URL = 'https://covoitgo.paceapp.fr/';
// Seuls les services de notification des navigateurs sont contactés.
const HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function readKeys() {
  const { data } = await supabase.from('app_settings').select('key,value').in('key', ['vapid_public', 'vapid_private']);
  const m = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return m.vapid_public && m.vapid_private ? { publicKey: m.vapid_public as string, privateKey: m.vapid_private as string } : null;
}

async function keys() {
  const found = await readKeys();
  if (found) return found;
  const g = webpush.generateVAPIDKeys();
  await supabase.from('app_settings').upsert(
    [{ key: 'vapid_public', value: g.publicKey }, { key: 'vapid_private', value: g.privateKey }],
    { onConflict: 'key', ignoreDuplicates: true },
  );
  return (await readKeys())!;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false }, 405);
  const body = await req.json().catch(() => null);

  if (body?.init === true) return json({ ok: true, public_key: (await keys()).publicKey });

  const id = Number(body?.notification_id);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false }, 400);

  // Une notification n'est envoyée qu'une fois, et seulement si elle vient d'être créée.
  const { data: claimed } = await supabase
    .from('notifications')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', id)
    .is('pushed_at', null)
    .gte('created_at', new Date(Date.now() - 5 * 60_000).toISOString())
    .select('user_id,title,body,match_id');
  const n = claimed?.[0];
  if (!n) return json({ ok: true, sent: 0 });

  const { data: subs } = await supabase.from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id', n.user_id);
  if (!subs?.length) return json({ ok: true, sent: 0 });

  const vapid = await keys();
  const payload = JSON.stringify({ title: n.title, body: n.body, tag: n.match_id ? `m${n.match_id}` : `n${id}`, url: APP_URL });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    let host = '';
    try { host = new URL(s.endpoint).hostname; } catch { /* adresse invalide */ }
    if (!HOSTS.test(host)) {
      await supabase.from('push_subscriptions').delete().eq('id', s.id);
      return;
    }
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { vapidDetails: { subject: 'mailto:covoitgo@paceapp.fr', ...vapid }, TTL: 3600, urgency: 'high' },
      );
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      // Abonnement expiré ou révoqué : on l'oublie.
      if (status === 404 || status === 410) await supabase.from('push_subscriptions').delete().eq('id', s.id);
      else console.error('push', status ?? String(e));
    }
  }));
  return json({ ok: true, sent });
});
