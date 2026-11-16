import { useState, type FormEvent } from 'react';
import { supabase } from './supabase';

type Step = 'in' | 'up' | 'forgot' | 'code';

// Connexion classique par e-mail et mot de passe ; en secours, un code reçu par e-mail.
export function Auth() {
  const [step, setStep] = useState<Step>('in');
  const [codeFor, setCodeFor] = useState<'signup' | 'email'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function go(next: Step) {
    setStep(next);
    setMessage(null);
    setCode('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const mail = email.trim();

    if (step === 'in') {
      const { error } = await supabase.auth.signInWithPassword({ email: mail, password });
      if (error) setMessage('E-mail ou mot de passe incorrect.');
    } else if (step === 'up') {
      const { data, error } = await supabase.auth.signUp({
        email: mail,
        password,
        options: {
          data: { display_name: name.trim(), phone: phone.trim() },
          emailRedirectTo: window.location.origin + import.meta.env.BASE_URL,
        },
      });
      if (error) setMessage(error.message);
      else if (!data.session) {
        setCodeFor('signup');
        go('code');
      }
    } else if (step === 'forgot') {
      // On ne dit pas si un compte existe pour cette adresse.
      await supabase.auth.signInWithOtp({ email: mail, options: { shouldCreateUser: false } });
      setCodeFor('email');
      go('code');
    } else {
      const { error } = await supabase.auth.verifyOtp({ email: mail, token: code.trim(), type: codeFor });
      if (error) setMessage('Code incorrect ou expiré.');
      else if (codeFor === 'email') {
        try {
          sessionStorage.setItem('covoitgo-nouveau-mdp', '1');
        } catch {
          /* sans stockage, on n'affiche simplement pas le rappel */
        }
      }
    }
    setBusy(false);
  }

  return (
    <div className="auth">
      <div className="logo">🚗</div>
      <h1>CovoitGo</h1>
      <p className="tagline">Le covoiturage du quotidien, sans planning figé.</p>
      <form onSubmit={submit} className="card">
        {step === 'code' ? (
          <>
            <p>
              {codeFor === 'signup'
                ? `Un code vient d’être envoyé à ${email}. Saisis-le pour activer ton compte.`
                : `Si un compte existe pour ${email}, un code vient d’y être envoyé.`}
            </p>
            <label>
              Code reçu par e-mail
              <input
                className="code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                minLength={6}
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </label>
          </>
        ) : (
          <>
            {step === 'up' && (
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
            {step === 'forgot' && <p>Indique ton e-mail : on t’envoie un code pour te connecter sans mot de passe.</p>}
            <label>
              E-mail
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {step !== 'forgot' && (
              <label>
                Mot de passe
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete={step === 'up' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
          </>
        )}
        <button className="primary big" disabled={busy}>
          {step === 'in' ? 'Se connecter' : step === 'up' ? 'Créer mon compte' : step === 'forgot' ? 'Recevoir un code' : 'Valider le code'}
        </button>
        {message && <p className="inline-msg">{message}</p>}
      </form>

      {step === 'in' && (
        <>
          <button className="link" onClick={() => go('forgot')}>
            Mot de passe oublié ? Recevoir un code par e-mail
          </button>
          <button className="link" onClick={() => go('up')}>
            Pas encore de compte ? Inscris-toi
          </button>
        </>
      )}
      {step !== 'in' && (
        <button className="link" onClick={() => go('in')}>
          Retour à la connexion
        </button>
      )}
    </div>
  );
}
