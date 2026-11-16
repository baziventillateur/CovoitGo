import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { api, type Notify } from './api';
import { ReviewList, UserSheet } from './Reviews';
import { levelOf } from './levels';
import { Account } from './Account';
import { SUPPORT_URL } from './Assistance';
import { playSound, setSoundsEnabled, soundsEnabled, unlockSounds } from './sounds';

type Badge = { code: string; label: string; description: string; trips_required: number };

export function Profile({ uid, notify }: { uid: string; notify: Notify }) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState(0);
  const [phone, setPhone] = useState('');
  const [car, setCar] = useState({ model: '', color: '', plate: '' });
  const [badges, setBadges] = useState<Badge[]>([]);
  const [earned, setEarned] = useState<Set<string>>(new Set());
  const [sounds, setSounds] = useState(soundsEnabled());
  const [emails, setEmails] = useState(true);
  const [viewUser, setViewUser] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    (async () => {
      const [p, pp, b, ub, v, ep] = await Promise.all([
        supabase.from('profiles').select('display_name,points').eq('id', uid).single(),
        supabase.from('profile_private').select('phone').eq('user_id', uid).maybeSingle(),
        supabase.from('badges').select('code,label,description,trips_required').order('trips_required'),
        supabase.from('user_badges').select('badge_code').eq('user_id', uid),
        supabase.from('vehicles').select('model,color,plate').eq('user_id', uid).maybeSingle(),
        supabase.from('email_prefs').select('enabled').eq('user_id', uid).maybeSingle(),
      ]);
      setEmails(ep.data?.enabled ?? true);
      if (v.data) setCar({ model: v.data.model, color: v.data.color ?? '', plate: v.data.plate });
      if (p.data) {
        setName(p.data.display_name);
        setPoints(p.data.points);
      }
      setPhone(pp.data?.phone ?? '');
      setBadges((b.data ?? []) as Badge[]);
      setEarned(new Set((ub.data ?? []).map((r: any) => r.badge_code)));
    })();
  }, [uid]);

  const { level, next } = levelOf(points);
  const progress = next ? Math.round(((points - level.min) / (next.min - level.min)) * 100) : 100;

  async function savePhone() {
    try {
      await api.setPhone(phone);
      notify('Numéro enregistré');
    } catch (e) {
      notify((e as Error).message, 'err');
    }
  }

  async function saveCar() {
    try {
      await api.setVehicle(car.model, car.color, car.plate);
      notify('Véhicule enregistré');
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
        <ReviewList userId={uid} onUser={(id, name) => setViewUser({ id, name })} />
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

      <h3 className="section">Mon véhicule (si je conduis)</h3>
      <div className="card form">
        <label>
          Marque et modèle
          <input placeholder="Peugeot 208" maxLength={40} value={car.model} onChange={(e) => setCar({ ...car, model: e.target.value })} />
        </label>
        <div className="row2">
          <label>
            Couleur
            <input placeholder="Grise" maxLength={20} value={car.color} onChange={(e) => setCar({ ...car, color: e.target.value })} />
          </label>
          <label>
            Plaque
            <input placeholder="AB-123-CD" maxLength={12} value={car.plate} onChange={(e) => setCar({ ...car, plate: e.target.value.toUpperCase() })} />
          </label>
        </div>
        <small>Montré à ton passager une fois le trajet confirmé, pour qu’il reconnaisse ta voiture.</small>
        <button className="primary" onClick={saveCar}>
          Enregistrer
        </button>
      </div>

      <h3 className="section">Mon compte</h3>
      <Account notify={notify} />

      <h3 className="section">E-mails</h3>
      <div className="card form">
        <div className="card-foot">
          <span>Trajet confirmé et récapitulatif de fin de trajet</span>
          <button
            className={emails ? 'chip on' : 'chip'}
            onClick={async () => {
              try {
                await api.setEmailEnabled(!emails);
                setEmails(!emails);
              } catch (e) {
                notify((e as Error).message, 'err');
              }
            }}
          >
            {emails ? 'Activés' : 'Coupés'}
          </button>
        </div>
      </div>

      <h3 className="section">Sons</h3>
      <div className="card form">
        <div className="card-foot">
          <span>Sons des notifications</span>
          <button
            className={sounds ? 'chip on' : 'chip'}
            onClick={() => {
              setSoundsEnabled(!sounds);
              setSounds(!sounds);
            }}
          >
            {sounds ? 'Activés' : 'Coupés'}
          </button>
        </div>
        <div className="chips">
          {(
            [
              ['proposal', 'Demande reçue'],
              ['accepted', 'Trajet confirmé'],
              ['arrived', 'Chauffeur arrivé'],
            ] as const
          ).map(([snd, label]) => (
            <button
              key={snd}
              className="chip"
              onClick={() => {
                unlockSounds();
                playSound(snd);
              }}
            >
              ▶ {label}
            </button>
          ))}
        </div>
        <small>Le son ne se joue que lorsque l’appli est ouverte.</small>
      </div>

      <h3 className="section">Besoin d’aide ?</h3>
      <a className="card support-card" href={SUPPORT_URL} target="_blank" rel="noopener">
        <span>💬</span>
        <span className="contact-info">
          <strong>Support CovoitGo</strong>
          <small>Discute en direct avec un conseiller</small>
        </span>
        <span>›</span>
      </a>

      <button className="ghost big" onClick={() => supabase.auth.signOut()}>
        Se déconnecter
      </button>
      {viewUser && <UserSheet userId={viewUser.id} name={viewUser.name} onClose={() => setViewUser(null)} />}
    </>
  );
}
