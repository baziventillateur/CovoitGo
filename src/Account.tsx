import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { Notify } from './api';

// Profil → Mon compte : changer de mot de passe ou d'adresse e-mail.
export function Account({ notify }: { notify: Notify }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ''));
  }, []);

  async function run(action: () => Promise<{ error: { message: string } | null }>, ok: () => void) {
    setBusy(true);
    const { error } = await action();
    if (error) notify(error.message, 'err');
    else ok();
    setBusy(false);
  }

  return (
    <div className="card form">
      <small>Connecté avec {email}</small>

      <label>
        Nouveau mot de passe
        <input type="password" minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button
        className="primary"
        disabled={busy || password.length < 6}
        onClick={() =>
          run(
            () => supabase.auth.updateUser({ password }),
            () => {
              setPassword('');
              notify('Mot de passe modifié');
            },
          )
        }
      >
        Changer le mot de passe
      </button>

      {pending ? (
        <>
          <label>
            Code envoyé à {pending}
            <input
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <button
            className="primary"
            disabled={busy || code.length < 6}
            onClick={() =>
              run(
                () => supabase.auth.verifyOtp({ email: pending, token: code, type: 'email_change' }),
                () => {
                  setEmail(pending);
                  setPending(null);
                  setCode('');
                  setNewEmail('');
                  notify('Adresse e-mail modifiée');
                },
              )
            }
          >
            Valider le code
          </button>
          <button className="link center" onClick={() => setPending(null)}>
            Annuler
          </button>
        </>
      ) : (
        <>
          <label>
            Nouvelle adresse e-mail
            <input type="email" autoComplete="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          </label>
          <button
            className="ghost"
            disabled={busy || !newEmail.includes('@') || newEmail.trim() === email}
            onClick={() =>
              run(
                () => supabase.auth.updateUser({ email: newEmail.trim() }),
                () => {
                  setPending(newEmail.trim());
                  notify('Code envoyé à la nouvelle adresse');
                },
              )
            }
          >
            Changer d’adresse e-mail
          </button>
        </>
      )}
    </div>
  );
}
