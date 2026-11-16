import { useState, type FormEvent } from 'react';
import { supabase } from './supabase';

export function Auth() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res =
      mode === 'in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { data: { display_name: name.trim() } },
          });
    if (res.error) setMessage(res.error.message);
    else if (mode === 'up' && !res.data.session)
      setMessage('Vérifie ta boîte mail pour confirmer ton compte.');
    setBusy(false);
  }

  return (
    <div className="auth">
      <h1>CovoitGo</h1>
      <form onSubmit={submit}>
        {mode === 'up' && (
          <label>
            Prénom ou pseudo
            <input required minLength={2} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label>
          E-mail
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Mot de passe
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button disabled={busy}>{mode === 'in' ? 'Se connecter' : 'Créer mon compte'}</button>
      </form>
      {message && <p className="msg">{message}</p>}
      <button
        className="link"
        onClick={() => {
          setMode(mode === 'in' ? 'up' : 'in');
          setMessage(null);
        }}
      >
        {mode === 'in' ? 'Pas encore de compte ? Inscris-toi' : 'Déjà inscrit ? Connecte-toi'}
      </button>
    </div>
  );
}
