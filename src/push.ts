import { supabase } from './supabase';

// Notifications sur le téléphone, même appli fermée (Web Push).
export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushEnabled(): Promise<boolean> {
  const reg = await registration();
  return Notification.permission === 'granted' && !!(await reg?.pushManager.getSubscription());
}

function toBytes(base64url: string): Uint8Array {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function enablePush(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('Ce navigateur ne gère pas les notifications. Sur iPhone, ajoute d’abord l’appli à l’écran d’accueil.');
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications refusées : autorise-les dans les réglages du navigateur.');
  }
  const { data, error } = await supabase.functions.invoke('send-push', { body: { init: true } });
  if (error || !data?.public_key) throw new Error('Notifications indisponibles pour le moment');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(data.public_key).buffer as ArrayBuffer });
  const j = sub.toJSON();
  const { error: saveError } = await supabase.rpc('save_push_subscription', {
    p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth,
  });
  if (saveError) throw new Error(saveError.message);
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await supabase.rpc('remove_push_subscription', { p_endpoint: sub.endpoint });
  await sub.unsubscribe();
}
