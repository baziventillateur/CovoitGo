import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { euros } from './format';
import type { Notify } from './api';

const MIN = 2500;
const LABELS: Record<string, string> = {
  ride: 'Trajet payé par carte',
  cash_fee: 'Frais de service (trajet en espèces)',
  withdrawal: 'Retrait vers mon compte',
  refund: 'Remboursement',
  adjustment: 'Ajustement',
};

type Entry = { id: number; kind: string; cents: number; created_at: string };
type Status = { ok: boolean; reason?: string; has_account?: boolean; details_submitted?: boolean; payouts_enabled?: boolean };

async function call(action: string): Promise<any> {
  const { data, error } = await supabase.functions.invoke('paiement', { body: { action } });
  if (error) throw new Error('Service de paiement indisponible');
  return data;
}

// Porte-monnaie du chauffeur : solde, RIB (saisi chez Stripe), retrait à partir de 25 €.
export function Wallet({ notify, onClose }: { notify: Notify; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from('wallet_entries').select('id,kind,cents,created_at').order('created_at', { ascending: false }).limit(100);
    setEntries((data ?? []) as Entry[]);
    call('status').then(setStatus).catch(() => setStatus({ ok: false }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const balance = (entries ?? []).reduce((s, e) => s + e.cents, 0);
  const ready = !!status?.payouts_enabled;
  const off = status && !status.ok;

  async function act(action: 'onboard' | 'withdraw') {
    setBusy(true);
    try {
      const r = await call(action);
      if (r?.url) return void (window.location.href = r.url);
      if (!r?.ok) throw new Error(r?.message ?? 'Paiements pas encore disponibles');
      notify(`${euros(r.cents)} en route vers ton compte bancaire`);
      await load();
    } catch (e) {
      notify((e as Error).message, 'err');
    }
    setBusy(false);
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet money driver" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Mon porte-monnaie</h2>
          <button className="ghost small" onClick={onClose}>
            Fermer
          </button>
        </div>

        <div className="money-kpi">
          <small>Solde disponible</small>
          <strong>{euros(balance)}</strong>
          <div className="gauge">
            <i style={{ width: `${Math.min(100, Math.max(0, (balance / MIN) * 100))}%` }} />
          </div>
          <small>
            {balance >= MIN ? 'Tu peux retirer ton argent.' : `Retrait possible à partir de 25 € : encore ${euros(MIN - Math.max(0, balance))}.`}
          </small>
        </div>

        {off ? (
          <small className="money-note">Les paiements par carte ne sont pas encore ouverts.</small>
        ) : !status ? (
          <p className="muted center">Vérification…</p>
        ) : ready ? (
          <>
            <button className="primary big" disabled={busy || balance < MIN} onClick={() => act('withdraw')}>
              {busy ? 'Un instant…' : balance >= MIN ? `Retirer ${euros(balance)}` : 'Retirer'}
            </button>
            <small className="money-note">✅ RIB vérifié. Le virement arrive sous 2 à 3 jours ouvrés.</small>
          </>
        ) : (
          <>
            <button className="primary big" disabled={busy} onClick={() => act('onboard')}>
              {busy ? 'Un instant…' : status.has_account ? 'Terminer la vérification' : 'Ajouter mon RIB'}
            </button>
            <small className="money-note">
              {status.details_submitted
                ? 'Vérification en cours chez Stripe, notre partenaire de paiement.'
                : 'Identité et RIB se saisissent chez Stripe, notre partenaire de paiement. CovoitGo ne voit pas ton RIB.'}
            </small>
          </>
        )}

        <ul className="money-list">
          {(entries ?? []).map((e) => (
            <li key={e.id}>
              <div>
                <strong>{LABELS[e.kind] ?? e.kind}</strong>
                <small>{new Date(e.created_at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
              </div>
              <b className={e.cents < 0 ? 'minus' : ''}>
                {e.cents > 0 ? '+' : '−'}
                {euros(Math.abs(e.cents))}
              </b>
            </li>
          ))}
        </ul>
        {entries?.length === 0 && <small className="money-note">Aucun mouvement pour l’instant.</small>}
        {status?.ok && <small className="money-note">Mode test : aucun argent réel ne circule.</small>}
      </div>
    </div>
  );
}
