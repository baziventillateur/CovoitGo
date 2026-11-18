import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { api, type Mode, type Notification, type Notify } from './api';
import { Auth } from './Auth';
import { Home } from './Home';
import { Profile } from './Profile';
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

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setModeState] = useState<Mode | null>(savedMode);
  const [tab, setTab] = useState<'home' | 'profile'>(() =>
    new URLSearchParams(window.location.search).has('versement') ? 'profile' : 'home',
  );
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
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
          <span>{mode === 'driver' ? '🚗' : '🙋'}</span>
          <span>
            <small>CovoitGo</small>
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

      <main>
        {tab === 'home' ? (
          <Home mode={mode} uid={uid} meName={meName} refreshKey={refreshKey} notify={notify} celebrate={celebrate} onChanged={loadNotifs} />
        ) : (
          <Profile uid={uid} notify={notify} mode={mode} onSwitchMode={() => setAskSwitch(mode === 'driver' ? 'passenger' : 'driver')} />
        )}
      </main>

      <nav>
        <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>
          <span>🏠</span>Accueil
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
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
            setTab('home');
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
