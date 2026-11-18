import { useEffect, useState } from 'react';
import { searchPlaces, type Place } from './geo';
import { MapPicker } from './MapPicker';

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
          onChange={(e) => {
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
      {!value && results.length > 0 && (
        <ul className="suggestions">
          {results.map((r) => (
            <li key={r.label}>
              <button
                type="button"
                onClick={() => {
                  onChange(r);
                  setText(r.label);
                  setResults([]);
                }}
              >
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
            onChange(place);
            setText(place.label);
            setResults([]);
            setShowMap(false);
          }}
        />
      )}
      {value ? <small className="ok">Adresse retenue</small> : <small>Choisis une adresse dans la liste, ou touche la cible pour te localiser</small>}
      {error && <small className="error">{error}</small>}
    </div>
  );
}
