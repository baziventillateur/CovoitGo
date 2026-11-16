import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { Auth } from './Auth';
import { Trips } from './Trips';
import { Matches } from './Matches';
import { Profile } from './Profile';

type Tab = 'trips' | 'matches' | 'profile';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('trips');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <p className="center">Chargement…</p>;
  if (!session) return <Auth />;

  return (
    <div className="app">
      <main>
        {tab === 'trips' && <Trips />}
        {tab === 'matches' && <Matches />}
        {tab === 'profile' && <Profile />}
      </main>
      <nav>
        <button className={tab === 'trips' ? 'active' : ''} onClick={() => setTab('trips')}>
          Trajets
        </button>
        <button className={tab === 'matches' ? 'active' : ''} onClick={() => setTab('matches')}>
          Mes trajets
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
          Profil
        </button>
      </nav>
    </div>
  );
}
