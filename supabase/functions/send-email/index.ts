// Envoi des e-mails CovoitGo (trajet confirmé, trajet terminé) et désabonnement.
// Appelée par la base avec { notification_id } ; relit toutes les données elle-même.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const APP_URL = 'https://baziventillateur.github.io/CovoitGo/';
const SELF_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`;
const FROM = 'CovoitGo <covoitgo@paceapp.fr>';
const REPLY_TO = 'contact@paceapp.fr';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const when = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function layout(o: { preview: string; title: string; intro: string; rows: [string, string][]; cta: string; note: string; unsub: string }) {
  const rows = o.rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#64748b;font-size:14px;width:38%;vertical-align:top">${esc(k)}</td>` +
        `<td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600">${esc(v)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${esc(o.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0f766e;padding:18px 24px;color:#ffffff;font-size:20px;font-weight:bold">CovoitGo</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 8px;font-size:20px;color:#0f172a">${esc(o.title)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#334155">${esc(o.intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:8px 16px">${rows}</table>
<p style="margin:20px 0 8px;text-align:center"><a href="${APP_URL}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px">${esc(o.cta)}</a></p>
<p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#64748b;text-align:center">${esc(o.note)}</p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#94a3b8;text-align:center">
Tu reçois cet e-mail parce que tu as un compte CovoitGo et qu'un de tes trajets a évolué.<br>
CovoitGo, un service PaceApp · <a href="mailto:${REPLY_TO}" style="color:#94a3b8">${REPLY_TO}</a><br>
<a href="${o.unsub}" style="color:#94a3b8;text-decoration:underline">Ne plus recevoir ces e-mails</a>
</td></tr></table></td></tr></table></body></html>`;
}

async function sendForNotification(id: number): Promise<string> {
  // Prise en charge atomique : une notification ne donne lieu qu'à un seul e-mail.
  const { data: n } = await supabase
    .from('notifications')
    .update({ emailed_at: new Date().toISOString() })
    .eq('id', id)
    .is('emailed_at', null)
    .in('kind', ['accepted', 'completed'])
    .select('id,user_id,role,kind,match_id')
    .maybeSingle();
  if (!n || !n.match_id) return 'ignored';

  await supabase.from('email_prefs').upsert({ user_id: n.user_id }, { onConflict: 'user_id', ignoreDuplicates: true });
  const { data: prefs } = await supabase.from('email_prefs').select('enabled,token').eq('user_id', n.user_id).single();
  if (!prefs?.enabled) return 'unsubscribed';

  const { data: user } = await supabase.auth.admin.getUserById(n.user_id);
  const to = user?.user?.email;
  if (!to) return 'no-email';

  const { data: m } = await supabase.from('matches').select('trip_id,request_id,driver_id,passenger_id').eq('id', n.match_id).single();
  if (!m) return 'no-match';
  const driver = n.role === 'driver';
  const [{ data: trip }, { data: request }, { data: me }, { data: other }] = await Promise.all([
    supabase.from('trips').select('window_start,cost_share_cents').eq('id', m.trip_id).single(),
    supabase.from('requests').select('origin_label,dest_label,window_start,seats').eq('id', m.request_id).single(),
    supabase.from('profiles').select('display_name,points').eq('id', n.user_id).single(),
    supabase.from('profiles').select('display_name').eq('id', driver ? m.passenger_id : m.driver_id).single(),
  ]);
  if (!trip || !request || !me || !other) return 'incomplete';

  const meet = new Date(trip.window_start) > new Date(request.window_start) ? trip.window_start : request.window_start;
  const who = other.display_name;
  const rows: [string, string][] = [
    ['Trajet', `${request.origin_label} → ${request.dest_label}`],
    [n.kind === 'accepted' ? 'Rendez-vous' : 'Date', when(meet)],
    [driver ? 'Ton passager' : 'Ton chauffeur', who],
  ];
  if (driver && request.seats > 1) rows.push(['Passagers', `${request.seats} personnes`]);
  if (trip.cost_share_cents > 0) rows.push(['Participation', (trip.cost_share_cents / 100).toFixed(2).replace('.', ',') + ' €']);

  const unsub = `${SELF_URL}?unsubscribe=${prefs.token}`;
  let subject: string;
  let html: string;
  if (n.kind === 'accepted') {
    subject = `Trajet confirmé avec ${who}`;
    html = layout({
      preview: `${request.origin_label} → ${request.dest_label}, ${when(meet)}`,
      title: `C'est confirmé, ${me.display_name} !`,
      intro: driver ? `${who} voyage avec toi. Voici le récapitulatif.` : `${who} t'emmène. Voici le récapitulatif.`,
      rows,
      cta: 'Voir mon trajet',
      note: driver
        ? `Le téléphone de ${who} est disponible dans l'appli jusqu'à la fin du trajet.`
        : `Le téléphone de ${who} et son véhicule sont disponibles dans l'appli jusqu'à la fin du trajet.`,
      unsub,
    });
  } else {
    rows.push(['Points gagnés', `+${driver ? 15 : 10} (total : ${me.points})`]);
    subject = `Trajet terminé : merci ${me.display_name} !`;
    html = layout({
      preview: `Récapitulatif de ton trajet avec ${who}`,
      title: 'Trajet terminé, bravo !',
      intro: `Merci d'avoir covoituré avec ${who}. Voici le récapitulatif de ton trajet.`,
      rows,
      cta: `Noter ${who}`,
      note: 'Ton avis aide toute la communauté : il prend dix secondes.',
      unsub,
    });
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      reply_to: REPLY_TO,
      subject,
      html,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
  });
  if (!res.ok) {
    // Échec d'envoi : on libère la notification pour permettre un nouvel essai.
    await supabase.from('notifications').update({ emailed_at: null }).eq('id', id);
    console.error('resend', res.status, await res.text());
    return 'send-failed';
  }
  return 'sent';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const token = new URL(req.url).searchParams.get('unsubscribe');
  if (token !== null) {
    if (!UUID.test(token)) return json({ error: 'Lien invalide' }, 400);
    if (req.method === 'POST') {
      // Désabonnement en un clic (messageries) ou confirmé depuis la page de l'appli.
      await supabase.from('email_prefs').update({ enabled: false }).eq('token', token);
      return json({ ok: true });
    }
    // En GET, on renvoie vers l'appli, qui demande confirmation : les messageries
    // ouvrent parfois les liens toutes seules, un GET ne doit donc rien modifier.
    return Response.redirect(`${APP_URL}?unsubscribe=${token}`, 302);
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!RESEND_API_KEY) return json({ error: 'RESEND_API_KEY manquante' }, 500);
  let id: unknown;
  try {
    id = (await req.json()).notification_id;
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  if (!Number.isSafeInteger(id)) return json({ error: 'Bad request' }, 400);
  return json({ result: await sendForNotification(id as number) });
});
