import { useEffect, useState } from 'react';
import { api, type Review } from './api';
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

export function ReviewList({ userId }: { userId: string }) {
  const [items, setItems] = useState<Review[] | null>(null);
  useEffect(() => {
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
              <strong>{r.author?.display_name ?? 'Utilisateur'}</strong>
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

export function UserSheet({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="contact">
            <div className="avatar">{name.charAt(0).toUpperCase()}</div>
            <h2>{name}</h2>
          </div>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>
        <ReviewList userId={userId} />
      </div>
    </div>
  );
}
