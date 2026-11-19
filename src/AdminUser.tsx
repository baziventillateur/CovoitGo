import { useEffect, useState, type ReactNode } from 'react';
import { supabase } from './supabase';
import { ago, euros } from './format';

type Tab = 'historique' | 'trajets' | 'avis' | 'argent' | 'compte';
const STATUS: Record<string, string> = {
  open: 'ouvert', full: 'complet ou parti', paused: 'suspendu', done: 'terminé', cancelled: 'annulé', matched: 'confirmé',
  proposed: 'en attente', accepted: 'confirmé', declined: 'refusé', completed: 'terminé',
};
const WALLET: Record<string, string> = {
  ride: 'Trajet payé par carte', cash_fee: 'Frais de service (espèces)', withdrawal: 'Retrait', refund: 'Remboursement', adjustment: 'Ajustement', topup: 'Recharge par carte',
};
const day = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// Liste repliée : cinq lignes, puis « Tout voir ».
function Rows<T>({ items, render, empty }: { items: T[]; render: (x: T, i: number) => ReactNode; empty: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <small className="money-note">{empty}</small>;
  return (
    <>
      <ul className="money-list">{(all ? items : items.slice(0, 5)).map(render)}</ul>
      {!all && items.length > 5 && (
        <button className="link center" onClick={() => setAll(true)}>
          Tout voir ({items.length})
        </button>
      )}
    </>
  );
}

// Fiche d'un compte, pour l'admin : version simple d'abord, détail par onglets ensuite.
// Chaque nom est cliquable et ouvre la fiche de la personne.
export function AdminUser({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [stack, setStack] = useState<string[]>([userId]);
  const id = stack[stack.length - 1];
  const [u, setU] = useState<any>(null);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(false);
  const [tab, setTab] = useState<Tab>('historique');

  useEffect(() => {
    setU(null);
    setError('');
    supabase.rpc('admin_user_detail', { p_user: id }).then(({ data, error }) => (error ? setError(error.message) : setU(data)));
  }, [id]);

  const open = (other: string) => setStack([...stack, other]);
  const Name = ({ id: other, name }: { id: string; name: string }) => (
    <button className="link name-link" onClick={() => open(other)}>
      {name}
    </button>
  );

  // Une phrase par mise en relation : qui a proposé, accepté, terminé, annulé.
  const phrase = (m: any) => {
    const other = <Name id={m.other_id} name={m.other_name} />;
    const driver = m.role === 'driver';
    if (m.status === 'completed') return <>a covoituré avec {other} ({driver ? 'conducteur' : 'passager'})</>;
    if (m.status === 'accepted')
      return m.proposed_by_me ? <>{other} a accepté sa {driver ? 'proposition' : 'demande'}</> : <>a accepté {driver ? 'la demande' : 'le voyage'} de {other}</>;
    if (m.status === 'declined') return m.proposed_by_me ? <>{other} a refusé sa {driver ? 'proposition' : 'demande'}</> : <>a refusé {driver ? 'la demande' : 'la proposition'} de {other}</>;
    if (m.status === 'cancelled') return <>trajet annulé avec {other}</>;
    return m.proposed_by_me ? <>a {driver ? 'proposé une place à' : 'demandé une place à'} {other}</> : <>a reçu une {driver ? 'demande' : 'proposition'} de {other}</>;
  };

  const done = u ? u.matches.filter((m: any) => m.status === 'completed').length : 0;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet admin" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>
            {stack.length > 1 && (
              <button className="ghost small" onClick={() => setStack(stack.slice(0, -1))}>
                ‹
              </button>
            )}{' '}
            {u?.name ?? 'Fiche'}
          </h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        {error && <small className="error">{error}</small>}
        {!u && !error && <p className="muted center">Chargement…</p>}

        {u && (
          <>
            <div className="chips">
              {u.blocked && <span className="chip on warn">Suspendu</span>}
              {u.admin && <span className="chip on">Admin</span>}
              {u.installed && <span className="chip">📲 Installée</span>}
              {u.push && <span className="chip">🔔 Notifs</span>}
              {u.payout_ready && <span className="chip">🏦 RIB vérifié</span>}
            </div>
            <div className="kpis">
              <div className="kpi"><small>Inscrit</small><strong className="sm">{ago(u.created_at)}</strong><em>{u.last_seen_at ? `vu ${ago(u.last_seen_at)}` : 'pas revu depuis'}</em></div>
              <div className="kpi good"><small>Covoiturages terminés</small><strong>{done}</strong><em>{u.trips.length} trajet(s) · {u.requests.length} demande(s)</em></div>
              <div className="kpi"><small>Note reçue</small><strong>{u.rating ? `★ ${u.rating}` : '—'}</strong><em>{u.reviews_received.length} avis</em></div>
              <div className="kpi"><small>Porte-monnaie</small><strong className={u.wallet < 0 ? 'neg' : ''}>{euros(u.wallet)}</strong><em>{u.points} points</em></div>
            </div>
            <small className="money-note">{u.email}{u.phone ? ` · ${u.phone}` : ''}</small>

            {!detail ? (
              <button className="primary big" onClick={() => setDetail(true)}>
                Voir le détail
              </button>
            ) : (
              <>
                <div className="chips admin-tabs">
                  {([['historique', 'Historique'], ['trajets', 'Trajets'], ['avis', 'Avis'], ['argent', 'Argent'], ['compte', 'Compte']] as [Tab, string][]).map(([t, l]) => (
                    <button key={t} className={tab === t ? 'chip on' : 'chip'} onClick={() => setTab(t)}>
                      {l}
                    </button>
                  ))}
                </div>

                {tab === 'historique' && (
                  <Rows
                    items={u.matches}
                    empty="Aucune mise en relation."
                    render={(m: any, i) => (
                      <li key={i}>
                        <div>
                          <strong>{u.name} {phrase(m)}</strong>
                          <small>{m.label}{m.cents ? ` · ${euros(m.cents)}` : ''} · {m.pay_method === 'card' ? (m.refunded ? 'carte, remboursé' : m.paid ? 'carte, payé' : 'carte, non payé') : 'espèces'}</small>
                        </div>
                        <small>{day(m.at)}</small>
                      </li>
                    )}
                  />
                )}

                {tab === 'trajets' && (
                  <>
                    <h3 className="section">Trajets publiés (conducteur)</h3>
                    <Rows items={u.trips} empty="Aucun trajet publié." render={(t: any, i) => (
                      <li key={i}><div><strong>{t.label}</strong><small>Départ {day(t.when)} · {STATUS[t.status] ?? t.status} · {euros(t.cents)} · {t.seats_taken}/{t.seats} place(s)</small></div><small>{ago(t.at)}</small></li>
                    )} />
                    <h3 className="section">Recherches (passager)</h3>
                    <Rows items={u.requests} empty="Aucune recherche." render={(r: any, i) => (
                      <li key={i}><div><strong>{r.label}</strong><small>Départ {day(r.when)} · {STATUS[r.status] ?? r.status} · {r.seats} place(s) · {r.pay_method === 'card' ? 'carte' : 'espèces'}</small></div><small>{ago(r.at)}</small></li>
                    )} />
                  </>
                )}

                {tab === 'avis' && (
                  <>
                    <h3 className="section">Avis reçus</h3>
                    <Rows items={u.reviews_received} empty="Aucun avis reçu." render={(r: any, i) => (
                      <li key={i}><div><strong>{'★'.repeat(r.rating)} par <Name id={r.other_id} name={r.other_name} /></strong>{r.comment && <small>« {r.comment} »</small>}</div><small>{ago(r.at)}</small></li>
                    )} />
                    <h3 className="section">Avis donnés</h3>
                    <Rows items={u.reviews_given} empty="Aucun avis donné." render={(r: any, i) => (
                      <li key={i}><div><strong>{'★'.repeat(r.rating)} à <Name id={r.other_id} name={r.other_name} /></strong>{r.comment && <small>« {r.comment} »</small>}</div><small>{ago(r.at)}</small></li>
                    )} />
                  </>
                )}

                {tab === 'argent' && (
                  <>
                    <div className="kpis">
                      <div className="kpi good"><small>Reçu comme conducteur</small><strong>{euros(u.earned)}</strong><em>net de frais</em></div>
                      <div className="kpi"><small>Dépensé comme passager</small><strong>{euros(u.spent)}</strong></div>
                      <div className="kpi"><small>Frais de service générés</small><strong>{euros(u.fees)}</strong></div>
                      <div className="kpi"><small>Solde du porte-monnaie</small><strong className={u.wallet < 0 ? 'neg' : ''}>{euros(u.wallet)}</strong></div>
                    </div>
                    <h3 className="section">Mouvements du porte-monnaie</h3>
                    <Rows items={u.wallet_entries} empty="Aucun mouvement." render={(w: any, i) => (
                      <li key={i}><div><strong>{WALLET[w.kind] ?? w.kind}</strong><small>{day(w.at)}</small></div><b className={w.cents < 0 ? 'minus' : ''}>{w.cents > 0 ? '+' : '−'}{euros(Math.abs(w.cents))}</b></li>
                    )} />
                  </>
                )}

                {tab === 'compte' && (
                  <>
                    <ul className="money-list">
                      <li><div><strong>E-mail</strong><small>{u.email}</small></div></li>
                      <li><div><strong>Téléphone</strong><small>{u.phone ?? 'non renseigné'}</small></div></li>
                      <li><div><strong>Véhicule</strong><small>{u.vehicle ? `${u.vehicle.model}${u.vehicle.color ? ', ' + u.vehicle.color : ''} · ${u.vehicle.plate}` : 'non renseigné'}</small></div></li>
                      <li><div><strong>Détour maximum</strong><small>{u.max_detour ?? 15} min</small></div></li>
                      <li><div><strong>E-mails de trajet</strong><small>{u.emails ? 'activés' : 'coupés'}</small></div></li>
                      <li><div><strong>Statut</strong><small>{u.blocked ? `suspendu${u.block_reason ? ' : ' + u.block_reason : ''}` : 'actif'}</small></div></li>
                      <li><div><strong>Identifiant</strong><small>{u.id}</small></div></li>
                    </ul>
                    <h3 className="section">Réclamations</h3>
                    <Rows items={u.claims} empty="Aucune réclamation." render={(c: any, i) => (
                      <li key={i}><div><strong>{c.category} · {c.status}</strong><small>{c.message}</small></div><small>{ago(c.at)}</small></li>
                    )} />
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
