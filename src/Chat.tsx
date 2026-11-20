import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from './supabase';
import { api, type ChatMessage, type Match } from './api';
import { fmt } from './format';
import { haptic } from './feedback';

// Messagerie d'un trajet confirmé, comme des textos. Sur le principe du bloc « Realtime Chat » de
// Supabase (temps réel, défilement automatique, envoi immédiat), avec en plus : messages gardés en
// base, règles d'accès, accusé de lecture et relève régulière si la connexion temps réel décroche.

type Line = ChatMessage & { state?: 'sending' | 'failed' };

const QUICK = {
  driver: ['Je suis en route 🚗', 'J’arrive dans 5 min', 'Je suis au point de rendez-vous', 'Vous êtes où exactement ?'],
  passenger: ['Bonjour, vous êtes où ?', 'Je suis au point de rendez-vous', 'J’arrive dans 2 min', 'Merci, à tout de suite !'],
};

const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function day(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Aujourd’hui';
  if (d.toDateString() === yesterday.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function Chat({ m, uid, onClose }: { m: Match; uid: string; onClose: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [closed, setClosed] = useState(m.status !== 'accepted');
  const [error, setError] = useState('');
  const [otherRead, setOtherRead] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastId = useRef(0);
  const name = m.other_name;

  // Ajoute les messages reçus (temps réel ou relève), sans doublon, dans l'ordre.
  const merge = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    lastId.current = Math.max(lastId.current, ...incoming.map((x) => x.id));
    setLines((cur) => {
      const known = new Set(cur.filter((x) => x.id > 0).map((x) => x.id));
      const fresh = incoming.filter((x) => !known.has(x.id));
      if (!fresh.length) return cur;
      return [...cur, ...fresh].sort((a, b) => (a.id > 0 && b.id > 0 ? a.id - b.id : a.created_at.localeCompare(b.created_at)));
    });
    if (incoming.some((x) => x.sender_id !== uid)) api.chatMarkRead(m.id).catch(() => {});
  }, [m.id, uid]);

  const fetchNew = useCallback(() => {
    api.chatMessages(m.id, lastId.current).then(merge).catch(() => {});
    api.chatReadOf(m.id, uid).then(setOtherRead).catch(() => {});
  }, [m.id, uid, merge]);

  useEffect(() => {
    api
      .chatMessages(m.id)
      .then((list) => {
        merge(list);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    api.chatReadOf(m.id, uid).then(setOtherRead).catch(() => {});
    api.chatMarkRead(m.id).catch(() => {});
    const channel = supabase
      .channel(`chat-${m.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `match_id=eq.${m.id}` }, (p) => {
        const x = p.new as ChatMessage;
        if (x.sender_id !== uid) haptic('tap');
        merge([x]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reads', filter: `match_id=eq.${m.id}` }, (p) => {
        const r = p.new as { user_id?: string; read_at?: string };
        if (r.user_id && r.user_id !== uid && r.read_at) setOtherRead(r.read_at);
      })
      // À chaque (re)connexion, on récupère ce qui aurait pu arriver entre-temps.
      .subscribe((status) => status === 'SUBSCRIBED' && fetchNew());
    // Relève de secours et « je suis là » : l'autre n'est pas notifié tant que la conversation est ouverte.
    const poll = window.setInterval(fetchNew, 10_000);
    const beat = window.setInterval(() => api.chatMarkRead(m.id).catch(() => {}), 15_000);
    const onVisible = () => document.visibilityState === 'visible' && fetchNew();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(poll);
      window.clearInterval(beat);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [m.id, uid, merge, fetchNew]);

  // Toujours en bas de la conversation quand un message arrive.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, loaded]);

  async function send(body: string, retryOf?: number) {
    const clean = body.trim();
    if (!clean || closed) return;
    setError('');
    const temp = retryOf ?? -Date.now();
    const draft: Line = { id: temp, match_id: m.id, sender_id: uid, body: clean, created_at: new Date().toISOString(), state: 'sending' };
    setLines((cur) => (retryOf ? cur.map((x) => (x.id === retryOf ? draft : x)) : [...cur, draft]));
    if (!retryOf) setText('');
    haptic('tap');
    try {
      const id = await api.sendMessage(m.id, clean);
      lastId.current = Math.max(lastId.current, id);
      setLines((cur) => {
        // Le message a pu arriver d'abord par le temps réel : on garde un seul exemplaire.
        const already = cur.some((x) => x.id === id);
        return already ? cur.filter((x) => x.id !== temp) : cur.map((x) => (x.id === temp ? { ...x, id, state: undefined } : x));
      });
    } catch (e) {
      const msg = (e as Error).message;
      setLines((cur) => cur.map((x) => (x.id === temp ? { ...x, state: 'failed' } : x)));
      if (msg.includes('fermée')) setClosed(true);
      setError(msg);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    send(text);
    inputRef.current?.focus();
  }

  const mineLast = [...lines].reverse().find((x) => x.sender_id === uid && x.id > 0);
  const seen = !!mineLast && !!otherRead && otherRead >= mineLast.created_at;
  const quick = QUICK[m.role];

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet chat-sheet" role="dialog" aria-label={`Conversation avec ${name}`} onClick={(e) => e.stopPropagation()}>
        <div className="chat-head">
          <div className="avatar">{name.charAt(0).toUpperCase()}</div>
          <div className="contact-info">
            <strong>{name}</strong>
            <small>
              {m.pickup_label} → {m.dropoff_label} · {fmt(m.meet_at)}
            </small>
          </div>
          {m.other_phone && !closed && (
            <a className="call icon" href={`tel:${m.other_phone}`} aria-label={`Appeler ${name}`}>
              📞
            </a>
          )}
          <button className="ghost more" aria-label="Fermer la conversation" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="chat-list" ref={listRef} aria-live="polite">
          {!loaded && <p className="chat-empty">Chargement…</p>}
          {loaded && !lines.length && (
            <p className="chat-empty">
              Écris à {name} pour vous retrouver facilement.
              <br />
              La conversation se ferme à la fin du trajet.
            </p>
          )}
          {lines.map((x, i) => {
            const mine = x.sender_id === uid;
            const newDay = i === 0 || day(lines[i - 1].created_at) !== day(x.created_at);
            return (
              <div key={x.id} className="chat-row">
                {newDay && <div className="chat-day">{day(x.created_at)}</div>}
                <div className={`bubble ${mine ? 'me' : 'them'}${x.state ? ` ${x.state}` : ''}`}>
                  <span>{x.body}</span>
                  <time>{x.state === 'sending' ? 'Envoi…' : x.state === 'failed' ? 'Non envoyé' : time(x.created_at)}</time>
                </div>
                {x.state === 'failed' && !closed && (
                  <button className="link chat-retry" onClick={() => send(x.body, x.id)}>
                    Réessayer
                  </button>
                )}
              </div>
            );
          })}
          {seen && mineLast === lines[lines.length - 1] && <small className="chat-seen">Vu</small>}
        </div>

        {closed ? (
          <p className="chat-closed">🔒 Conversation fermée : le trajet est terminé.</p>
        ) : (
          <>
            {!text && (
              <div className="chat-quick">
                {quick.map((q) => (
                  <button key={q} className="chip" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            {error && <small className="error chat-error">{error}</small>}
            <form className="chat-input" onSubmit={submit}>
              <textarea
                ref={inputRef}
                rows={1}
                maxLength={500}
                value={text}
                placeholder="Ton message…"
                enterKeyHint="send"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(text);
                  }
                }}
              />
              <button className="primary send" type="submit" disabled={!text.trim()} aria-label="Envoyer">
                ➤
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
