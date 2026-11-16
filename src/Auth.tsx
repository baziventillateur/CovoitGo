import { useState, type FormEvent } from 'react';
import { supabase } from './supabase';

export function Auth() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
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
            options: {
              data: { display_name: name.trim(), phone: phone.trim() },
              emailRedirectTo: window.location.origin + import.meta.env.BASE_URL,
            },
          });
    if (res.error) setMessage(res.error.message);
    else if (mode === 'up' && !res.data.session) setMessage('Vérifie ta boîte mail pour confirmer ton compte.');
    setBusy(false);
  }

  return (
    <div className="auth">
      <div className="logo">🚗</div>
      <h1>CovoitGo</h1>
      <p className="tagline">Le covoiturage du quotidien, sans planning figé.</p>
      <form onSubmit={submit} className="card">
        {mode === 'up' && (
          <>
            <label>
              Prénom
              <input required minLength={2} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Téléphone
              <input type="tel" required placeholder="06 12 34 56 78" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <small>Visible uniquement par la personne avec qui ton trajet est confirmé.</small>
            </label>
          </>
        )}
        <label>
          E-mail
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Mot de passe
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="primary big" disabled={busy}>
          {mode === 'in' ? 'Se connecter' : 'Créer mon compte'}
        </button>
        {message && <p className="inline-msg">{message}</p>}
      </form>
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
