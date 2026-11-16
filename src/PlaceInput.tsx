import { useEffect, useState } from 'react';
import { searchPlaces, type Place } from './geo';

type Props = {
  label: string;
  value: Place | null;
  onChange: (place: Place | null) => void;
};

export function PlaceInput({ label, value, onChange }: Props) {
  const [text, setText] = useState(value?.label ?? '');
  const [results, setResults] = useState<Place[]>([]);
  const [error, setError] = useState<string | null>(null);

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
      <input
        value={text}
        placeholder="Tape une adresse…"
        onChange={(e) => {
          setText(e.target.value);
          onChange(null);
        }}
      />
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
      {value ? <small className="ok">Adresse retenue</small> : <small>Choisis une adresse dans la liste</small>}
      {error && <small className="error">{error}</small>}
    </div>
  );
}
