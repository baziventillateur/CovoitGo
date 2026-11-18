import { useCallback, useEffect, useState } from 'react';
import { api, type Candidate, type EditTrip, type Listing, type Match, type Mode, type Notify } from './api';
import { TrafficTag } from './Traffic';
import { MatchCard } from './MatchCard';
import { PublishForm } from './PublishForm';
import { euros, fmt, fmtDuration, fmtTime } from './format';
import { Rating, ReviewCard, UserSheet } from './Reviews';
import { ConfirmDialog } from './ConfirmDialog';
import { Assistance } from './Assistance';

type Celebrate = (text: string, emoji: string) => void;
type Props = { mode: Mode; uid: string; meName: string; refreshKey: number; notify: Notify; celebrate: Celebrate; onChanged: () => void };

export function Home({ mode, uid, meName, refreshKey, notify, celebrate, onChanged }: Props) {
  const driver = mode === 'driver';
  const [matches, setMatches] = useState<Match[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [candidates, setCandidates] = useState<Record<string, Candidate[]>>({});
  const [detours, setDetours] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ text: string; yes: string; run: () => void } | null>(null);
  const [viewUser, setViewUser] = useState<{ id: string; name: string } | null>(null);
  const [helpFor, setHelpFor] = useState<Match | null>(null);
  const [edit, setEdit] = useState<EditTrip | null>(null);
  const [menuFor, setMenuFor] = useState<Listing | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [all, mine] = await Promise.all([api.matches(), api.listings(mode, uid)]);
      // La recherche ne tourne que pour les annonces actives des 7 prochains jours.
      const soon = Date.now() + 7 * 86400_000;
      const found = await Promise.all(
        mine.map((l) =>
          l.status === 'paused' || new Date(l.window_start).getTime() > soon ? [] : api.candidates(mode, l.id).catch(() => []),
        ),
      );
      // Trajets de demain au plus tard, pas encore vus côté circulation : deux au maximum par chargement.
      if (mode === 'driver') {
        mine
          .filter((l) => l.status === 'open' && !l.traffic_checked_at && new Date(l.window_start).getTime() < Date.now() + 86400_000)
          .slice(0, 2)
          .forEach((l) => api.traffic(l.id, false));
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
      if (mode === 'driver') {
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
  }, [mode, uid, notify, celebrate]);

  useEffect(() => {
    setLoaded(false);
    setShowForm(false);
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

  if (showForm || edit) {
    return (
      <PublishForm
        mode={mode}
        notify={notify}
        edit={edit ?? undefined}
        onCancel={() => {
          setShowForm(false);
          setEdit(null);
        }}
        onDone={(message) => {
          setShowForm(false);
          setEdit(null);
          celebrate(message ?? (driver ? 'Trajet publié !' : 'Recherche lancée !'), driver ? '🚗' : '🔎');
          load();
        }}
      />
    );
  }

  const active = matches.filter((m) => m.status === 'proposed' || m.status === 'accepted');
  const toReview = matches.filter((m) => m.status === 'completed' && !m.reviewed_by_me);
  const done = matches.filter((m) => m.status === 'completed' && m.reviewed_by_me).slice(0, 3);
  // Une paire trajet/demande déjà mise en relation ne peut plus être proposée.
  const paired = new Set(matches.map((m) => m.trip_id + m.request_id));
  const listingOf = (m: Match) => (driver ? m.trip_id : m.request_id);
  const now = Date.now();

  // Un « dossier » par annonce : tout ce qui concerne ce trajet est dans la même case.
  const folders = listings
    .map((l) => ({
      l,
      mine: active.filter((m) => listingOf(m) === l.id),
      found: (candidates[l.id] ?? [])
        .filter((c) => !paired.has(c.trip_id + c.request_id))
        .filter((c) => {
          // Sur la route (à moins d'1 km) : toujours proposé.
          if (c.pickup_m <= 1000 && (c.dropoff_m ?? 0) <= 1000) return true;
          // Plus loin : côté conducteur, c'est le détour réel qui décide (affiché dès qu'il est calculé) ;
          // côté passager, le conducteur doit passer à 12 km au plus en cumulé.
          if (!driver) return c.pickup_m + (c.dropoff_m ?? 0) <= 12000;
          const detour = detours[c.trip_id + c.request_id];
          return detour != null && detour <= Math.min(30, Math.max(8, Math.round((l.duration_min ?? 40) * 0.4)));
        })
        .sort((a, b) =>
          driver
            ? (detours[a.trip_id + a.request_id] ?? 0) - (detours[b.trip_id + b.request_id] ?? 0)
            : a.pickup_m + (a.dropoff_m ?? 0) - (b.pickup_m + (b.dropoff_m ?? 0)),
        ),
    }))
    // Une annonce dont le créneau est passé ne reste affichée que s'il s'y passe encore quelque chose.
    .filter((f) => f.mine.length > 0 || new Date(f.l.window_end).getTime() > now);
  // Avec des trajets récurrents, seuls les premiers et ceux où il se passe quelque chose restent dépliés.
  const visible = showAll ? folders : folders.filter((f, i) => i < 4 || f.mine.length > 0 || f.found.length > 0);
  const known = new Set(listings.map((l) => l.id));
  const orphans = active.filter((m) => !known.has(listingOf(m)));

  const empty = loaded && !folders.length && !orphans.length && !toReview.length;

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
          <span className="block-tag">À toi de répondre</span>
          <div className="contact">
            <div className="avatar">{m.other_name.charAt(0).toUpperCase()}</div>
            <button className="contact-info person" onClick={person(m)}>
              <strong>{driver ? `${m.other_name} demande une place` : `${m.other_name} te propose une place`}</strong>
              <Rating rating={m.other_rating} reviews={m.other_reviews} />
              <small>
                {driver ? `Montée : ${m.pickup_label}` : `${m.trip_origin_label} → ${m.trip_dest_label}`}
              </small>
              <small>
                {fmt(m.meet_at)}
                {m.cost_share_cents > 0 && ` · ${euros(m.cost_share_cents)}`}
                {driver && m.seats > 1 && ` · ${m.seats} personnes`}
              </small>
              {driver && m.note && <small className="note">« {m.note} »</small>}
            </button>
          </div>
          <div className="row2">
            <button className="primary" disabled={busy} onClick={() => run(() => api.respond(m.id, true), 'Trajet confirmé !', '🤝')}>
              Accepter
            </button>
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

  return (
    <>
      <button className="primary big cta" onClick={() => setShowForm(true)}>
        {driver ? '＋ Publier un trajet' : '＋ Chercher un trajet'}
      </button>

      {!loaded && <p className="muted center">Chargement…</p>}

      {empty && (
        <div className="card empty">
          <div className="empty-emoji">{driver ? '🚗' : '🙋'}</div>
          <strong>{driver ? 'Tu fais un trajet bientôt ?' : 'Où vas-tu ?'}</strong>
          <p>
            {driver
              ? 'Publie-le : on te propose automatiquement les passagers qui sont sur ta route.'
              : 'Indique ton trajet : on te montre les conducteurs qui passent par là.'}
          </p>
        </div>
      )}

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

      {folders.length > 0 && <h3 className="section">{driver ? 'Mes trajets' : 'Mes recherches'}</h3>}
      {visible.map(({ l, mine, found }) => {
        const confirmed = mine.some((m) => m.status === 'accepted');
        const left = (l.seats ?? 0) - (l.seats_taken ?? 0);
        // Passager : une fois le trajet confirmé, on ne propose plus d'autres conducteurs.
        // Conducteur : un trajet parti (ou complet) ne cherche plus de passagers.
        const departed = driver && l.status === 'full' && left > 0;
        const paused = l.status === 'paused';
        const showFound = driver ? l.status === 'open' && left > 0 : !confirmed;
        const toAnswer = mine.filter((m) => m.status === 'proposed' && !m.proposed_by_me).length;
        return (
          <div className={(toAnswer ? 'card folder highlight' : 'card folder') + (paused ? ' paused' : '')} key={l.id}>
            <div className="listing-head">
              <div>
                <strong>
                  {l.origin_label} → {l.dest_label}
                </strong>
                <small>
                  {fmt(l.window_start)} – {fmtTime(l.window_end)}
                  {driver && !paused && (departed ? ' · en cours' : left > 0 ? ` · ${left} place(s) libre(s)` : ' · complet')}
                  {driver && l.cost_share_cents ? ` · ${euros(l.cost_share_cents)}/passager` : ''}
                  {driver && l.duration_min ? ` · ≈ ${fmtDuration(l.duration_min)}` : ''}
                  {driver && <TrafficTag minutes={l.duration_min} delay={l.traffic_delay_min} />}
                  {!driver && (l.seats ?? 1) > 1 && ` · ${l.seats} personnes`}
                </small>
                {!driver && l.note && <small className="note">« {l.note} »</small>}
                {paused && <span className="paused-tag">⏸ Suspendu · invisible pour les passagers</span>}
              </div>
              {driver && !departed ? (
                <button className="ghost more" aria-label="Actions sur ce trajet" disabled={busy} onClick={() => setMenuFor(l)}>
                  ⋯
                </button>
              ) : (
              <button
                className="ghost small"
                disabled={busy}
                onClick={() =>
                  setAsk({
                    text:
                      (driver ? 'Supprimer ce trajet ?' : 'Supprimer cette recherche ? Elle sera définitivement supprimée.') +
                      (mine.length ? ' Les personnes concernées seront prévenues.' : ''),
                    yes: 'Oui, supprimer',
                    run: () => run(() => (driver ? api.cancelTrip(l.id) : api.cancelRequest(l.id)), 'Supprimé'),
                  })
                }
              >
                Supprimer
              </button>
              )}
            </div>

            {mine.filter((m) => m.status === 'accepted').map(matchBlock)}
            {mine.filter((m) => m.status === 'proposed' && !m.proposed_by_me).map(matchBlock)}
            {mine.filter((m) => m.status === 'proposed' && m.proposed_by_me).map(matchBlock)}

            {showFound &&
              found.map((c) => (
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
                            (detours[c.trip_id + c.request_id] == null
                              ? `montée à ${c.pickup_m} m de ta route`
                              : detours[c.trip_id + c.request_id] <= 1
                                ? 'sur ta route, sans détour'
                                : `détour ≈ ${detours[c.trip_id + c.request_id]} min`)
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
                </div>
              ))}

            {showFound && found.length === 0 && mine.length === 0 && (
              <p className="muted searching block">
                <span className="pulse" /> {driver ? 'Recherche de passagers sur ta route…' : 'Recherche de conducteurs sur ta route…'}
              </p>
            )}
          </div>
        );
      })}

      {folders.length > visible.length && (
        <button className="link center" onClick={() => setShowAll(true)}>
          Voir les {folders.length - visible.length} autres
        </button>
      )}

      {orphans.length > 0 && (
        <div className="card folder">
          <strong>Autres trajets en cours</strong>
          {orphans.map(matchBlock)}
        </div>
      )}

      {done.length > 0 && <h3 className="section">Derniers trajets</h3>}
      {done.map((m) => (
        <div className="card done-row" key={m.id}>
          <span>✅</span>
          <div className="contact-info">
            <strong>
              {m.pickup_label} → {m.dropoff_label}
            </strong>
            <small>
              Avec{' '}
              <button className="person name-link" onClick={person(m)}>
                {m.other_name}
              </button>{' '}
              · {fmt(m.meet_at)}
            </small>
          </div>
          <span className="pts">⭐ +{driver ? 15 : 10} pts</span>
        </div>
      ))}

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
      {menuFor &&
        (() => {
          const l = menuFor;
          const confirmed = matches.some((m) => m.trip_id === l.id && m.status === 'accepted');
          const pending = matches.some((m) => m.trip_id === l.id && m.status === 'proposed');
          const close = () => setMenuFor(null);
          return (
            <div className="sheet-backdrop" onClick={close}>
              <div className="sheet actions-sheet" onClick={(e) => e.stopPropagation()}>
                <strong>
                  {l.origin_label} → {l.dest_label}
                </strong>
                <small>{fmt(l.window_start)}</small>
                <button
                  className="ghost"
                  disabled={confirmed || l.status === 'full'}
                  onClick={() => {
                    close();
                    run(async () => setEdit(await api.tripForEdit(l.id)));
                  }}
                >
                  ✏️ Modifier
                  <small>{confirmed ? 'Impossible : un passager est déjà confirmé.' : 'Adresses, heure, places, prix.'}</small>
                </button>
                {l.status === 'paused' ? (
                  <button className="ghost" onClick={() => { close(); run(() => api.resumeTrip(l.id), 'Trajet de nouveau visible'); }}>
                    ▶️ Reprendre
                    <small>Le trajet redevient visible pour les passagers.</small>
                  </button>
                ) : (
                  <button className="ghost" disabled={l.status !== 'open'} onClick={() => { close(); run(() => api.pauseTrip(l.id), 'Trajet suspendu'); }}>
                    ⏸ Suspendre
                    <small>
                      Plus personne ne le voit, tu le gardes pour plus tard.{pending ? ' Les demandes en attente seront annulées.' : ''}
                    </small>
                  </button>
                )}
                <button
                  className="ghost danger-line"
                  onClick={() => {
                    close();
                    setAsk({
                      text:
                        'Veux-tu vraiment supprimer ce trajet ? Il sera définitivement supprimé.' +
                        (confirmed || pending ? ' Les personnes concernées seront prévenues.' : ''),
                      yes: 'Oui, supprimer',
                      run: () => run(() => api.cancelTrip(l.id), 'Trajet supprimé'),
                    });
                  }}
                >
                  🗑 Supprimer
                </button>
              </div>
            </div>
          );
        })()}
      {helpFor && <Assistance m={helpFor} notify={notify} onClose={() => setHelpFor(null)} />}
      {viewUser && <UserSheet userId={viewUser.id} name={viewUser.name} onClose={() => setViewUser(null)} />}
    </>
  );
}
