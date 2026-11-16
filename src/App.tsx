import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { api, type Mode, type Notification, type Notify } from './api';
import { Auth } from './Auth';
import { Home } from './Home';
import { Profile } from './Profile';
import { Notifications } from './Notifications';
import { Unsubscribe } from './Unsubscribe';
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
  const [tab, setTab] = useState<'home' | 'profile'>('home');
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const lastNotifId = useRef(0);
  const uid = session?.user.id;

  const notify = useCallback<Notify>((text, kind = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3500);
  }, []);

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
  }, [uid, loadNotifs]);

  const unsubscribe = new URLSearchParams(window.location.search).get('unsubscribe');
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
        <div className="brand">CovoitGo</div>
        <div className="switch" role="tablist">
          <button className={mode === 'driver' ? 'on' : ''} onClick={() => setMode('driver')}>
            🚗 Conducteur
          </button>
          <button className={mode === 'passenger' ? 'on' : ''} onClick={() => setMode('passenger')}>
            🙋 Passager
          </button>
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
          <Home mode={mode} uid={uid} refreshKey={refreshKey} notify={notify} onChanged={loadNotifs} />
        ) : (
          <Profile uid={uid} notify={notify} />
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
            setMode(role);
            setTab('home');
            setShowNotifs(false);
          }}
        />
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
