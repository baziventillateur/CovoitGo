import { useEffect, useState } from 'react';
import { api, type HistoryItem, type Mode, type Notify } from './api';
import { euros, fmtTime } from './format';
import { UserSheet } from './Reviews';
import { dayLabel } from './offers';

const SHOWN = 5;

// Mes trajets : l'historique des trajets réalisés. Les 5 derniers, puis « Tout voir ».
export function History({ mode, refreshKey, notify }: { mode: Mode; refreshKey: number; notify: Notify }) {
  const driver = mode === 'driver';
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [all, setAll] = useState(false);
  const [viewUser, setViewUser] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    setItems(null);
    api
      .history(mode)
      .then(setItems)
      .catch((e) => {
        setItems([]);
        notify((e as Error).message, 'err');
      });
  }, [mode, refreshKey, notify]);

  const total = (items ?? []).reduce((s, h) => s + (h.cents ?? 0), 0);

  function row(h: HistoryItem) {
    return (
      <li className="history-row" key={h.listing_id + h.done_at}>
        <span className="history-check" aria-hidden="true">
          ✓
        </span>
        <div className="history-info">
          <strong>
            {h.origin_label} → {h.dest_label}
          </strong>
          <small>
            {dayLabel(h.depart_at)} · {fmtTime(h.depart_at)} · avec{' '}
            {h.people.map((p, i) => (
              <span key={p.id + i}>
                {i > 0 && (i === h.people.length - 1 ? ' et ' : ', ')}
                <button className="person name-link" onClick={() => setViewUser({ id: p.id, name: p.name })}>
                  {p.name}
                </button>
              </span>
            ))}
          </small>
        </div>
        {h.cents != null && h.cents > 0 && <b className={driver ? 'plus' : ''}>{driver ? `+${euros(h.cents)}` : euros(h.cents)}</b>}
      </li>
    );
  }

  // Liste complète : groupée par mois.
  const months: { label: string; list: HistoryItem[] }[] = [];
  for (const h of items ?? []) {
    const label = new Date(h.depart_at).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const last = months[months.length - 1];
    if (last?.label === label) last.list.push(h);
    else months.push({ label, list: [h] });
  }

  return (
    <>
      <h2 className="page-title">Mes trajets</h2>
      {items === null && <p className="muted center">Chargement…</p>}
      {items?.length === 0 && (
        <div className="card empty">
          <div className="empty-emoji">🛣️</div>
          <strong>Aucun trajet réalisé pour l’instant</strong>
          <p>Chaque covoiturage terminé s’ajoute ici, avec les personnes et le montant.</p>
        </div>
      )}
      {!!items?.length && (
        <div className="card history">
          <div className="history-sum">
            <span>
              <strong>{items.length}</strong> trajet{items.length > 1 ? 's' : ''} réalisé{items.length > 1 ? 's' : ''}
            </span>
            {total > 0 && (
              <span>
                <strong>{euros(total)}</strong> {driver ? 'reçus' : 'dépensés'}
              </span>
            )}
          </div>
          <ul className="history-list">{items.slice(0, SHOWN).map(row)}</ul>
          {items.length > SHOWN && (
            <button className="ghost small" onClick={() => setAll(true)}>
              Tout voir ({items.length})
            </button>
          )}
        </div>
      )}

      {all && (
        <div className="sheet-backdrop" onClick={() => setAll(false)}>
          <div className="sheet history-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <strong>Tous mes trajets</strong>
              <button className="ghost small" onClick={() => setAll(false)}>
                Fermer
              </button>
            </div>
            {months.map((m) => (
              <section key={m.label}>
                <h4 className="month">{m.label}</h4>
                <ul className="history-list">{m.list.map(row)}</ul>
              </section>
            ))}
          </div>
        </div>
      )}
      {viewUser && <UserSheet userId={viewUser.id} name={viewUser.name} onClose={() => setViewUser(null)} />}
    </>
  );
}
