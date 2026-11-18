import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { ago, euros } from './format';

type Tab = 'vue' | 'clients' | 'activite' | 'argent' | 'reglages' | 'plus';
type User = {
  user_id: string; name: string; email: string; created_at: string; last_seen_at: string | null;
  installed: boolean; trips: number; requests: number; completed: number; rating: number | null; wallet_cents: number;
};
type Event = { at: string; kind: string; who: string; detail: string };

const KINDS: [string, string, string][] = [
  ['', 'Tout', '•'],
  ['inscription', 'Inscriptions', '👤'],
  ['trajet', 'Trajets', '🚗'],
  ['demande', 'Demandes', '🙋'],
  ['proposition', 'Propositions', '✋'],
  ['acceptation', 'Acceptations', '🎉'],
  ['termine', 'Terminés', '🏁'],
  ['annulation', 'Annulations', '❌'],
  ['paiement', 'Paiements', '💳'],
  ['remboursement', 'Remboursements', '↩️'],
  ['retrait', 'Retraits', '👛'],
  ['reclamation', 'Réclamations', '🆘'],
];
const ICON = Object.fromEntries(KINDS.map(([k, , i]) => [k, i]));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');

function Kpi({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: 'good' | 'warn' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {hint && <em>{hint}</em>}
    </div>
  );
}

