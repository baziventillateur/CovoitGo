import { useEffect, useState } from 'react';
import { api, type Mode, type MoneyRow } from './api';
import { euros } from './format';

const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
const round = (cents: number) => (cents % 100 === 0 ? `${cents / 100} €` : euros(cents));

// Mes comptes : ce que j'ai reçu comme conducteur, ce que j'ai dépensé comme passager.
// Les montants sont ceux convenus dans l'appli ; le règlement se fait entre les personnes.
export function Money({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const [rows, setRows] = useState<MoneyRow[] | null>(null);
  const [tab, setTab] = useState<Mode>(mode);

  useEffect(() => {
    api.money().then(setRows).catch(() => setRows([]));
  }, []);

  const driver = tab === 'driver';
  const mine = (rows ?? []).filter((r) => r.role === tab);
  const total = mine.reduce((s, r) => s + r.cents, 0);
  const other = (rows ?? []).filter((r) => r.role !== tab).reduce((s, r) => s + r.cents, 0);

  // Six derniers mois, du plus ancien au plus récent.
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)).map((d) => ({
    d,
    cents: mine.filter((r) => monthKey(new Date(r.at)) === monthKey(d)).reduce((s, r) => s + r.cents, 0),
  }));
  const max = Math.max(1, ...months.map((m) => m.cents));
  const thisMonth = months[5].cents;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet money ${tab}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Mes comptes</h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        <div className="chips">
          <button className={driver ? 'chip on' : 'chip'} onClick={() => setTab('driver')}>
            🚗 Reçu
          </button>
          <button className={!driver ? 'chip on' : 'chip'} onClick={() => setTab('passenger')}>
            🎒 Dépensé
          </button>
        </div>

        <div className="money-kpi">
          <small>{driver ? 'Tu as reçu' : 'Tu as dépensé'}</small>
          <strong key={tab}>{euros(total)}</strong>
          <small>
            {mine.length
              ? `${mine.length} trajet${mine.length > 1 ? 's' : ''} · moyenne ${euros(Math.round(total / mine.length))} · ce mois-ci ${euros(thisMonth)}`
              : driver
                ? 'Aucun trajet terminé comme conducteur pour l’instant.'
                : 'Aucun trajet terminé comme passager pour l’instant.'}
          </small>
        </div>

        <div className="money-bars">
          {months.map((m, i) => (
            <div key={i} className={i === 5 ? 'bar now' : 'bar'}>
              <span>{m.cents ? round(m.cents) : ''}</span>
              <i style={{ height: `${Math.max(m.cents ? 6 : 2, (m.cents / max) * 100)}%` }} />
              <em>{m.d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '')}</em>
            </div>
          ))}
        </div>

        {rows && rows.length > 0 && other > 0 && total > 0 && (
          <small className="money-net">
            Bilan : reçu {euros(driver ? total : other)} − dépensé {euros(driver ? other : total)} ={' '}
            <b>{euros(Math.abs((driver ? total : other) - (driver ? other : total)))}</b>{' '}
            {(driver ? total : other) >= (driver ? other : total) ? 'en ta faveur' : 'de dépense nette'}
          </small>
        )}

        <ul className="money-list">
          {mine.slice(0, 60).map((r) => (
            <li key={r.match_id}>
              <div>
                <strong>
                  {r.from_label} → {r.to_label}
                </strong>
                <small>
                  {new Date(r.at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </small>
              </div>
              <b>
                {driver ? '+' : '−'}
                {euros(r.cents)}
              </b>
            </li>
          ))}
        </ul>
        {rows === null && <p className="muted center">Chargement…</p>}
        <small className="money-note">Montants convenus dans l’appli. Le règlement se fait directement entre vous.</small>
      </div>
    </div>
  );
}
