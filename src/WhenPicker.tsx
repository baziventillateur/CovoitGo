import { useEffect, useRef, useState } from 'react';
import { haptic } from './feedback';

// Choix rapide du jour et de l'heure : un jour à toucher, une heure à toucher, minutes par quart d'heure
// (ajustables de 5 en 5). La valeur est une heure locale « AAAA-MM-JJTHH:MM ».
const pad = (n: number) => String(n).padStart(2, '0');
export const toLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function dayLabel(d: Date): string {
  const now = new Date();
  if (sameDay(d, now)) return 'Aujourd’hui';
  if (sameDay(d, new Date(now.getTime() + 86400_000))) return 'Demain';
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const whenLabel = (value: string) => {
  const d = new Date(value);
  return `${dayLabel(d)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type Props = { label: string; value: string; onChange: (value: string) => void };

export function WhenPicker({ label, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => new Date(value));
  const hoursRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(new Date(value));
    // L'heure choisie est amenée au centre de la bande.
    requestAnimationFrame(() => hoursRef.current?.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
  }, [open, value]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => new Date(today.getTime() + i * 86400_000));
  const past = draft.getTime() < Date.now();

  function set(change: (d: Date) => void) {
    const d = new Date(draft);
    change(d);
    haptic();
    setDraft(d);
  }

  function confirm() {
    haptic('success');
    onChange(toLocal(draft));
    setOpen(false);
  }

  return (
    <div className="field">
      <span>{label}</span>
      <button type="button" className="when-field" onClick={() => setOpen(true)}>
        🗓️ {whenLabel(value)}
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet when-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="when-days">
              {days.map((d) => (
                <button
                  type="button"
                  key={d.getTime()}
                  className={sameDay(d, draft) ? 'chip on' : 'chip'}
                  onClick={() => set((x) => x.setFullYear(d.getFullYear(), d.getMonth(), d.getDate()))}
                >
                  {dayLabel(d)}
                </button>
              ))}
            </div>

            <div className="when-clock">
              <button type="button" className="step" aria-label="15 minutes plus tôt" onClick={() => set((x) => x.setMinutes(x.getMinutes() - 15))}>
                −
              </button>
              <strong key={draft.getTime()}>
                {pad(draft.getHours())}:{pad(draft.getMinutes())}
              </strong>
              <button type="button" className="step" aria-label="15 minutes plus tard" onClick={() => set((x) => x.setMinutes(x.getMinutes() + 15))}>
                +
              </button>
            </div>

            <div className="when-hours" ref={hoursRef}>
              {Array.from({ length: 24 }, (_, h) => (
                <button type="button" key={h} className={draft.getHours() === h ? 'chip on' : 'chip'} onClick={() => set((x) => x.setHours(h))}>
                  {h} h
                </button>
              ))}
            </div>

            <div className="when-minutes">
              {[0, 15, 30, 45].map((m) => (
                <button type="button" key={m} className={draft.getMinutes() === m ? 'chip on' : 'chip'} onClick={() => set((x) => x.setMinutes(m))}>
                  :{pad(m)}
                </button>
              ))}
              <button type="button" className="chip fine" onClick={() => set((x) => x.setMinutes(x.getMinutes() - 5))}>
                −5
              </button>
              <button type="button" className="chip fine" onClick={() => set((x) => x.setMinutes(x.getMinutes() + 5))}>
                +5
              </button>
            </div>

            {past && <small className="error">Cette heure est déjà passée.</small>}
            <button type="button" className="primary big" disabled={past} onClick={confirm}>
              {dayLabel(draft)} à {pad(draft.getHours())}:{pad(draft.getMinutes())}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
