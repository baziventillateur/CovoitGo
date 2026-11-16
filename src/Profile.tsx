import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { api, type Notify } from './api';
import { ReviewList } from './Reviews';

const LEVELS = [
  { min: 0, name: 'Nouveau venu', emoji: '🌱' },
  { min: 50, name: 'Régulier', emoji: '🚙' },
  { min: 150, name: 'Habitué', emoji: '⭐' },
  { min: 400, name: 'Pilier', emoji: '🏆' },
  { min: 1000, name: 'Légende', emoji: '👑' },
];

type Badge = { code: string; label: string; description: string; trips_required: number };

export function Profile({ uid, notify }: { uid: string; notify: Notify }) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState(0);
  const [phone, setPhone] = useState('');
  const [badges, setBadges] = useState<Badge[]>([]);
  const [earned, setEarned] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const [p, pp, b, ub] = await Promise.all([
        supabase.from('profiles').select('display_name,points').eq('id', uid).single(),
        supabase.from('profile_private').select('phone').eq('user_id', uid).maybeSingle(),
        supabase.from('badges').select('code,label,description,trips_required').order('trips_required'),
        supabase.from('user_badges').select('badge_code').eq('user_id', uid),
      ]);
      if (p.data) {
        setName(p.data.display_name);
        setPoints(p.data.points);
      }
      setPhone(pp.data?.phone ?? '');
      setBadges((b.data ?? []) as Badge[]);
      setEarned(new Set((ub.data ?? []).map((r: any) => r.badge_code)));
    })();
  }, [uid]);

  const levelIndex = LEVELS.reduce((acc, l, i) => (points >= l.min ? i : acc), 0);
  const level = LEVELS[levelIndex];
  const next = LEVELS[levelIndex + 1];
  const progress = next ? Math.round(((points - level.min) / (next.min - level.min)) * 100) : 100;

  async function savePhone() {
    try {
      await api.setPhone(phone);
      notify('Numéro enregistré');
    } catch (e) {
      notify((e as Error).message, 'err');
    }
  }

  return (
    <>
      <div className="card hero">
        <div className="avatar big">{name.charAt(0).toUpperCase()}</div>
        <strong className="hero-name">{name}</strong>
        <span className="level">
          {level.emoji} {level.name}
        </span>
        <div className="points">{points} points</div>
        <div className="bar">
          <div style={{ width: `${progress}%` }} />
        </div>
        <small>{next ? `Encore ${next.min - points} points pour devenir « ${next.name} »` : 'Niveau maximum atteint'}</small>
        <small>Conducteur : +15 points par trajet · Passager : +10 points</small>
      </div>

      <h3 className="section">Badges</h3>
      <div className="badges">
        {badges.map((b) => (
          <div key={b.code} className={earned.has(b.code) ? 'badge on' : 'badge'}>
            <span>{earned.has(b.code) ? '🏅' : '🔒'}</span>
            <strong>{b.label}</strong>
            <small>{b.description}</small>
          </div>
        ))}
      </div>

      <h3 className="section">Mes avis reçus</h3>
      <div className="card">
        <ReviewList userId={uid} />
      </div>

      <h3 className="section">Mon numéro</h3>
      <div className="card form">
        <label>
          Téléphone
          <input type="tel" placeholder="06 12 34 56 78" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <small>Visible uniquement par la personne avec qui ton trajet est confirmé, le temps du trajet.</small>
        </label>
        <button className="primary" onClick={savePhone}>
          Enregistrer
        </button>
      </div>

      <button className="ghost big" onClick={() => supabase.auth.signOut()}>
        Se déconnecter
      </button>
    </>
  );
}