// Panel admin : vision d'ensemble, comptes, journal, argent. Visible uniquement pour les comptes admin.
export function Admin({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('vue');
  const [o, setO] = useState<any>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [events, setEvents] = useState<Event[]>([]);
  const [kind, setKind] = useState('');
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const [pricing, setPricing] = useState<Record<string, number> | null>(null);
  const [saved, setSaved] = useState('');

  const loadBlocked = () =>
    supabase.rpc('admin_blocked').then(({ data }) => setBlocked(Object.fromEntries((data ?? []).map((b: any) => [b.user_id, b.reason]))));
  useEffect(() => {
    if (tab === 'clients') loadBlocked();
    if (tab === 'reglages' && !pricing) {
      supabase.from('pricing_settings').select('*').maybeSingle().then(({ data }) => data && setPricing({ ...data, fee_percent: Number(data.fee_percent) }));
    }
  }, [tab, pricing]);

  async function toggleBlock(u: User) {
    const isBlocked = u.user_id in blocked;
    if (!isBlocked && !window.confirm(`Suspendre ${u.name} ? Ses annonces sont retirées et il ne peut plus rien publier ni accepter.`)) return;
    const { error } = await supabase.rpc('admin_set_block', { p_user: u.user_id, p_blocked: !isBlocked, p_reason: '' });
    if (error) return setError(error.message);
    loadBlocked();
  }

  async function savePricing() {
    const { error } = await supabase.rpc('admin_set_pricing', { p: pricing });
    setSaved(error ? error.message : 'Enregistré. Les nouveaux trajets utilisent ces valeurs.');
  }
  const price = (km: number) =>
    pricing
      ? Math.max(pricing.price_min, Math.round((pricing.price_base + pricing.km_short * Math.min(km, 20) + pricing.km_mid * Math.min(Math.max(km - 20, 0), 40) + pricing.km_long * Math.max(km - 60, 0)) / 50) * 50)
      : 0;
  const fee = (cents: number) => (pricing ? Math.min(cents, Math.round((pricing.fee_fixed + (pricing.fee_percent / 100) * cents) / 5) * 5) : 0);

  useEffect(() => {
    supabase.rpc('admin_overview').then(({ data, error }) => (error ? setError(error.message) : setO(data)));
  }, []);
  useEffect(() => {
    if (tab !== 'clients') return;
    const t = setTimeout(() => {
      supabase.rpc('admin_users', { p_search: search, p_limit: 100 }).then(({ data }) => setUsers((data ?? []) as User[]));
    }, 250);
    return () => clearTimeout(t);
  }, [tab, search]);
  useEffect(() => {
    if (tab !== 'activite') return;
    supabase.rpc('admin_activity', { p_kind: kind, p_limit: 150 }).then(({ data }) => setEvents((data ?? []) as Event[]));
  }, [tab, kind]);

  const days: { day: string; signups: number; completed: number }[] = o?.days ?? [];
  const maxDay = Math.max(1, ...days.map((d) => Math.max(d.signups, d.completed)));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet admin" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>🛠 Panel admin</h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        <div className="chips admin-tabs">
          {([['vue', 'Vue d’ensemble'], ['clients', 'Clients'], ['activite', 'Activité'], ['argent', 'Argent'], ['reglages', 'Réglages'], ['plus', 'À venir']] as [Tab, string][]).map(([t, l]) => (
            <button key={t} className={tab === t ? 'chip on' : 'chip'} onClick={() => setTab(t)}>
              {l}
            </button>
          ))}
        </div>
        {error && <small className="error">{error}</small>}
        {!o && !error && <p className="muted center">Chargement…</p>}

        {tab === 'vue' && o && (
          <>
            <h3 className="section">Les gens</h3>
            <div className="kpis">
              <Kpi label="Inscrits" value={o.users_total} hint={`+${o.users_new_7d} cette semaine`} />
              <Kpi label="Actifs sur 7 jours" value={o.active_7d} hint={pct(o.active_7d, o.users_total) + ' des inscrits'} tone="good" />
              <Kpi label="Jamais utilisé" value={o.never_used} hint="ni trajet ni demande" tone={o.never_used ? 'warn' : undefined} />
              <Kpi label="Appli installée" value={o.installed} hint={pct(o.installed, o.users_total) + ' des inscrits'} />
              <Kpi label="Notifications activées" value={o.push} hint={pct(o.push, o.users_total)} />
              <Kpi label="Actifs sur 30 jours" value={o.active_30d} />
            </div>
            <h3 className="section">En ce moment</h3>
            <div className="kpis">
              <Kpi label="Trajets ouverts" value={o.trips_open} />
              <Kpi label="Demandes ouvertes" value={o.requests_open} />
              <Kpi label="Propositions en attente" value={o.proposed} />
              <Kpi label="Trajets confirmés" value={o.accepted} tone="good" />
            </div>
            <h3 className="section">Résultats</h3>
            <div className="kpis">
              <Kpi label="Covoiturages terminés" value={o.completed_total} hint={`${o.completed_7d} sur 7 jours`} tone="good" />
              <Kpi label="Taux d’acceptation" value={pct(o.answered_yes, o.answered)} hint="des propositions traitées" />
              <Kpi label="Annulés ou refusés" value={o.cancelled_7d} hint="sur 7 jours" tone={o.cancelled_7d ? 'warn' : undefined} />
              <Kpi label="Réclamations ouvertes" value={o.claims_open} tone={o.claims_open ? 'warn' : undefined} />
            </div>
            <h3 className="section">14 derniers jours</h3>
            <div className="admin-days">
              {days.map((d) => (
                <div key={d.day} title={d.day}>
                  <i className="a" style={{ height: `${(d.signups / maxDay) * 100}%` }} />
                  <i className="b" style={{ height: `${(d.completed / maxDay) * 100}%` }} />
                  <em>{new Date(d.day).getDate()}</em>
                </div>
              ))}
            </div>
            <small className="money-note">▮ inscriptions &nbsp; ▮ covoiturages terminés</small>
          </>
        )}

        {tab === 'clients' && (
          <>
            <input placeholder="Chercher un nom ou un e-mail" value={search} onChange={(e) => setSearch(e.target.value)} />
            <ul className="money-list">
              {users.map((u) => (
                <li key={u.user_id}>
                  <div>
                    <strong>
                      {u.name} {u.installed ? '📲' : ''} {u.rating ? `· ★ ${u.rating}` : ''}
                    </strong>
                    <small>{u.email}</small>
                    <small>
                      Inscrit {ago(u.created_at)} · {u.last_seen_at ? `vu ${ago(u.last_seen_at)}` : 'pas revu'} · {u.trips} trajet(s), {u.requests} demande(s), {u.completed} terminé(s)
                    </small>
                  </div>
                  <span className="admin-side">
                    {u.wallet_cents !== 0 && <b className={u.wallet_cents < 0 ? 'minus' : ''}>{euros(u.wallet_cents)}</b>}
                    <button className={u.user_id in blocked ? 'chip on warn' : 'chip'} onClick={() => toggleBlock(u)}>
                      {u.user_id in blocked ? 'Suspendu · réactiver' : 'Suspendre'}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {users.length === 0 && <small className="money-note">Personne.</small>}
          </>
        )}

        {tab === 'activite' && (
          <>
            <div className="chips admin-filters">
              {KINDS.map(([k, l]) => (
                <button key={k} className={kind === k ? 'chip on' : 'chip'} onClick={() => setKind(k)}>
                  {l}
                </button>
              ))}
            </div>
            <ul className="money-list">
              {events.map((e, i) => (
                <li key={i}>
                  <div>
                    <strong>
                      {ICON[e.kind] ?? '•'} {e.who}
                    </strong>
                    <small>{e.detail}</small>
                  </div>
                  <small>{ago(e.at)}</small>
                </li>
              ))}
            </ul>
            {events.length === 0 && <small className="money-note">Rien pour ce filtre.</small>}
          </>
        )}

        {tab === 'argent' && o && (
          <>
            <div className="kpis">
              <Kpi label="Tes frais de service" value={euros(o.fees_total)} hint={`${euros(o.fees_30d)} sur 30 jours`} tone="good" />
              <Kpi label="Volume des trajets" value={euros(o.volume_total)} hint={`${euros(o.volume_30d)} sur 30 jours`} />
              <Kpi label="Payés par carte" value={o.card_rides} hint={pct(o.card_rides, o.card_rides + o.cash_rides) + ' des trajets'} />
              <Kpi label="Payés en espèces" value={o.cash_rides} />
              <Kpi label="Dû aux chauffeurs" value={euros(Math.max(0, o.wallets_total + o.cash_fees_due))} hint="soldes des porte-monnaie" />
              <Kpi label="Frais d’espèces à récupérer" value={euros(o.cash_fees_due)} tone={o.cash_fees_due ? 'warn' : undefined} />
              <Kpi label="Déjà retiré" value={euros(o.withdrawn)} />
            </div>
            <small className="money-note">Mode test : ces montants ne sont pas de l’argent réel. Les frais Stripe ne sont pas déduits ici.</small>
          </>
        )}

        {tab === 'reglages' && pricing && (
          <>
            <h3 className="section">Prix conseillé d’un trajet</h3>
            <div className="admin-form">
              {([
                ['price_base', 'Part fixe (centimes)'],
                ['km_short', 'Par km, de 0 à 20 km (centimes)'],
                ['km_mid', 'Par km, de 20 à 60 km (centimes)'],
                ['km_long', 'Par km, au-delà de 60 km (centimes)'],
                ['price_min', 'Prix minimum (centimes)'],
              ] as [string, string][]).map(([k, l]) => (
                <label key={k}>
                  {l}
                  <input type="number" inputMode="numeric" value={pricing[k]} onChange={(e) => setPricing({ ...pricing, [k]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
            <h3 className="section">Frais de service</h3>
            <div className="admin-form">
              <label>
                Part fixe (centimes)
                <input type="number" inputMode="numeric" value={pricing.fee_fixed} onChange={(e) => setPricing({ ...pricing, fee_fixed: Number(e.target.value) })} />
              </label>
              <label>
                Pourcentage du prix (%)
                <input type="number" inputMode="decimal" step="0.5" value={pricing.fee_percent} onChange={(e) => setPricing({ ...pricing, fee_percent: Number(e.target.value) })} />
              </label>
            </div>
            <small className="money-note">
              Aperçu : 5 km → {euros(price(5))} (frais {euros(fee(price(5)))}) · 20 km → {euros(price(20))} (frais {euros(fee(price(20)))}) · 45 km → {euros(price(45.5))} (frais {euros(fee(price(45.5)))}) · 100 km → {euros(price(100))} (frais {euros(fee(price(100)))})
            </small>
            <button className="primary big" onClick={savePricing}>
              Enregistrer les barèmes
            </button>
            {saved && <small className="money-note">{saved}</small>}
            <small className="money-note">Les trajets déjà publiés et les mises en relation existantes gardent leurs prix et leurs frais.</small>
          </>
        )}

        {tab === 'plus' && (
          <ul className="money-list">
            {['Traiter les réclamations et répondre', 'Codes promo et parrainage', 'Rembourser un trajet à la main', 'Exporter en tableur'].map((t) => (
              <li key={t}>
                <div>
                  <strong>{t}</strong>
                  <small>À venir</small>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
