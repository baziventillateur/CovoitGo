// Retour physique sur les actions importantes. Sans effet là où le navigateur
// ne sait pas vibrer (iPhone notamment) : l'animation à l'écran prend le relais.
export function haptic(kind: 'tap' | 'success' = 'tap') {
  try {
    navigator.vibrate?.(kind === 'success' ? [18, 50, 28] : 14);
  } catch {
    /* vibration refusée par le navigateur */
  }
}
