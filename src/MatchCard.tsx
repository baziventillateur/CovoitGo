import type { Match } from './api';
import { euros, fmt } from './format';

const STAGES = ['scheduled', 'driver_en_route', 'driver_arrived', 'on_board'] as const;
const STEP_LABELS = ['Confirmé', 'En route', 'Au rendez-vous', 'À bord'];

type Props = { m: Match; busy: boolean; onAdvance: () => void; onCancel: () => void };

// Carte d'un trajet accepté : étapes en direct, coordonnées, action suivante.
export function MatchCard({ m, busy, onAdvance, onCancel }: Props) {
  const driver = m.role === 'driver';
  const step = STAGES.indexOf(m.stage);
  const name = m.other_name;

  let emoji = '📅';
  let title = `Rendez-vous ${fmt(m.meet_at)}`;
  let sub = driver ? `Tu passes prendre ${name}` : `${name} n’est pas encore parti`;
  let action: string | null = driver ? `Je pars chercher ${name}` : null;

  if (m.stage === 'driver_en_route') {
    emoji = '🚗';
    title = driver ? `Va chercher ${name}` : `${name} arrive !`;
    sub = driver ? m.pickup_label : 'Prépare-toi, ton chauffeur est en route';
    action = driver ? 'Je suis arrivé' : 'Je suis à bord';
  } else if (m.stage === 'driver_arrived') {
    emoji = '📍';
    title = driver ? `En attente de ${name}…` : `${name} t’attend`;
    sub = driver ? 'Ton passager doit confirmer qu’il est monté' : 'Ton chauffeur est au point de rendez-vous';
    action = driver ? null : 'Je suis à bord';
  } else if (m.stage === 'on_board') {
    emoji = '🛣️';
    title = driver ? `${name} est à bord` : 'C’est parti !';
    sub = `Direction ${m.dropoff_label}`;
    action = driver ? 'Trajet terminé' : null;
  }

  return (
    <div className="card live">
      <div className="live-head">
        <span className="live-emoji">{emoji}</span>
        <div>
          <strong>{title}</strong>
          <small>{sub}</small>
        </div>
      </div>

      <ol className="steps">
        {STEP_LABELS.map((label, i) => (
          <li key={label} className={i < step ? 'done' : i === step ? 'current' : ''}>
            <span className="dot" />
            {label}
          </li>
        ))}
      </ol>

      <div className="contact">
        <div className="avatar">{name.charAt(0).toUpperCase()}</div>
        <div className="contact-info">
          <strong>{name}</strong>
          <small>{driver ? 'Ton passager' : 'Ton chauffeur'}</small>
        </div>
        {m.other_phone ? (
          <a className="call" href={`tel:${m.other_phone}`}>
            📞 {m.other_phone}
          </a>
        ) : (
          <small>Numéro non renseigné</small>
        )}
      </div>

      <dl className="route">
        <dt>Montée</dt>
        <dd>{m.pickup_label}</dd>
        <dt>Descente</dt>
        <dd>{m.dropoff_label}</dd>
        {m.cost_share_cents > 0 && (
          <>
            <dt>Participation</dt>
            <dd>{euros(m.cost_share_cents)}</dd>
          </>
        )}
      </dl>

      {action && (
        <button className="primary big" disabled={busy} onClick={onAdvance}>
          {action}
        </button>
      )}
      {m.stage !== 'on_board' && (
        <button className="link center danger" disabled={busy} onClick={onCancel}>
          Annuler ce trajet
        </button>
      )}
    </div>
  );
}
