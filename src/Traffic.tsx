// Pastille discrète sur la circulation : retard estimé par rapport à une route dégagée.
// N'affiche rien tant qu'aucune estimation n'est disponible.
type Props = { minutes?: number | null; delay?: number | null };

export function TrafficTag({ minutes, delay }: Props) {
  if (delay == null || !minutes) return null;
  const free = Math.max(1, minutes - delay);
  const level = delay < 3 ? 'ok' : delay >= 15 || delay / free >= 0.3 ? 'heavy' : 'slow';
  const text =
    level === 'ok' ? 'Trafic fluide' : level === 'slow' ? `Trafic +${delay} min` : `Trafic chargé +${delay} min`;
  return (
    <span className={`traffic ${level}`} title="Estimation selon la circulation, peut évoluer">
      <i />
      {text} <em>estimé</em>
    </span>
  );
}
