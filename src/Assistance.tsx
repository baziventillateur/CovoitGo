import { useState } from 'react';
import { api, type Match, type Notify } from './api';

// Page du support : c'est la seule où le chat en direct est chargé.
export const SUPPORT_URL = import.meta.env.BASE_URL + 'support.html';

const REASONS = [
  { code: 'retard', label: 'Retard' },
  { code: 'absence', label: 'Personne absente' },
  { code: 'comportement', label: 'Comportement' },
  { code: 'securite', label: 'Sécurité' },
  { code: 'autre', label: 'Autre' },
];

type Props = { m: Match; notify: Notify; onClose: () => void };

export function Assistance({ m, notify, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      await api.claim(m.id, reason, message);
      notify('Réclamation envoyée. Nous revenons vers toi.');
      onClose();
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setBusy(false);
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet form" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>🛟 Assistance</h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        <small>
          Trajet {m.pickup_label} → {m.dropoff_label} avec {m.other_name}
        </small>
        <p className="urgent">En cas de danger immédiat, appelle le 112.</p>
        <a className="primary big link-btn" href={SUPPORT_URL} target="_blank" rel="noopener">
          💬 Discuter en direct avec le support
        </a>
        <div className="field">
          <span>Ou laisser une réclamation écrite : quel est le problème ?</span>
          <div className="chips">
            {REASONS.map((r) => (
              <button type="button" key={r.code} className={reason === r.code ? 'chip on' : 'chip'} onClick={() => setReason(r.code)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <textarea rows={3} maxLength={1000} placeholder="Explique ce qui s’est passé" value={message} onChange={(e) => setMessage(e.target.value)} />
        <small>Ta réclamation n’est pas visible par {m.other_name}.</small>
        <button className="ghost big" disabled={busy || !reason || message.trim().length < 5} onClick={send}>
          Envoyer la réclamation
        </button>
      </div>
    </div>
  );
}
