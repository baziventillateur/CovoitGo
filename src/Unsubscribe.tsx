import { useState } from 'react';

// Page ouverte depuis le lien « Ne plus recevoir ces e-mails » : pas besoin d'être connecté.
export function Unsubscribe({ token }: { token: string }) {
  const [state, setState] = useState<'ask' | 'busy' | 'done' | 'error'>('ask');
  const home = window.location.origin + window.location.pathname;

  async function confirm() {
    setState('busy');
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-email?unsubscribe=${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <div className="picker">
      <h1>CovoitGo</h1>
      {state === 'done' ? (
        <>
          <p>
            <strong>C’est fait.</strong> Tu ne recevras plus d’e-mails de CovoitGo.
          </p>
          <small className="muted">Tu peux les réactiver à tout moment dans ton profil.</small>
        </>
      ) : (
        <>
          <p>Ne plus recevoir les e-mails de CovoitGo ?</p>
          <button className="primary big" disabled={state === 'busy'} onClick={confirm}>
            Me désabonner
          </button>
          {state === 'error' && <p className="inline-msg">Le lien est invalide ou le service est indisponible.</p>}
        </>
      )}
      <a className="link" href={home}>
        Ouvrir CovoitGo
      </a>
    </div>
  );
}
