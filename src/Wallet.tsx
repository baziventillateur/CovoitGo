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
  topup: 'Recharge par carte',
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

type Entry = { id: number; kind: string; cents: number; created_at: string };
type Status = { ok: boolean; reason?: string; has_account?: boolean; details_submitted?: boolean; payouts_enabled?: boolean; credited?: number };

async function call(action: string, extra?: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.functions.invoke('paiement', { body: { action, ...extra } });
  if (error) throw new Error('Service de paiement indisponible');
  return data;
}

// Porte-monnaie du chauffeur : solde, frais d'espèces à régler (recharge par carte), RIB (saisi chez Stripe),
// retrait à partir de 25 €, un par mois.
export function Wallet({ notify, onClose }: { notify: Notify; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState({ maxDebt: 500, perMonth: 1 });

  const loadEntries = useCallback(async () => {
    const { data } = await supabase.from('wallet_entries').select('id,kind,cents,created_at').order('created_at', { ascending: false }).limit(100);
    setEntries((data ?? []) as Entry[]);
  }, []);
  const load = useCallback(async () => {
    await loadEntries();
    supabase
      .from('pricing_settings')
      .select('cash_debt_max,withdrawals_per_month')
      .maybeSingle()
      .then(({ data }) => data && setRules({ maxDebt: data.cash_debt_max, perMonth: data.withdrawals_per_month }));
    // Le retour de Stripe après une recharge est vérifié ici : le montant est crédité une seule fois.
    call('status')
      .then((s: Status) => {
        setStatus(s);
        if (s?.credited) {
          notify(`${euros(s.credited)} ajoutés à ton porte-monnaie`);
          loadEntries();
        }
      })
      .catch(() => setStatus({ ok: false }));
  }, [loadEntries, notify]);
  useEffect(() => {
    load();
  }, [load]);

  const balance = (entries ?? []).reduce((s, e) => s + e.cents, 0);
  const debt = Math.max(0, -balance);
  const blocked = debt > rules.maxDebt;
  const ready = !!status?.payouts_enabled;
  const off = status && !status.ok;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const capped = (entries ?? []).filter((e) => e.kind === 'withdrawal' && new Date(e.created_at).getTime() >= monthStart).length >= rules.perMonth;
  const nextMonth = MONTHS[(new Date().getMonth() + 1) % 12];

  async function act(action: 'onboard' | 'withdraw' | 'topup', cents?: number) {
    setBusy(true);
    try {
      const r = await call(action, cents ? { cents } : undefined);
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

        <div className={`money-kpi${debt ? ' owed' : ''}`}>
          <small>{debt ? 'Frais de service à régler' : 'Solde disponible'}</small>
          <strong>{euros(debt || balance)}</strong>
          {debt ? (
            <small className={blocked ? 'danger' : ''}>
              {blocked
                ? 'Trajets en espèces bloqués : règle tes frais pour en proposer ou en accepter à nouveau.'
                : `Au-delà de ${euros(rules.maxDebt)} dus, les trajets en espèces sont bloqués. Tes trajets payés par carte les remboursent aussi.`}
            </small>
          ) : (
            <>
              <div className="gauge">
                <i style={{ width: `${Math.min(100, Math.max(0, (balance / MIN) * 100))}%` }} />
              </div>
              <small>
                {capped
                  ? `Retrait du mois déjà fait : prochain retrait possible le 1er ${nextMonth}.`
                  : balance >= MIN
                    ? 'Tu peux retirer ton argent.'
                    : `Retrait possible à partir de 25 € : encore ${euros(MIN - Math.max(0, balance))}.`}
              </small>
            </>
          )}
        </div>

        {status?.ok && debt > 0 && (
          <button className="primary big" disabled={busy} onClick={() => act('topup', Math.max(50, debt))}>
            {busy ? 'Un instant…' : `Régler mes frais · ${euros(Math.max(50, debt))}`}
          </button>
        )}

        {off ? (
          <small className="money-note">Les paiements par carte ne sont pas encore ouverts.</small>
        ) : !status ? (
          <p className="muted center">Vérification…</p>
        ) : ready ? (
          <>
            {!debt && (
              <button className="primary big" disabled={busy || balance < MIN || capped} onClick={() => act('withdraw')}>
                {busy ? 'Un instant…' : balance >= MIN && !capped ? `Retirer ${euros(balance)}` : 'Retirer'}
              </button>
            )}
            <small className="money-note">✅ RIB vérifié. Le virement arrive sous 2 à 3 jours ouvrés.</small>
          </>
        ) : (
          <>
            <button className={debt ? 'ghost' : 'primary big'} disabled={busy} onClick={() => act('onboard')}>
              {busy ? 'Un instant…' : status.has_account ? 'Terminer la vérification' : 'Ajouter mon RIB'}
            </button>
            <small className="money-note">
              {status.details_submitted
                ? 'Vérification en cours chez Stripe, notre partenaire de paiement.'
                : 'Identité et RIB se saisissent chez Stripe, notre partenaire de paiement. CovoitGo ne voit pas ton RIB.'}
            </small>
          </>
        )}

        {status?.ok && (
          <div className="topup-row">
            <small>Recharger d’avance, pour tes frais d’espèces</small>
            {[1000, 2000].map((c) => (
              <button key={c} className="ghost small" disabled={busy} onClick={() => act('topup', c)}>
                {euros(c).replace(',00', '')}
              </button>
            ))}
          </div>
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
