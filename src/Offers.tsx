import { useCallback, useEffect, useState } from 'react';
import { api, type EditTrip, type Listing, type Match, type Mode, type Notify } from './api';
import { TrafficTag } from './Traffic';
import { PublishForm } from './PublishForm';
import { euros, fmtDuration, fmtTime } from './format';
import { ConfirmDialog } from './ConfirmDialog';
import { dayLabel, groupOffers, listingOf, recurrenceLabel, type Offer } from './offers';

type Props = {
  mode: Mode;
  uid: string;
  refreshKey: number;
  notify: Notify;
  celebrate: (text: string, emoji: string) => void;
  onChanged: () => void;
  startWithForm: boolean;
  onFormShown: () => void;
  onHome: () => void;
};

type Menu = { kind: 'date'; l: Listing; leg: string | null } | { kind: 'offer'; o: Offer };

// Mes propositions (conducteur) / Mes demandes (passager) : ce que j'ai publié, une carte par publication.
// Un aller-retour tient dans une seule carte ; seule la prochaine date de chaque sens est affichée.
export function Offers({ mode, uid, refreshKey, notify, celebrate, onChanged, startWithForm, onFormShown, onHome }: Props) {
  const driver = mode === 'driver';
  const [matches, setMatches] = useState<Match[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(startWithForm);
  const [edit, setEdit] = useState<EditTrip | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ text: string; yes: string; run: () => void } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [openDates, setOpenDates] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [all, mine] = await Promise.all([api.matches(), api.listings(mode, uid)]);
      setMatches(all.filter((m) => m.role === mode));
      setListings(mine);
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setLoaded(true);
  }, [mode, uid, notify]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);
  useEffect(() => {
    if (startWithForm) {
      setShowForm(true);
      onFormShown();
    }
  }, [startWithForm, onFormShown]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) notify(success);
      await load();
      onChanged();
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setBusy(false);
  }

  const groupRun = (ids: string[], action: 'pause' | 'resume' | 'cancel' | 'cancel_requests', verb: string) =>
    run(async () => {
      const r = await api.listingsAction(ids, action);
      const kept = r.kept ? ` · ${r.kept} gardée${r.kept > 1 ? 's' : ''} (${driver ? 'passager' : 'conducteur'} confirmé)` : '';
      notify(`${r.done} date${r.done > 1 ? 's' : ''} ${verb}${r.done > 1 ? 's' : ''}${kept}`);
    });

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
          celebrate(message ?? (driver ? 'Trajet proposé !' : 'Recherche lancée !'), driver ? '🚗' : '🔎');
          load();
        }}
      />
    );
  }

  const offers = groupOffers(listings);
  const live = matches.filter((m) => m.status === 'proposed' || m.status === 'accepted');
  const on = (l: Listing) => live.filter((m) => listingOf(m, mode) === l.id);

  function legRow(l: Listing | null, leg: string | null) {
    if (!l) return null;
    const left = (l.seats ?? 0) - (l.seats_taken ?? 0);
    const paused = l.status === 'paused';
    return (
      <li className={'leg' + (paused ? ' paused' : '')} key={l.id}>
        {leg && <span className={`leg-tag ${leg === 'Aller' ? 'go' : 'back'}`}>{leg}</span>}
        <div className="leg-info">
          <strong>
            {dayLabel(l.window_start)} · {fmtTime(l.window_start)} – {fmtTime(l.window_end)}
          </strong>
          <small>
            {driver
              ? (paused ? '⏸ suspendu' : l.status === 'full' && left > 0 ? 'en cours' : left > 0 ? `${left} place${left > 1 ? 's' : ''}` : 'complet') +
                (l.cost_share_cents ? ` · ${euros(l.cost_share_cents)}` : '') +
                (l.duration_min ? ` · ≈ ${fmtDuration(l.duration_min)}` : '')
              : `${l.seats ?? 1} personne${(l.seats ?? 1) > 1 ? 's' : ''}`}
            {driver && !paused && <TrafficTag minutes={l.duration_min} delay={l.traffic_delay_min} />}
          </small>
        </div>
        <button className="ghost more" aria-label="Actions sur cette date" disabled={busy} onClick={() => setMenu({ kind: 'date', l, leg })}>
          ⋯
        </button>
      </li>
    );
  }

  function statusLine(o: Offer) {
    const ms = o.upcoming.flatMap(on);
    const incoming = ms.filter((m) => m.status === 'proposed' && !m.proposed_by_me).length;
    const confirmed = ms.filter((m) => m.status === 'accepted').length;
    if (incoming) {
      return (
        <button className="status-line alert" onClick={onHome}>
          <span className="dot" /> {incoming} {driver ? `demande${incoming > 1 ? 's' : ''} reçue${incoming > 1 ? 's' : ''}` : `proposition${incoming > 1 ? 's' : ''} reçue${incoming > 1 ? 's' : ''}`} · voir sur l’Accueil
        </button>
      );
    }
    if (confirmed) {
      return (
        <p className="status-line ok">
          ✅ {driver ? `${confirmed} passager${confirmed > 1 ? 's' : ''} confirmé${confirmed > 1 ? 's' : ''}` : `${confirmed} trajet${confirmed > 1 ? 's' : ''} confirmé${confirmed > 1 ? 's' : ''}`}
        </p>
      );
    }
    if (o.upcoming.every((l) => l.status === 'paused')) return <p className="status-line">⏸ Suspendue · invisible pour {driver ? 'les passagers' : 'les conducteurs'}</p>;
    return (
      <p className="status-line">
        <span className="pulse" /> En ligne · {driver ? 'on cherche des passagers sur ta route' : 'on cherche des conducteurs sur ta route'}
      </p>
    );
  }

  return (
    <>
      <h2 className="page-title">{driver ? 'Mes propositions' : 'Mes demandes'}</h2>
      <button className="primary big cta" onClick={() => setShowForm(true)}>
        {driver ? '＋ Proposer un trajet' : '＋ Chercher un trajet'}
      </button>

      {!loaded && <p className="muted center">Chargement…</p>}
      {loaded && !offers.length && (
        <div className="card empty">
          <div className="empty-emoji">{driver ? '🗺️' : '🔎'}</div>
          <strong>{driver ? 'Aucune proposition en ligne' : 'Aucune demande en ligne'}</strong>
          <p>
            {driver
              ? 'Propose un trajet, simple ou aller-retour, une fois ou chaque semaine.'
              : 'Indique où tu vas, une fois ou chaque semaine, à l’aller comme au retour.'}
          </p>
        </div>
      )}

      {offers.map((o) => {
        const first = o.aller.next ?? o.upcoming[0];
        const shown = new Set([o.aller.next?.id, o.retour?.next?.id]);
        const others = o.upcoming.filter((l) => !shown.has(l.id));
        const open = openDates === o.key && others.length > 0;
        const single = !o.round && first.is_return ? 'Retour' : null;
        return (
          <div className="card offer" key={o.key}>
            <div className="offer-head">
              <div className="offer-tags">
                <span className="kind-tag">{o.round ? '⇄ Aller-retour' : single ? '← Retour seul' : '→ Aller simple'}</span>
                {o.recurring && <span className="rec-tag">🔁 {recurrenceLabel(o.aller.upcoming)}</span>}
              </div>
              {o.upcoming.length > 1 && (
                <button className="ghost more" aria-label="Actions sur toute la proposition" disabled={busy} onClick={() => setMenu({ kind: 'offer', o })}>
                  ⋯
                </button>
              )}
            </div>
            <strong className="offer-route">
              {first.origin_label} <span aria-hidden="true">{o.round ? '⇄' : '→'}</span> {first.dest_label}
            </strong>
            <ul className="legs">
              {legRow(o.aller.next, o.round ? 'Aller' : null)}
              {o.retour && legRow(o.retour.next, 'Retour')}
            </ul>
            {statusLine(o)}
            {others.length > 0 && (
              <>
                <button className="dates-toggle" aria-expanded={open} onClick={() => setOpenDates(open ? null : o.key)}>
                  {open ? '▴' : '▾'} {others.length} autre{others.length > 1 ? 's' : ''} date{others.length > 1 ? 's' : ''} à venir
                </button>
                {open && (
                  <ul className="series-list">
                    {others.map((l) => {
                      const ms = on(l);
                      const leg = o.round ? (l.is_return ? 'Retour' : 'Aller') : null;
                      return (
                        <li key={l.id}>
                          <span>
                            {dayLabel(l.window_start)} · {leg ? `${leg} ` : ''}
                            {fmtTime(l.window_start)}
                            {l.status === 'paused' && ' · suspendu'}
                            {ms.some((m) => m.status === 'accepted') && ' · ✅ confirmé'}
                            {ms.some((m) => m.status === 'proposed' && !m.proposed_by_me) && ' · 🔔 demande'}
                          </span>
                          <button className="ghost more" aria-label="Actions sur cette date" disabled={busy} onClick={() => setMenu({ kind: 'date', l, leg })}>
                            ⋯
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        );
      })}

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

      {menu?.kind === 'date' &&
        (() => {
          const { l, leg } = menu;
          const ms = on(l);
          const confirmed = ms.some((m) => m.status === 'accepted');
          const pending = ms.some((m) => m.status === 'proposed');
          const close = () => setMenu(null);
          return (
            <div className="sheet-backdrop" onClick={close}>
              <div className="sheet actions-sheet" onClick={(e) => e.stopPropagation()}>
                <strong>
                  {leg ? `${leg} · ` : ''}
                  {l.origin_label} → {l.dest_label}
                </strong>
                <small>
                  {dayLabel(l.window_start)} · {fmtTime(l.window_start)} – {fmtTime(l.window_end)}
                </small>
                {driver && (
                  <>
                    <button
                      className="ghost"
                      disabled={confirmed || l.status === 'full'}
                      onClick={() => {
                        close();
                        run(async () => setEdit(await api.tripForEdit(l.id)));
                      }}
                    >
                      ✏️ Modifier cette date
                      <small>{confirmed ? 'Impossible : un passager est déjà confirmé.' : 'Adresses, heure, places, prix.'}</small>
                    </button>
                    {l.status === 'paused' ? (
                      <button className="ghost" onClick={() => { close(); run(() => api.resumeTrip(l.id), 'Trajet de nouveau visible'); }}>
                        ▶️ Reprendre
                        <small>Cette date redevient visible pour les passagers.</small>
                      </button>
                    ) : (
                      <button className="ghost" disabled={l.status !== 'open'} onClick={() => { close(); run(() => api.pauseTrip(l.id), 'Trajet suspendu'); }}>
                        ⏸ Suspendre cette date
                        <small>Plus personne ne la voit, tu la gardes pour plus tard.{pending ? ' Les demandes en attente seront annulées.' : ''}</small>
                      </button>
                    )}
                  </>
                )}
                <button
                  className="ghost danger-line"
                  onClick={() => {
                    close();
                    setAsk({
                      text:
                        'Supprimer cette date ? Elle sera définitivement supprimée.' +
                        (confirmed || pending ? ' Les personnes concernées seront prévenues.' : ''),
                      yes: 'Oui, supprimer',
                      run: () => run(() => (driver ? api.cancelTrip(l.id) : api.cancelRequest(l.id)), 'Date supprimée'),
                    });
                  }}
                >
                  🗑 Supprimer cette date
                </button>
              </div>
            </div>
          );
        })()}

      {menu?.kind === 'offer' &&
        (() => {
          const { o } = menu;
          const ids = o.upcoming.map((l) => l.id);
          const first = o.aller.next ?? o.upcoming[0];
          const anyOpen = o.upcoming.some((l) => l.status === 'open');
          const anyPaused = o.upcoming.some((l) => l.status === 'paused');
          const close = () => setMenu(null);
          return (
            <div className="sheet-backdrop" onClick={close}>
              <div className="sheet actions-sheet" onClick={(e) => e.stopPropagation()}>
                <strong>
                  {first.origin_label} {o.round ? '⇄' : '→'} {first.dest_label}
                </strong>
                <small>
                  Toute la {driver ? 'proposition' : 'demande'} · {ids.length} date{ids.length > 1 ? 's' : ''} à venir
                  {o.round ? ' (aller et retour)' : ''}
                </small>
                {driver && anyOpen && (
                  <button className="ghost" onClick={() => { close(); groupRun(ids, 'pause', 'suspendue'); }}>
                    ⏸ Tout suspendre
                    <small>Plus personne ne voit ces dates. Celles avec un passager confirmé ne bougent pas.</small>
                  </button>
                )}
                {driver && anyPaused && (
                  <button className="ghost" onClick={() => { close(); groupRun(ids, 'resume', 'reprise'); }}>
                    ▶️ Tout reprendre
                    <small>Les dates suspendues redeviennent visibles.</small>
                  </button>
                )}
                <button
                  className="ghost danger-line"
                  onClick={() => {
                    close();
                    setAsk({
                      text: `Supprimer toutes les dates à venir (${ids.length}) ? Elles seront définitivement supprimées. Celles déjà confirmées sont gardées.`,
                      yes: 'Oui, tout supprimer',
                      run: () => groupRun(ids, driver ? 'cancel' : 'cancel_requests', 'supprimée'),
                    });
                  }}
                >
                  🗑 Tout supprimer
                </button>
              </div>
            </div>
          );
        })()}
    </>
  );
}
