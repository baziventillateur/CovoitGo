import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { feeConfig } from './format';
import { api, type Mode, type Notification, type Notify } from './api';
import { Auth } from './Auth';
import { Home } from './Home';
import { Offers } from './Offers';
import { History } from './History';
import { Profile } from './Profile';
import { VersionTag } from './Version';
import { Notifications } from './Notifications';
import { Unsubscribe } from './Unsubscribe';
import { ConfirmDialog } from './ConfirmDialog';
import { enablePush, pushEnabled, pushSupported } from './push';
import { haptic } from './feedback';
import { playSound, soundFor, unlockSounds } from './sounds';

function savedMode(): Mode | null {
  try {
    const m = localStorage.getItem('covoitgo-mode');
    return m === 'driver' || m === 'passenger' ? m : null;
  } catch {
    return null;
  }
}

type Tab = 'home' | 'offers' | 'history' | 'profile';
const TABS: Tab[] = ['home', 'offers', 'history', 'profile'];
// Le balayage ne démarre pas sur un champ, un formulaire, une fenêtre ou une carte.
const NO_SWIPE = 'input, textarea, select, form, .sheet-backdrop, .leaflet-container, [data-noswipe]';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setModeState] = useState<Mode | null>(savedMode);
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).has('versement') ? 'profile' : 'home',
  );
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // « Proposer un trajet » depuis l'Accueil : ouvre le formulaire dans Mes propositions.
  const [publishNow, setPublishNow] = useState(false);
  const formShown = useCallback(() => setPublishNow(false), []);
  // Changement de page animé : la nouvelle page arrive du côté de l'onglet choisi.
  const [enter, setEnter] = useState<'left' | 'right' | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const swipe = useRef<{ x: number; y: number; t: number; dx: number; on: boolean; off: boolean } | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [meName, setMeName] = useState('');
  const [stamp, setStamp] = useState<{ text: string; emoji: string } | null>(null);
  const [askSwitch, setAskSwitch] = useState<Mode | null>(null);
  const [flipTo, setFlipTo] = useState<Mode | null>(null);
  const [askPush, setAskPush] = useState(false);
  const lastNotifId = useRef(0);
  const uid = session?.user.id;

  const notify = useCallback<Notify>((text, kind = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3500);
  }, []);

  // Tampon animé + vibration : pour les actions qui engagent (accepter, démarrer, terminer…).
  const celebrate = useCallback((text: string, emoji: string) => {
    haptic('success');
    setStamp({ text, emoji });
    window.setTimeout(() => setStamp((cur) => (cur?.text === text ? null : cur)), 1300);
  }, []);

  // Changer de mode est un vrai changement d'univers : confirmation, puis transition lente.
  function switchMode(target: Mode) {
    setAskSwitch(null);
    setShowNotifs(false);
    haptic('success');
    setFlipTo(target);
    window.setTimeout(() => {
      setMode(target);
      setTab('home');
    }, 650);
    window.setTimeout(() => setFlipTo(null), 1700);
  }

  function go(next: Tab) {
    if (next === tab) return;
    setEnter(TABS.indexOf(next) > TABS.indexOf(tab) ? 'right' : 'left');
    setTab(next);
    haptic('tap');
    window.scrollTo({ top: 0 });
  }

  // Balayage gauche / droite entre les onglets : la page suit le doigt, puis passe à l'onglet
  // voisin si le geste est assez long ou assez vif, sinon revient en place avec un petit rebond.
  function onTouchStart(e: React.TouchEvent) {
    swipe.current = null;
    if (e.touches.length !== 1 || (e.target as HTMLElement).closest(NO_SWIPE)) return;
    const p = e.touches[0];
    swipe.current = { x: p.clientX, y: p.clientY, t: performance.now(), dx: 0, on: false, off: false };
  }
  function onTouchMove(e: React.TouchEvent) {
    const s = swipe.current;
    const el = mainRef.current;
    if (!s || s.off || !el) return;
    const p = e.touches[0];
    const dx = p.clientX - s.x;
    const dy = p.clientY - s.y;
    if (!s.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        s.off = true;
        return;
      }
      if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      s.on = true;
    }
    const i = TABS.indexOf(tab);
    const edge = (dx > 0 && i === 0) || (dx < 0 && i === TABS.length - 1);
    s.dx = edge ? dx * 0.22 : dx;
    el.style.transition = 'none';
    el.style.transform = `translateX(${s.dx}px)`;
    el.style.opacity = String(1 - Math.min(0.3, Math.abs(s.dx) / 1000));
  }
  function onTouchEnd() {
    const s = swipe.current;
    const el = mainRef.current;
    swipe.current = null;
    if (!s?.on || !el) return;
    const speed = s.dx / Math.max(1, performance.now() - s.t);
    const i = TABS.indexOf(tab);
    // Geste vif : il suffit de 40 px ; geste lent : il faut 70 px.
    const fling = Math.abs(s.dx) > 40 && Math.abs(speed) > 0.45;
    const next = s.dx < -70 || (fling && s.dx < 0) ? i + 1 : s.dx > 70 || (fling && s.dx > 0) ? i - 1 : i;
    if (next !== i && next >= 0 && next < TABS.length) {
      el.style.transform = '';
      el.style.opacity = '';
      go(TABS[next]);
      return;
    }
    el.style.transition = 'transform 0.38s cubic-bezier(0.3, 1.45, 0.5, 1), opacity 0.2s';
    el.style.transform = '';
    el.style.opacity = '';
    window.setTimeout(() => {
      el.style.transition = '';
    }, 400);
  }

  function setMode(m: Mode) {
    setModeState(m);
    try {
      localStorage.setItem('covoitgo-mode', m);
    } catch {
      /* stockage indisponible : le choix vaut pour cette session */
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    window.addEventListener('pointerdown', unlockSounds);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener('pointerdown', unlockSounds);
    };
  }, []);

  const loadNotifs = useCallback(async () => {
    try {
      const list = await api.notifications();
      setNotifs(list);
      const newest = list[0]?.id ?? 0;
      // Une nouvelle notification signifie que quelque chose a bougé : on rafraîchit l'accueil.
      if (newest > lastNotifId.current) {
        if (lastNotifId.current > 0 && !list[0].read_at) {
          notify(list[0].title);
          // Un seul son par relève, pour la plus importante des nouvelles notifications.
          const fresh = list.filter((n) => n.id > lastNotifId.current && !n.read_at);
          const pick = (['accepted', 'arrived', 'proposal'] as const).find((snd) =>
            fresh.some((n) => soundFor(n.kind, n.title) === snd),
          );
          if (pick) playSound(pick);
        }
        lastNotifId.current = newest;
        setRefreshKey((k) => k + 1);
      }
    } catch {
      /* réseau momentanément indisponible : prochain passage */
    }
  }, [notify]);

  // Dernière visite, et appli installée ou non sur l'écran d'accueil (pour les indicateurs).
  useEffect(() => {
    if (!uid) return;
    const installed = window.matchMedia('(display-mode: standalone)').matches;
    supabase.rpc('touch_seen', { p_installed: installed }).then(() => {});
    // Barème des frais de service en vigueur.
    supabase
      .from('pricing_settings')
      .select('fee_fixed,fee_percent')
      .maybeSingle()
      .then(({ data }) => {
        if (data) Object.assign(feeConfig, { fixed: data.fee_fixed, percent: Number(data.fee_percent) });
      });
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    lastNotifId.current = 0;
    loadNotifs();
    supabase.from('profiles').select('display_name').eq('id', uid).single().then(({ data }) => setMeName(data?.display_name ?? ''));
    // Après une connexion par code (mot de passe oublié), on invite à en choisir un nouveau.
    try {
      if (sessionStorage.getItem('covoitgo-nouveau-mdp')) {
        sessionStorage.removeItem('covoitgo-nouveau-mdp');
        setTab('profile');
        notify('Connecté. Choisis un nouveau mot de passe dans « Mon compte ».');
      }
    } catch {
      /* stockage indisponible */
    }
    const channel = supabase
      .channel('notifications-' + uid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, loadNotifs)
      .subscribe();
    const timer = window.setInterval(loadNotifs, 20_000);
    const onVisible = () => document.visibilityState === 'visible' && loadNotifs();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [uid, loadNotifs, notify]);

  const unsubscribe = new URLSearchParams(window.location.search).get('unsubscribe');
  // Notifications sur le téléphone : proposées dès la connexion (le navigateur exige un geste pour les autoriser).
  // Déjà autorisées sur ce téléphone : l'abonnement est refait sans rien demander.
  useEffect(() => {
    if (!uid || !mode || !pushSupported()) return;
    let cancelled = false;
    (async () => {
      if (await pushEnabled()) return;
      if (Notification.permission === 'granted') return void enablePush().catch(() => {});
      if (Notification.permission === 'denied') return;
      const last = Number(localStorage.getItem('covoitgo-push-demande') ?? 0);
      if (!cancelled && Date.now() - last > 3 * 86400_000) setAskPush(true);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [uid, mode]);

  if (unsubscribe) return <Unsubscribe token={unsubscribe} />;
  if (!ready) return <p className="muted center pad">Chargement…</p>;
  if (!session || !uid) return <Auth />;

  if (!mode) {
    return (
      <div className="picker">
        <h1>Bienvenue sur CovoitGo</h1>
        <small className="by">by PaceApp</small>
        <p className="tagline">Tu es plutôt…</p>
        <button className="pick" onClick={() => setMode('driver')}>
          <span>🚗</span>
          <strong>Conducteur</strong>
          <small>J’ai une voiture et des places libres</small>
        </button>
        <button className="pick" onClick={() => setMode('passenger')}>
          <span>🙋</span>
          <strong>Passager</strong>
          <small>Je cherche un trajet</small>
        </button>
        <small className="muted">Tu pourras changer à tout moment.</small>
      </div>
    );
  }

  const unread = notifs.filter((n) => !n.read_at).length;

  return (
    <div className={`app mode-${mode}`}>
      <header>
        <div className="mode-badge">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}icon.svg`} alt="CovoitGo" width={40} height={40} />
          <span>
            <small>
              CovoitGo <i>by PaceApp</i> <VersionTag />
            </small>
            <strong>Mode {mode === 'driver' ? 'conducteur' : 'passager'}</strong>
          </span>
        </div>
        <button
          className="bell"
          aria-label="Notifications"
          onClick={() => {
            setShowNotifs(true);
            if (unread) api.markRead().then(loadNotifs).catch(() => {});
          }}
        >
          🔔{unread > 0 && <span className="count">{unread}</span>}
        </button>
      </header>

      <main
        key={tab}
        ref={mainRef}
        className={enter ? `enter-${enter}` : undefined}
        onAnimationEnd={(e) => e.target === e.currentTarget && setEnter(null)}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {tab === 'home' && (
          <Home
            mode={mode}
            uid={uid}
            meName={meName}
            refreshKey={refreshKey}
            notify={notify}
            celebrate={celebrate}
            onChanged={loadNotifs}
            onPublish={() => {
              setPublishNow(true);
              go('offers');
            }}
            onOffers={() => go('offers')}
          />
        )}
        {tab === 'offers' && (
          <Offers
            mode={mode}
            uid={uid}
            refreshKey={refreshKey}
            notify={notify}
            celebrate={celebrate}
            onChanged={loadNotifs}
            startWithForm={publishNow}
            onFormShown={formShown}
            onHome={() => go('home')}
          />
        )}
        {tab === 'history' && <History mode={mode} refreshKey={refreshKey} notify={notify} />}
        {tab === 'profile' && (
          <Profile uid={uid} notify={notify} mode={mode} onSwitchMode={() => setAskSwitch(mode === 'driver' ? 'passenger' : 'driver')} />
        )}
      </main>

      <nav>
        <span className="nav-ink" style={{ transform: `translateX(${TABS.indexOf(tab) * 100}%)` }} aria-hidden="true">
          <i key={tab} />
        </span>
        <button className={tab === 'home' ? 'active' : ''} onClick={() => go('home')}>
          <span>🏠</span>Accueil
        </button>
        <button className={tab === 'offers' ? 'active' : ''} onClick={() => go('offers')}>
          <span>{mode === 'driver' ? '📋' : '🔎'}</span>
          {mode === 'driver' ? 'Propositions' : 'Demandes'}
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => go('history')}>
          <span>🛣️</span>Trajets
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => go('profile')}>
          <span>👤</span>Profil
        </button>
      </nav>

      {showNotifs && (
        <Notifications
          items={notifs}
          onClose={() => setShowNotifs(false)}
          onOpen={(role) => {
            // Une notification de l'autre mode ne fait pas basculer sans prévenir.
            if (role !== mode) return setAskSwitch(role);
            go('home');
            setShowNotifs(false);
          }}
        />
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      {askPush && !askSwitch && (
        <ConfirmDialog
          calm
          emoji="🔔"
          text="Activer les notifications ? Tu es prévenu tout de suite quand quelqu’un te propose un trajet, l’accepte ou arrive, même appli fermée."
          yes="Activer les notifications"
          no="Plus tard"
          onYes={() => {
            setAskPush(false);
            enablePush()
              .then(() => notify('Notifications activées'))
              .catch((e) => notify((e as Error).message, 'err'));
          }}
          onNo={() => {
            localStorage.setItem('covoitgo-push-demande', String(Date.now()));
            setAskPush(false);
          }}
        />
      )}
      {askSwitch && (
        <ConfirmDialog
          calm
          emoji={askSwitch === 'driver' ? '🚗' : '🙋'}
          text={`Passer en mode ${askSwitch === 'driver' ? 'conducteur' : 'passager'} ? Tes trajets en mode ${mode === 'driver' ? 'conducteur' : 'passager'} restent en place, tu les retrouveras en revenant.`}
          yes={`Oui, passer en mode ${askSwitch === 'driver' ? 'conducteur' : 'passager'}`}
          onYes={() => switchMode(askSwitch)}
          onNo={() => setAskSwitch(null)}
        />
      )}
      {stamp && (
        <div className="stamp" aria-live="polite">
          <div className="stamp-box">
            <span className="stamp-emoji">{stamp.emoji}</span>
            <span className="stamp-check">✓</span>
            <strong>{stamp.text}</strong>
          </div>
        </div>
      )}
      {flipTo && (
        <div className={`mode-flip mode-${flipTo}`}>
          <div className="mode-flip-card">
            <span>{flipTo === 'driver' ? '🚗' : '🙋'}</span>
            <strong>Mode {flipTo === 'driver' ? 'conducteur' : 'passager'}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
