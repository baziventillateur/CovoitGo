import { useCallback, useEffect, useState } from 'react';
import { api, type Candidate, type Listing, type Match, type Mode, type Notify } from './api';
import { MatchCard } from './MatchCard';
import { PublishForm } from './PublishForm';
import { euros, fmt, fmtTime } from './format';
import { Rating, ReviewCard, UserSheet } from './Reviews';
import { ConfirmDialog } from './ConfirmDialog';

type Props = { mode: Mode; uid: string; refreshKey: number; notify: Notify; onChanged: () => void };

export function Home({ mode, uid, refreshKey, notify, onChanged }: Props) {
  const driver = mode === 'driver';
  const [matches, setMatches] = useState<Match[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [candidates, setCandidates] = useState<Record<string, Candidate[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ text: string; yes: string; run: () => void } | null>(null);
  const [viewUser, setViewUser] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [all, mine] = await Promise.all([api.matches(), api.listings(mode, uid)]);
      const found = await Promise.all(mine.map((l) => api.candidates(mode, l.id).catch(() => [])));
      setMatches(all.filter((m) => m.role === mode));
      setListings(mine);
      setCandidates(Object.fromEntries(mine.map((l, i) => [l.id, found[i]])));
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setLoaded(true);
  }, [mode, uid, notify]);

  useEffect(() => {
    setLoaded(false);
    setShowForm(false);
  }, [mode]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      const result = await action();
      if (success) notify(success);
      await load();
      onChanged();
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setBusy(false);
  }

  const toAnswer = matches.filter((m) => m.status === 'proposed' && !m.proposed_by_me);
  const live = matches.filter((m) => m.status === 'accepted');
  const waiting = matches.filter((m) => m.status === 'proposed' && m.proposed_by_me);
  const toReview = matches.filter((m) => m.status === 'completed' && !m.reviewed_by_me);
  const done = matches.filter((m) => m.status === 'completed' && m.reviewed_by_me).slice(0, 3);
  // Une paire trajet/demande déjà mise en relation ne peut plus être proposée.
  const paired = new Set(matches.map((m) => m.trip_id + m.request_id));

  if (showForm) {
    return (
      <PublishForm
        mode={mode}
        notify={notify}
        onCancel={() => setShowForm(false)}
        onDone={() => {
          setShowForm(false);
          load();
        }}
      />
    );
  }

  const empty = loaded && !toAnswer.length && !live.length && !waiting.length && !listings.length && !toReview.length;

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
          onSubmit={(rating, comment) => run(() => api.review(m.id, rating, comment), 'Merci pour ton avis !')}
        />
      ))}

      {toAnswer.length > 0 && <h3 className="section">À toi de répondre</h3>}
      {toAnswer.map((m) => (
        <div className="card highlight" key={m.id}>
          <div className="contact">
            <div className="avatar">{m.other_name.charAt(0).toUpperCase()}</div>
            <button className="contact-info person" onClick={() => setViewUser({ id: m.other_id, name: m.other_name })}>
              <strong>{driver ? `${m.other_name} demande une place` : `${m.other_name} te propose une place`}</strong>
              <Rating rating={m.other_rating} reviews={m.other_reviews} />
              <small>
                {m.pickup_label} → {m.dropoff_label}
              </small>
              <small>
                {fmt(m.meet_at)}
                {m.cost_share_cents > 0 && ` · ${euros(m.cost_share_cents)}`}
              </small>
            </button>
          </div>
          <div className="row2">
            <button className="primary" disabled={busy} onClick={() => run(() => api.respond(m.id, true), 'Trajet confirmé !')}>
              Accepter
            </button>
            <button className="ghost" disabled={busy} onClick={() => run(() => api.respond(m.id, false))}>
              Refuser
            </button>
          </div>
        </div>
      ))}

      {live.length > 0 && <h3 className="section">{live.length > 1 ? 'Tes trajets confirmés' : 'Ton trajet confirmé'}</h3>}
      {live.map((m) => (
        <MatchCard
          key={m.id}
          m={m}
          busy={busy}
          onAdvance={() => run(() => api.advance(m.id))}
          onUser={() => setViewUser({ id: m.other_id, name: m.other_name })}
          onCancel={() =>
            setAsk({
              text: `Annuler ton trajet avec ${m.other_name} ? ${m.other_name} sera prévenu.`,
              yes: 'Oui, annuler',
              run: () => run(() => api.cancelMatch(m.id), 'Trajet annulé'),
            })
          }
        />
      ))}

      {waiting.length > 0 && <h3 className="section">En attente de réponse</h3>}
      {waiting.map((m) => (
        <div className="card" key={m.id}>
          <div className="contact">
            <div className="avatar pending">⏳</div>
            <div className="contact-info">
              <strong>En attente de {m.other_name}</strong>
              <small>
                {m.pickup_label} → {m.dropoff_label} · {fmt(m.meet_at)}
              </small>
            </div>
            <button className="ghost small" disabled={busy} onClick={() => run(() => api.cancelMatch(m.id))}>
              Retirer
            </button>
          </div>
        </div>
      ))}

      {listings.length > 0 && <h3 className="section">{driver ? 'Mes trajets publiés' : 'Mes recherches'}</h3>}
      {listings.map((l) => {
        const list = (candidates[l.id] ?? []).filter((c) => !paired.has(c.trip_id + c.request_id));
        return (
          <div className="card" key={l.id}>
            <div className="listing-head">
              <div>
                <strong>
                  {l.origin_label} → {l.dest_label}
                </strong>
                <small>
                  {fmt(l.window_start)} – {fmtTime(l.window_end)}
                  {driver && l.seats != null && ` · ${l.seats - (l.seats_taken ?? 0)} place(s) libre(s)`}
                </small>
              </div>
              <button
                className="ghost small"
                disabled={busy}
                onClick={() =>
                  setAsk({
                    text: driver ? 'Supprimer ce trajet publié ?' : 'Supprimer cette recherche ?',
                    yes: 'Oui, supprimer',
                    run: () => run(() => (driver ? api.cancelTrip(l.id) : api.cancelRequest(l.id)), 'Supprimé'),
                  })
                }
              >
                Supprimer
              </button>
            </div>
            {list.length === 0 ? (
              <p className="muted searching">
                <span className="pulse" /> {driver ? 'Recherche de passagers sur ta route…' : 'Recherche de conducteurs sur ta route…'}
              </p>
            ) : (
              <ul className="candidates">
                {list.map((c) => (
                  <li key={c.trip_id + c.request_id}>
                    <div className="avatar">{c.name.charAt(0).toUpperCase()}</div>
                    <button className="contact-info person" onClick={() => setViewUser({ id: c.user_id, name: c.name })}>
                      <strong>{c.name}</strong>
                      <Rating rating={c.rating} reviews={c.reviews} />
                      <small>
                        Départ possible {fmtTime(c.overlap_start)} · {c.shared_km} km ensemble
                      </small>
                      <small>
                        {driver ? `Montée à ${c.pickup_m} m de ta route` : `${c.seats_left} place(s)`}
                        {!driver && (c.cost_share_cents ?? 0) > 0 && ` · ${euros(c.cost_share_cents!)}`}
                      </small>
                    </button>
                    <button
                      className="primary small"
                      disabled={busy}
                      onClick={() => run(() => api.propose(c.trip_id, c.request_id), driver ? 'Proposition envoyée' : 'Demande envoyée')}
                    >
                      {driver ? 'Proposer' : 'Demander'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {done.length > 0 && <h3 className="section">Derniers trajets</h3>}
      {done.map((m) => (
        <div className="card done-row" key={m.id}>
          <span>✅</span>
          <div className="contact-info">
            <strong>
              {m.pickup_label} → {m.dropoff_label}
            </strong>
            <small>
              Avec {m.other_name} · {fmt(m.meet_at)}
            </small>
          </div>
          <span className="pts">+{driver ? 15 : 10}</span>
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
      {viewUser && <UserSheet userId={viewUser.id} name={viewUser.name} onClose={() => setViewUser(null)} />}
    </>
  );
}
