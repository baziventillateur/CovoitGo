import type { Mode, Notification } from './api';
import { ago } from './format';

const ICONS: Record<string, string> = {
  proposal: '✋',
  accepted: '🎉',
  declined: '🙅',
  cancelled: '❌',
  completed: '🏁',
  stage: '🚗',
};

type Props = { items: Notification[]; onClose: () => void; onOpen: (role: Mode) => void };

export function Notifications({ items, onClose, onOpen }: Props) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Notifications</h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        {items.length === 0 && <p className="muted center">Rien pour l’instant.</p>}
        <ul className="notifs">
          {items.map((n) => (
            <li key={n.id} className={n.read_at ? '' : 'unread'}>
              <button onClick={() => onOpen(n.role)}>
                <span className="notif-icon">{ICONS[n.kind] ?? '🔔'}</span>
                <span className="contact-info">
                  <strong>{n.title}</strong>
                  <small>{n.body}</small>
                  <small>
                    {ago(n.created_at)} · {n.role === 'driver' ? 'Conducteur' : 'Passager'}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
