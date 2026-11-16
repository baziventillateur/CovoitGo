export const LEVELS = [
  { min: 0, name: 'Nouveau venu', emoji: '🌱' },
  { min: 50, name: 'Régulier', emoji: '🚙' },
  { min: 150, name: 'Habitué', emoji: '⭐' },
  { min: 400, name: 'Pilier', emoji: '🏆' },
  { min: 1000, name: 'Légende', emoji: '👑' },
];

export function levelOf(points: number) {
  const index = LEVELS.reduce((acc, l, i) => (points >= l.min ? i : acc), 0);
  return { level: LEVELS[index], next: LEVELS[index + 1] as (typeof LEVELS)[number] | undefined };
}
