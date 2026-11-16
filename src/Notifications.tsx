import { useEffect, useState } from 'react';
import { api, type Match, type Mode, type Notification } from './api';
import { ago, fmt } from './format';

const ICONS: Record<string, string> = {
  proposal: '✋',
  accepted: '🎉',
  declined: '🙅',
  cancelled: '❌',
  completed: '🏁',
  stage: '🚗',
  review: '⭐',
};

type Props = { items: Notification[]; onClose: () => void; onOpen: (role: Mode) => void };
type Group = { key: string; role: Mode; items: Notification[]; unread: number };

// Les notifications sont regroupées par trajet : une carte par personne et par voyage,
// avec le récapitulatif en tête et le fil des évènements en dessous.
export function Notifications({ items, onClose, onOpen }: Props) {
  const [matches, setMatches] = useState<Record<string, Match>>({});

  useEffect(() => {
    api
      .matches()
      .then((list) => setMatches(Object.fromEntries(list.map((m) => [m.id, m]))))
      .catch(() => {});
  }, []);

  const groups: Group[] = [];
  for (const n of items) {
    const key = n.match_id ?? `n${n.id}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, role: n.role, items: [], unread: 0 }));
    g.items.push(n);
    if (!n.read_at) g.unread += 1;
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Notifications</h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        {groups.length === 0 && <p className="muted center">Rien pour l’instant.</p>}
        <ul className="notifs">
          {groups.map((g) => {
            const m = matches[g.key];
            return (
              <li key={g.key} className={g.unread ? 'unread' : ''}>
                <button onClick={() => onOpen(g.role)}>
                  <span className="avatar">{m ? m.other_name.charAt(0).toUpperCase() : '🔔'}</span>
                  <span className="contact-info">
                    <strong>
                      {m ? m.other_name : g.items[0].title}
                      <span className="tag">{g.role === 'driver' ? 'Ton passager' : 'Ton chauffeur'}</span>
                      {g.unread > 0 && <span className="count inline">{g.unread}</span>}
                    </strong>
                    {m && (
                      <span className="trip-line">
                        {m.pickup_label} → {m.dropoff_label} · {fmt(m.meet_at)}
                      </span>
                    )}
                    <span className="events">
                      {g.items.slice(0, 4).map((n) => (
                        <span key={n.id} className={n.read_at ? 'event' : 'event fresh'}>
                          <span>{ICONS[n.kind] ?? '🔔'}</span>
                          <span className="event-text">
                            {n.title}
                            {n.kind === 'review' && ` · ${n.body}`}
                          </span>
                          <small>{ago(n.created_at)}</small>
                        </span>
                      ))}
                      {g.items.length > 4 && <small>+ {g.items.length - 4} plus anciennes</small>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
