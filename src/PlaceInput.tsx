import { useEffect, useState } from 'react';
import { searchPlaces, type Place } from './geo';
import { MapPicker } from './MapPicker';
import { loadPlaces, rememberPlace, toggleFavorite, type SavedPlace } from './places';

type Props = {
  label: string;
  value: Place | null;
  onChange: (place: Place | null) => void;
};

export function PlaceInput({ label, value, onChange }: Props) {
  const [text, setText] = useState(value?.label ?? '');
  const [results, setResults] = useState<Place[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    loadPlaces().then(setSaved);
  }, []);

  function pick(place: Place) {
    onChange({ label: place.label, lng: place.lng, lat: place.lat });
    setText(place.label);
    setResults([]);
    setOpen(false);
    rememberPlace(place).then(setSaved);
  }

  // Adresses déjà validées qui correspondent à la saisie : favoris en tête, 5 visibles par défaut.
  const needle = text.trim().toLowerCase();
  const mine = saved.filter((p) => !needle || p.label.toLowerCase().includes(needle));
  const mineShown = showAll ? mine : mine.slice(0, 5);
  const mineLabels = new Set(mine.map((p) => p.label));

  useEffect(() => {
    // Une adresse déjà choisie n'a pas besoin de nouvelle recherche.
    if (value && text === value.label) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      searchPlaces(text)
        .then((r) => {
          setResults(r);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="place">
      <span>{label}</span>
      <div className="place-row">
        <input
          value={text}
          placeholder="Tape une adresse…"
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 200)}
          onChange={(e) => {
            setOpen(true);
            setText(e.target.value);
            onChange(null);
          }}
        />
        <button type="button" className="locate" aria-label={`Me localiser pour : ${label}`} onClick={() => setShowMap(true)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="7" />
            <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </button>
      </div>
      {!value && open && mine.length > 0 && (
        <ul className="suggestions saved">
          {mineShown.map((p) => (
            <li key={p.label}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
                <span>{p.fav ? '⭐' : '🕘'}</span> {p.label}
              </button>
              <button
                type="button"
                className={p.fav ? 'fav on' : 'fav'}
                aria-label={p.fav ? `Retirer ${p.label} des favoris` : `Mettre ${p.label} en favori`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleFavorite(p.label).then(setSaved)}
              >
                {p.fav ? '★' : '☆'}
              </button>
            </li>
          ))}
          {mine.length > 5 && (
            <li>
              <button type="button" className="more" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Voir moins' : `Voir les ${mine.length - 5} autres`}
              </button>
            </li>
          )}
        </ul>
      )}
      {!value && results.filter((r) => !mineLabels.has(r.label)).length > 0 && (
        <ul className="suggestions">
          {results
            .filter((r) => !mineLabels.has(r.label))
            .map((r) => (
              <li key={r.label}>
                <button type="button" onClick={() => pick(r)}>
                  {r.label}
                </button>
              </li>
            ))}
        </ul>
      )}
      {showMap && (
        <MapPicker
          title={label}
          initial={value}
          onClose={() => setShowMap(false)}
          onPick={(place) => {
            pick(place);
            setShowMap(false);
          }}
        />
      )}
      {value ? <small className="ok">Adresse retenue</small> : <small>Choisis une adresse dans la liste, ou touche la cible pour te localiser</small>}
      {error && <small className="error">{error}</small>}
    </div>
  );
}
