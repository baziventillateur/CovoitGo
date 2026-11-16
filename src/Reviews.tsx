import { useEffect, useState } from 'react';
import { api, type PublicProfile, type Review } from './api';
import { levelOf } from './levels';
import { ago } from './format';

export function Rating({ rating, reviews }: { rating: number | null; reviews: number }) {
  if (!reviews || rating == null) return <small className="rating">Nouveau · pas encore d’avis</small>;
  return (
    <small className="rating">
      <span className="star">★</span> {Number(rating).toFixed(1).replace('.', ',')} · {reviews} avis
    </small>
  );
}

export function Stars({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  return (
    <div className={onChange ? 'stars pick' : 'stars'}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button type="button" key={n} aria-label={`${n} étoile${n > 1 ? 's' : ''}`} className={n <= value ? 'on' : ''} onClick={() => onChange(n)}>
            ★
          </button>
        ) : (
          <span key={n} className={n <= value ? 'on' : ''}>
            ★
          </span>
        ),
      )}
    </div>
  );
}

const WORDS = ['', 'Décevant', 'Moyen', 'Bien', 'Très bien', 'Parfait !'];

type CardProps = { name: string; points: number; route: string; busy: boolean; onSubmit: (rating: number, comment: string) => void };

// Affichée aux deux personnes dès que le trajet est terminé.
export function ReviewCard({ name, points, route, busy, onSubmit }: CardProps) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  return (
    <div className="card celebrate">
      <div className="celebrate-emoji">🎉</div>
      <strong className="celebrate-title">Merci et félicitations !</strong>
      <p>
        Trajet terminé avec {name}
        <br />
        <small>{route}</small>
      </p>
      <span className="level">+{points} points</span>
      <p className="ask">Comment ça s’est passé avec {name} ?</p>
      <Stars value={rating} onChange={setRating} />
      <small>{WORDS[rating] || 'Touche une étoile pour noter'}</small>
      <textarea
        rows={2}
        maxLength={500}
        placeholder="Un commentaire ? (facultatif)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <button className="primary big" disabled={busy || rating === 0} onClick={() => onSubmit(rating, comment)}>
        Envoyer mon avis
      </button>
    </div>
  );
}

export function ReviewList({ userId, onUser }: { userId: string; onUser?: (id: string, name: string) => void }) {
  const [items, setItems] = useState<Review[] | null>(null);
  useEffect(() => {
    setItems(null);
    api.reviews(userId).then(setItems).catch(() => setItems([]));
  }, [userId]);

  if (!items) return <p className="muted center">Chargement…</p>;
  if (items.length === 0) return <p className="muted center">Pas encore d’avis.</p>;
  const avg = items.reduce((sum, r) => sum + r.rating, 0) / items.length;
  return (
    <>
      <div className="avg">
        <span className="avg-num">{avg.toFixed(1).replace('.', ',')}</span>
        <div>
          <Stars value={Math.round(avg)} />
          <small>{items.length} avis</small>
        </div>
      </div>
      <ul className="reviews">
        {items.map((r) => (
          <li key={r.id}>
            <div className="review-head">
              {onUser && r.author ? (
                <button className="person name-link" onClick={() => onUser(r.author_id, r.author!.display_name)}>
                  {r.author.display_name}
                </button>
              ) : (
                <strong>{r.author?.display_name ?? 'Utilisateur'}</strong>
              )}
              <Stars value={r.rating} />
            </div>
            {r.comment && <p>{r.comment}</p>}
            <small>{ago(r.created_at)}</small>
          </li>
        ))}
      </ul>
    </>
  );
}

// Fiche publique d'une personne : niveau, badges, avis. Le téléphone et le véhicule
// n'y figurent jamais ; ils ne sont montrés que sur un trajet confirmé.
export function UserSheet({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const current = { id: userId, name };
  const [profile, setProfile] = useState<PublicProfile | null>(null);

  useEffect(() => {
    setProfile(null);
    api.publicProfile(current.id).then(setProfile).catch(() => setProfile(null));
  }, [current.id]);

  const level = profile ? levelOf(profile.points).level : null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="contact">
            <div className="avatar big">{current.name.charAt(0).toUpperCase()}</div>
            <div className="contact-info">
              <h2>{current.name}</h2>
              {level && (
                <span className="level fit">
                  {level.emoji} {level.name}
                </span>
              )}
              {profile && (
                <small>
                  Membre depuis {new Date(profile.created_at).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
                </small>
              )}
            </div>
          </div>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        {profile && profile.badges.length > 0 && (
          <div className="chips badge-chips">
            {profile.badges.map((b) => (
              <span className="chip" key={b}>
                🏅 {b}
              </span>
            ))}
          </div>
        )}
        <h3 className="section">Avis reçus</h3>
        {/* Un seul niveau : depuis une fiche, les auteurs des avis ne sont pas cliquables. */}
        <ReviewList userId={current.id} />
      </div>
    </div>
  );
}
