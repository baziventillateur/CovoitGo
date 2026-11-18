import type { Match } from './api';
import { euros, fmt } from './format';

import { Rating } from './Reviews';
import { TripTracker } from './TripTracker';

type Props = { m: Match; busy: boolean; onAdvance: () => void; onCancel: () => void; onUser: () => void; onHelp: () => void; meName: string };

// Carte d'un trajet accepté : étapes en direct, coordonnées, action suivante.
export function MatchCard({ m, busy, onAdvance, onCancel, onUser, onHelp, meName }: Props) {
  const driver = m.role === 'driver';
  const name = m.other_name;

  let emoji = '🕒';
  let riding = false;
  let title = `Rendez-vous ${fmt(m.meet_at)}`;
  let sub = driver ? `Tu passes prendre ${name}` : `${name} n’est pas encore parti`;
  let action: string | null = driver ? `Je pars chercher ${name}` : null;

  if (m.stage === 'driver_en_route') {
    emoji = '🚗';
    title = driver ? `Va chercher ${name}` : `${name} arrive !`;
    sub = driver ? m.pickup_label : 'Prépare-toi, ton chauffeur est en route';
    action = driver ? 'Je suis arrivé' : null;
  } else if (m.stage === 'driver_arrived' || m.stage === 'on_board') {
    emoji = '🚗';
    riding = true;
    title = 'Covoiturage en cours';
    sub = driver ? `Dépose ${name} à ${m.dropoff_label}, puis termine le trajet` : `Direction ${m.dropoff_label}. Bon trajet !`;
    action = driver ? 'Trajet terminé' : null;
  }

  return (
    <div className="live embedded">
      <div className="live-head">
        <span className={riding ? 'live-emoji riding' : 'live-emoji'}>{emoji}</span>
        <div>
          <strong>{title}</strong>
          <small>{sub}</small>
        </div>
      </div>

      <TripTracker m={m} meName={meName} />

      <div className="contact">
        <div className="avatar">{name.charAt(0).toUpperCase()}</div>
        <button className="contact-info person" onClick={onUser}>
          <strong>{name}</strong>
          <small>{driver ? 'Ton passager' : 'Ton chauffeur'}</small>
          <Rating rating={m.other_rating} reviews={m.other_reviews} />
        </button>
        {m.other_phone ? (
          <a className="call" href={`tel:${m.other_phone}`}>
            📞 {m.other_phone}
          </a>
        ) : (
          <small>Numéro non renseigné</small>
        )}
      </div>

      {!driver && (
        <div className="vehicle">
          <span>🚘</span>
          {m.vehicle_plate ? (
            <div>
              <strong>
                {m.vehicle_model}
                {m.vehicle_color && ` · ${m.vehicle_color}`}
              </strong>
              <span className="plate">{m.vehicle_plate}</span>
            </div>
          ) : (
            <small>Véhicule non renseigné par {name}</small>
          )}
        </div>
      )}

      <dl className="route">
        <dt>Montée</dt>
        <dd>{m.pickup_label}</dd>
        <dt>Descente</dt>
        <dd>{m.dropoff_label}</dd>
        {driver && (
          <>
            <dt>Passagers</dt>
            <dd>{m.seats === 1 ? '1 personne' : `${m.seats} personnes`}</dd>
          </>
        )}
        {driver && m.note && (
          <>
            <dt>Message</dt>
            <dd>{m.note}</dd>
          </>
        )}
        {m.cost_share_cents > 0 && (
          <>
            <dt>{driver ? 'Tu reçois' : 'À payer'}</dt>
            <dd>{euros(m.cost_share_cents)}</dd>
          </>
        )}
      </dl>

      {action && (
        <button className="primary big" disabled={busy} onClick={onAdvance}>
          {action}
        </button>
      )}
      <div className="card-foot">
        <button className="ghost small" onClick={onHelp}>
          🛟 Assistance
        </button>
        {(m.stage === 'scheduled' || m.stage === 'driver_en_route') && (
          <button className="link danger" disabled={busy} onClick={onCancel}>
            Annuler ce trajet
          </button>
        )}
      </div>
    </div>
  );
}
