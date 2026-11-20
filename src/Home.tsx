import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Candidate, type Listing, type Match, type Mode, type Notify } from './api';
import { TrafficTag } from './Traffic';
import { RouteMap } from './RouteMap';
import { MatchCard } from './MatchCard';
import { euros, fmt, fmtDuration, fmtTime } from './format';
import { Rating, ReviewCard, UserSheet } from './Reviews';
import { ConfirmDialog } from './ConfirmDialog';
import { Assistance } from './Assistance';
import { Wallet } from './Wallet';
import { busyListings, dayLabel, groupOffers, listingOf, shownIds } from './offers';

type Props = {
  mode: Mode;
  uid: string;
  meName: string;
  refreshKey: number;
  notify: Notify;
  celebrate: (text: string, emoji: string) => void;
  onChanged: () => void;
  onPublish: () => void;
  onOffers: () => void;
};

// Accueil : ce qui arrive. Les demandes reçues d'abord, puis les trajets confirmés, puis les personnes
// qui cherchent sur la route. Chaque carte rappelle le trajet concerné (aller ou retour, date, heure)
// et, dessous, la personne et ce qu'elle propose.
export function Home({ mode, uid, meName, refreshKey, notify, celebrate, onChanged, onPublish, onOffers }: Props) {
  const driver = mode === 'driver';
  const [matches, setMatches] = useState<Match[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [candidates, setCandidates] = useState<Record<string, Candidate[]>>({});
  const [detours, setDetours] = useState<Record<string, number>>({});
  const [maxDetour, setMaxDetour] = useState(15);
  const [mapFor, setMapFor] = useState<{ tripId: string; requestId: string; name: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ text: string; yes: string; run: () => void } | null>(null);
  const [viewUser, setViewUser] = useState<{ id: string; name: string } | null>(null);
  const [helpFor, setHelpFor] = useState<Match | null>(null);
  // Chauffeur : frais d'espèces dus ; au-delà du seuil, il ne propose ni n'accepte de trajet en espèces.
  const [debt, setDebt] = useState<{ debt: number; blocked: boolean } | null>(null);
  const [showWallet, setShowWallet] = useState(false);

  const load = useCallback(async () => {
    try {
      const [all, mine] = await Promise.all([api.matches(), api.listings(mode, uid)]);
      // La recherche ne tourne que pour la prochaine date de chaque sens (et les dates où quelqu'un a déjà
      // demandé), actives, dans les 7 prochains jours.
      const soon = Date.now() + 7 * 86400_000;
      const shown = shownIds(groupOffers(mine), busyListings(all, mode));
      const found = await Promise.all(
        mine.map((l) =>
          l.status === 'paused' || !shown.has(l.id) || new Date(l.window_start).getTime() > soon
            ? []
            : api.candidates(mode, l.id).catch(() => []),
        ),
      );
      // Trajets de demain au plus tard, pas encore vus côté circulation : deux au maximum par chargement.
      if (driver) {
        mine
          .filter((l) => l.status === 'open' && shown.has(l.id) && !l.traffic_checked_at && new Date(l.window_start).getTime() < Date.now() + 86400_000)
          .slice(0, 2)
          .forEach((l) => api.traffic(l.id, false));
        api.cashDebt().then(setDebt).catch(() => {});
      }
      setMatches(all.filter((m) => m.role === mode));
      // Paiement par carte commencé : on vérifie chez Stripe s'il a abouti (retour de la page de paiement, ou appli rouverte).
      const waiting = all.filter((m) => m.role === mode && m.status === 'accepted' && m.pay_method === 'card' && !m.paid_at);
      if (waiting.length) {
        Promise.all(waiting.slice(0, 3).map((m) => api.confirmPayment(m.id))).then((paid) => {
          if (paid.some(Boolean)) {
            if (new URLSearchParams(window.location.search).has('paiement')) window.history.replaceState(null, '', window.location.pathname);
            celebrate('Trajet payé !', '💳');
            api.matches().then((fresh) => setMatches(fresh.filter((m) => m.role === mode))).catch(() => {});
          }
        });
      }
      setListings(mine);
      setCandidates(Object.fromEntries(mine.map((l, i) => [l.id, found[i]])));
      // Conducteur : minutes de détour pour chaque passager possible (calculées une fois, puis gardées).
      if (driver) {
        api.maxDetour().then(setMaxDetour).catch(() => {});
        const withFound = mine.filter((_, i) => found[i].length > 0);
        const known = await api.detours(withFound.map((l) => l.id));
        setDetours(known);
        const todo = withFound
          .map((l) => ({ id: l.id, ids: (found[mine.indexOf(l)] as Candidate[]).map((c) => c.request_id).filter((r) => known[l.id + r] == null) }))
          .filter((t) => t.ids.length > 0)
          .slice(0, 2);
        if (todo.length) {
          Promise.all(todo.map((t) => api.computeDetours(t.id, t.ids.slice(0, 5))))
            .then(() => api.detours(withFound.map((l) => l.id)))
            .then(setDetours)
            .catch(() => {});
        }
      }
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setLoaded(true);
  }, [mode, uid, driver, notify, celebrate]);

  useEffect(() => {
    setLoaded(false);
  }, [mode]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // « big » : action importante, validée par un tampon animé et une vibration.
  async function run(action: () => Promise<unknown>, success?: string, big?: string) {
    setBusy(true);
    try {
      const result = await action();
      if (result === 'driver_en_route') celebrate('C’est parti !', '🚗');
      else if (result === 'driver_arrived') celebrate('Covoiturage démarré', '🙌');
      else if (result === 'completed') celebrate('Trajet terminé !', '🏁');
      else if (big && success) celebrate(success, big);
      else if (success) notify(success);
      await load();
      onChanged();
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setBusy(false);
  }

  // Aller ou retour, et récurrent ou non : rappelé en tête de chaque carte.
  const legOf = useMemo(() => {
    const map = new Map<string, { leg: 'Aller' | 'Retour' | null; recurring: boolean }>();
    for (const o of groupOffers(listings, 0)) {
      for (const l of o.upcoming) map.set(l.id, { leg: o.round ? (l.is_return ? 'Retour' : 'Aller') : null, recurring: o.recurring });
    }
    return map;
  }, [listings]);

  const active = matches.filter((m) => m.status === 'proposed' || m.status === 'accepted');
  const toReview = matches.filter((m) => m.status === 'completed' && !m.reviewed_by_me);
  // Une paire trajet/demande déjà mise en relation ne peut plus être proposée.
  const paired = new Set(matches.map((m) => m.trip_id + m.request_id));
  const now = Date.now();

  const cards = listings
    .map((l) => {
      const mine = active.filter((m) => listingOf(m, mode) === l.id);
      const left = (l.seats ?? 0) - (l.seats_taken ?? 0);
      const confirmed = mine.some((m) => m.status === 'accepted');
      // Passager : une fois le trajet confirmé, on ne propose plus d'autres conducteurs.
      // Conducteur : un trajet parti, complet ou suspendu ne cherche plus de passagers.
      const searching = l.status !== 'paused' && (driver ? l.status === 'open' && left > 0 : !confirmed);
      const found = !searching
        ? []
        : (candidates[l.id] ?? [])
            .filter((c) => !paired.has(c.trip_id + c.request_id))
            .filter((c) => {
              // Sur la route (à moins d'1 km) : toujours proposé.
              if (c.pickup_m <= 1000 && (c.dropoff_m ?? 0) <= 1000) return true;
              // Plus loin : côté conducteur, c'est le détour réel qui décide, jusqu'au maximum qu'il a réglé ;
              // côté passager, le conducteur doit passer à 12 km au plus en cumulé.
              if (!driver) return c.pickup_m + (c.dropoff_m ?? 0) <= 12000;
              const detour = detours[c.trip_id + c.request_id];
              return detour != null && detour <= maxDetour;
            })
            .sort((a, b) =>
              driver
                ? (detours[a.trip_id + a.request_id] ?? 0) - (detours[b.trip_id + b.request_id] ?? 0)
                : a.pickup_m + (a.dropoff_m ?? 0) - (b.pickup_m + (b.dropoff_m ?? 0)),
            );
      const incoming = mine.filter((m) => m.status === 'proposed' && !m.proposed_by_me);
      const rank = incoming.length ? 0 : confirmed ? 1 : 2;
      return { l, mine, found, incoming, confirmed, left, rank };
    })
    .filter((c) => c.mine.length > 0 || (c.found.length > 0 && new Date(c.l.window_end).getTime() > now))
    .sort((a, b) => a.rank - b.rank || new Date(a.l.window_start).getTime() - new Date(b.l.window_start).getTime());
  const known = new Set(listings.map((l) => l.id));
  const orphans = active.filter((m) => !known.has(listingOf(m, mode)));
  const upcomingOffers = listings.filter((l) => new Date(l.window_end).getTime() > now).length;
  const empty = loaded && !cards.length && !orphans.length && !toReview.length;

  const person = (m: Match) => () => setViewUser({ id: m.other_id, name: m.other_name });

  function matchBlock(m: Match) {
    if (m.status === 'accepted') {
      return (
        <div className="block" key={m.id}>
          <MatchCard
            m={m}
            busy={busy}
            onPay={() =>
              run(async () => {
                const url = await api.pay(m.id);
                if (url) window.location.href = url;
              })
            }
            onAdvance={() =>
              run(async () => {
                const stage = await api.advance(m.id);
                // Au départ et à la prise en charge : heure d'arrivée recalée sur la circulation du moment.
                if (stage !== 'completed') await api.traffic(m.trip_id, true);
                return stage;
              })
            }
            onUser={person(m)}
            onHelp={() => setHelpFor(m)}
            meName={meName}
            onCancel={() =>
              setAsk({
                text: `Annuler ton trajet avec ${m.other_name} ? ${m.other_name} sera prévenu.`,
                yes: 'Oui, annuler',
                run: () => run(() => api.cancelMatch(m.id), 'Trajet annulé'),
              })
            }
          />
        </div>
      );
    }
    if (!m.proposed_by_me) {
      return (
        <div className="block answer" key={m.id}>
          <div className="contact">
            <div className="avatar">{m.other_name.charAt(0).toUpperCase()}</div>
            <button className="contact-info person" onClick={person(m)}>
              <strong>{driver ? `${m.other_name} demande une place` : `${m.other_name} te propose une place`}</strong>
              <Rating rating={m.other_rating} reviews={m.other_reviews} />
              <small>{driver ? `Montée : ${m.pickup_label} · descente : ${m.dropoff_label}` : `${m.trip_origin_label} → ${m.trip_dest_label}`}</small>
              <small>
                {fmt(m.meet_at)}
                {m.cost_share_cents > 0 && ` · ${euros(m.cost_share_cents)}`}
                {driver && m.seats > 1 && ` · ${m.seats} personnes`}
                {driver && m.pay_method && (m.pay_method === 'card' ? ' · 💳 carte' : ' · 💶 espèces')}
              </small>
              {driver && m.note && <small className="note">« {m.note} »</small>}
            </button>
          </div>
          {driver && (
            <button className="link map-link" onClick={() => setMapFor({ tripId: m.trip_id, requestId: m.request_id, name: m.other_name })}>
              🗺 Voir son trajet sur la carte
            </button>
          )}
          <div className="row2">
            {driver && debt?.blocked && m.pay_method === 'cash' ? (
              <button className="primary" disabled={busy} onClick={() => setShowWallet(true)}>
                Régler mes frais pour accepter
              </button>
            ) : (
              <button className="primary" disabled={busy} onClick={() => run(() => api.respond(m.id, true), 'Trajet confirmé !', '🤝')}>
                Accepter
              </button>
            )}
            <button className="ghost" disabled={busy} onClick={() => run(() => api.respond(m.id, false))}>
              Refuser
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="block" key={m.id}>
        <div className="contact">
          <div className="avatar pending">⏳</div>
          <button className="contact-info person" onClick={person(m)}>
            <strong>En attente de la réponse de {m.other_name}</strong>
            <Rating rating={m.other_rating} reviews={m.other_reviews} />
            <small>{fmt(m.meet_at)}</small>
          </button>
          <button className="ghost small" disabled={busy} onClick={() => run(() => api.cancelMatch(m.id))}>
            Retirer
          </button>
        </div>
      </div>
    );
  }

  function candidateBlock(c: Candidate) {
    const detour = detours[c.trip_id + c.request_id];
    return (
      <div className="block" key={c.trip_id + c.request_id}>
        <div className="contact">
          <div className="avatar">{c.name.charAt(0).toUpperCase()}</div>
          <button className="contact-info person" onClick={() => setViewUser({ id: c.user_id, name: c.name })}>
            <strong>{c.name}</strong>
            <Rating rating={c.rating} reviews={c.reviews} />
            <small>
              Départ possible {fmtTime(c.overlap_start)} · {c.shared_km} km ensemble
              {c.ride_minutes ? ` · ≈ ${fmtDuration(c.ride_minutes)}` : ''}
              <TrafficTag minutes={c.ride_minutes} delay={c.traffic_delay_min} />
            </small>
            <small>
              {driver
                ? `${(c.seats ?? 1) === 1 ? '1 personne' : `${c.seats} personnes`} · ` +
                  (detour == null ? `montée à ${c.pickup_m} m de ta route` : detour <= 1 ? 'sur ta route, sans détour' : `détour ≈ ${detour} min`)
                : `${c.seats_left} place(s)`}
              {!driver && (c.pickup_m > 1000 || (c.dropoff_m ?? 0) > 1000) && ' · petit détour pour le chauffeur'}
              {!driver && (c.cost_share_cents ?? 0) > 0 && ` · ${euros(c.cost_share_cents!)}`}
            </small>
            {driver && c.note && <small className="note">« {c.note} »</small>}
          </button>
          <button
            className="primary small"
            disabled={busy}
            onClick={() => run(() => api.propose(c.trip_id, c.request_id), driver ? 'Proposition envoyée' : 'Demande envoyée', '✋')}
          >
            {driver ? 'Proposer' : 'Demander'}
          </button>
        </div>
        {driver && (
          <button className="link map-link" onClick={() => setMapFor({ tripId: c.trip_id, requestId: c.request_id, name: c.name })}>
            🗺 Voir son trajet sur la carte
          </button>
        )}
      </div>
    );
  }

  const titles = driver
    ? ['Demandes reçues', 'Trajets confirmés', 'Passagers sur ta route']
    : ['Propositions reçues', 'Trajets confirmés', 'Conducteurs sur ta route'];

  return (
    <>
      <h2 className="page-title">Accueil</h2>
      {!loaded && <p className="muted center">Chargement…</p>}

      {driver && debt?.blocked && (
        <div className="debt-banner">
          <span>Tu dois {euros(debt.debt)} de frais de service : les passagers qui paient en espèces sont en pause.</span>
          <button className="primary small" onClick={() => setShowWallet(true)}>
            Régler
          </button>
        </div>
      )}

      {empty &&
        (upcomingOffers ? (
          <div className="card empty">
            <div className="empty-emoji">{driver ? '🔔' : '🔎'}</div>
            <strong>{driver ? 'Pas encore de demande' : 'Pas encore de conducteur'}</strong>
            <p>
              {driver
                ? 'Tes propositions sont en ligne. Dès qu’un passager demande une place, elle s’affiche ici.'
                : 'Tes demandes sont en ligne. Dès qu’un conducteur passe par là, il s’affiche ici.'}
            </p>
            <button className="ghost small" onClick={onOffers}>
              {driver ? 'Voir mes propositions' : 'Voir mes demandes'}
            </button>
          </div>
        ) : (
          <div className="card empty">
            <div className="empty-emoji">{driver ? '🚗' : '🙋'}</div>
            <strong>{driver ? 'Tu fais un trajet bientôt ?' : 'Où vas-tu ?'}</strong>
            <p>
              {driver
                ? 'Propose-le : les passagers qui sont sur ta route te demanderont une place ici.'
                : 'Indique ton trajet : les conducteurs qui passent par là s’afficheront ici.'}
            </p>
            <button className="primary" onClick={onPublish}>
              {driver ? '＋ Proposer un trajet' : '＋ Chercher un trajet'}
            </button>
          </div>
        ))}

      {toReview.map((m) => (
        <ReviewCard
          key={m.id}
          name={m.other_name}
          points={driver ? 15 : 10}
          route={`${m.pickup_label} → ${m.dropoff_label}`}
          busy={busy}
          onSubmit={(rating, comment) => run(() => api.review(m.id, rating, comment), 'Merci pour ton avis !', '⭐')}
        />
      ))}

      {cards.map((c, i) => {
        const tag = legOf.get(c.l.id);
        const paused = c.l.status === 'paused';
        return (
          <div key={c.l.id} className="inbox-group">
            {(i === 0 || cards[i - 1].rank !== c.rank) && (
              <h3 className="section">
                {titles[c.rank]}
                {c.rank === 0 && <span className="count-pill">{cards.filter((x) => x.rank === 0).reduce((s, x) => s + x.incoming.length, 0)}</span>}
              </h3>
            )}
            <div className={'card ticket' + (c.rank === 0 ? ' highlight' : '')}>
              <div className="ticket-head">
                <div className="ticket-tags">
                  {tag?.leg && <span className={`leg-tag ${tag.leg === 'Aller' ? 'go' : 'back'}`}>{tag.leg}</span>}
                  <span className="ticket-day">{dayLabel(c.l.window_start)}</span>
                  <span className="ticket-time">
                    {fmtTime(c.l.window_start)} – {fmtTime(c.l.window_end)}
                  </span>
                  {tag?.recurring && (
                    <span className="rec-dot" title="Trajet récurrent" aria-label="Trajet récurrent">
                      🔁
                    </span>
                  )}
                </div>
                <strong className="ticket-route">
                  {c.l.origin_label} <span aria-hidden="true">→</span> {c.l.dest_label}
                </strong>
                <small>
                  {driver && !paused && (c.l.status === 'full' && c.left > 0 ? 'en cours' : c.left > 0 ? `${c.left} place(s) libre(s)` : 'complet')}
                  {driver && c.l.cost_share_cents ? ` · ${euros(c.l.cost_share_cents)}/passager` : ''}
                  {driver && c.l.duration_min ? ` · ≈ ${fmtDuration(c.l.duration_min)}` : ''}
                  {driver && <TrafficTag minutes={c.l.duration_min} delay={c.l.traffic_delay_min} />}
                  {!driver && `${c.l.seats ?? 1} personne${(c.l.seats ?? 1) > 1 ? 's' : ''}`}
                  {paused && ' · ⏸ suspendu'}
                </small>
              </div>
              {c.incoming.map(matchBlock)}
              {c.mine.filter((m) => m.status === 'accepted').map(matchBlock)}
              {c.mine.filter((m) => m.status === 'proposed' && m.proposed_by_me).map(matchBlock)}
              {c.found.length > 0 && (
                <>
                  {c.rank < 2 && <small className="sub-section">{driver ? 'Aussi sur ta route' : 'Autres conducteurs'}</small>}
                  {c.found.map(candidateBlock)}
                </>
              )}
            </div>
          </div>
        );
      })}

      {orphans.length > 0 && (
        <div className="card ticket">
          <strong>Autres trajets en cours</strong>
          {orphans.map(matchBlock)}
        </div>
      )}

      {ask && (
        <ConfirmDialog
          text={ask.text}
          yes={ask.yes}
          onYes={() => {
            ask.run();
            setAsk(null);
          }}
          onNo={() => setAsk(null)}
        />
      )}
      {mapFor && <RouteMap {...mapFor} onClose={() => setMapFor(null)} />}
      {showWallet && (
        <Wallet
          notify={notify}
          onClose={() => {
            setShowWallet(false);
            api.cashDebt().then(setDebt).catch(() => {});
          }}
        />
      )}
      {helpFor && <Assistance m={helpFor} notify={notify} onClose={() => setHelpFor(null)} />}
      {viewUser && <UserSheet userId={viewUser.id} name={viewUser.name} onClose={() => setViewUser(null)} />}
    </>
  );
}
