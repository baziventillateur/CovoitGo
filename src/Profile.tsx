import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export function Profile() {
  const [name, setName] = useState('');
  const [points, setPoints] = useState(0);
  const [badges, setBadges] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const profile = await supabase.from('profiles').select('display_name,points').eq('id', uid).single();
      if (profile.data) {
        setName(profile.data.display_name);
        setPoints(profile.data.points);
      }
      const b = await supabase.from('user_badges').select('badges(label)').eq('user_id', uid);
      setBadges((b.data ?? []).map((r: any) => r.badges?.label).filter(Boolean));
    })();
  }, []);

  return (
    <section>
      <h2>Mon profil</h2>
      <p>
        <strong>{name}</strong>
      </p>
      <p>{points} point(s)</p>
      <h3>Badges</h3>
      {badges.length ? (
        <ul>
          {badges.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : (
        <p>Aucun badge pour l'instant.</p>
      )}
      <button className="secondary" onClick={() => supabase.auth.signOut()}>
        Se déconnecter
      </button>
    </section>
  );
}
