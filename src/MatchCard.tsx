import type { Match } from './api';
import { euros, fmt, fmtDuration } from './format';

import { Rating } from './Reviews';
import { TripTracker } from './TripTracker';
import { TrafficTag } from './Traffic';
import { Approach } from './Approach';

type Props = {
  m: Match;
  busy: boolean;
  onPay: () => void;
  onAdvance: () => void;
  onCancel: () => void;
  onUser: () => void;
  onHelp: () => void;
  onMessage: () => void;
  unread: number;
  meName: string;
};

// Carte d'un trajet accepté : étapes en direct, coordonnées, action suivante.
export function MatchCard({ m, busy, onPay, onAdvance, onCancel, onUser, onHelp, onMessage, unread, meName }: Props) {
  const driver = m.role === 'driver';
  const name = m.other_name;
  const unpaid = m.pay_method === 'card' && !m.paid_at;

  let emoji = '🕒';
  let riding = false;
  let title = `Rendez-vous ${fmt(m.meet_at)}`;
  let sub = driver ? `Tu passes prendre ${name}` : `${name} n’est pas encore parti`;
  let action: string | null = driver ? `Je pars chercher ${name}` : null;

  if (m.stage === 'driver_en_route') {
    emoji = '🚗';
    title = driver ? `Va chercher ${name}` : `${name} arrive !`;
    const fresh = m.driver_seen_at && Date.now() - new Date(m.driver_seen_at).getTime() < 3 * 60_000;
    const km = m.driver_distance_m != null ? (m.driver_distance_m < 950 ? `${Math.round(m.driver_distance_m / 50) * 50} m` : `${(m.driver_distance_m / 1000).toFixed(1).replace('.', ',')} km`) : null;
    sub = driver ? m.pickup_label : fresh && km ? `Ton chauffeur est à ${km} du rendez-vous` : 'Prépare-toi, ton chauffeur est en route';
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
      {driver && m.stage === 'driver_en_route' && <Approach matchId={m.id} name={name} />}

      <div className="contact">
        <div className="avatar">{name.charAt(0).toUpperCase()}</div>
        <button className="contact-info person" onClick={onUser}>
          <strong>{name}</strong>
          <small>{driver ? 'Ton passager' : 'Ton chauffeur'}</small>
          <Rating rating={m.other_rating} reviews={m.other_reviews} />
        </button>
        <div className="contact-actions">
          <button className={'msg-btn' + (unread ? ' has-unread' : '')} onClick={onMessage}>
            💬 Message
            {unread > 0 && <span className="count">{unread}</span>}
          </button>
          {m.other_phone && (
            <a className="call icon" href={`tel:${m.other_phone}`} aria-label={`Appeler ${name} au ${m.other_phone}`}>
              📞
            </a>
          )}
        </div>
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
        {m.ride_minutes && (
          <>
            <dt>Durée</dt>
            <dd>
              ≈ {fmtDuration(m.ride_minutes)}
              <TrafficTag minutes={m.ride_minutes} delay={m.traffic_delay_min} />
            </dd>
          </>
        )}
        <dt>Paiement</dt>
        <dd>
          {m.pay_method === 'card' ? (m.paid_at ? '💳 Carte · payé ✓' : '💳 Carte · en attente') : '💶 Espèces, au début du trajet'}
          {driver && m.price_cents ? ` · tu reçois ${euros(m.price_cents - (m.fee_cents ?? 0))}` : ''}
        </dd>
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

      {unpaid && !driver && (
        <button className="primary big" disabled={busy} onClick={onPay}>
          💳 Payer {euros(m.price_cents ?? m.cost_share_cents)} par carte
        </button>
      )}
      {unpaid && driver && <small className="wait-pay">⏳ En attente du paiement de {name}. Tu pourras partir dès qu’il aura payé.</small>}
      {action && !(unpaid && driver && m.stage === 'scheduled') && (
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
