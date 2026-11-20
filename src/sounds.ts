// Sons de l'appli, entièrement synthétisés par le navigateur (aucun fichier audio).
// Trois évènements seulement ont un son, chacun reconnaissable ; tout le reste est silencieux.
export type Sound = 'proposal' | 'accepted' | 'arrived';

const KEY = 'covoitgo-sons';
let ctx: AudioContext | null = null;

export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* stockage indisponible : réglage valable pour cette session seulement */
  }
}

// Les navigateurs n'autorisent le son qu'après un premier geste de l'utilisateur.
export function unlockSounds() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone(at: number, freq: number, duration: number, type: OscillatorType = 'sine', volume = 0.18) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = ctx.currentTime + at;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

export function playSound(sound: Sound) {
  if (!soundsEnabled() || !ctx || ctx.state !== 'running') return;
  if (sound === 'proposal') {
    // Deux notes douces qui montent : « quelqu'un te sollicite ».
    tone(0, 660, 0.16);
    tone(0.14, 880, 0.22);
  } else if (sound === 'accepted') {
    // Petit arpège joyeux : « c'est confirmé ».
    tone(0, 523, 0.14, 'triangle');
    tone(0.11, 659, 0.14, 'triangle');
    tone(0.22, 784, 0.14, 'triangle');
    tone(0.33, 1047, 0.4, 'triangle');
  } else {
    // Double bip net, façon klaxon discret : « ton chauffeur est là ».
    tone(0, 440, 0.13, 'square', 0.1);
    tone(0.2, 440, 0.2, 'square', 0.1);
  }
}

// Quel son pour quelle notification ? null = silencieux.
export function soundFor(kind: string, title: string): Sound | null {
  if (kind === 'proposal' || kind === 'message') return 'proposal';
  if (kind === 'accepted') return 'accepted';
  if (kind === 'stage' && title.includes('arrivé')) return 'arrived';
  return null;
}
