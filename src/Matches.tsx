import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { fmt } from './format';

type Match = {
  id: string;
  status: 'proposed' | 'accepted' | 'declined' | 'cancelled' | 'completed';
  proposed_by: string;
  driver_id: string;
  passenger_id: string;
  driver_confirmed: boolean;
  passenger_confirmed: boolean;
  trips: { origin_label: string; dest_label: string; window_start: string } | null;
  requests: { origin_label: string; dest_label: string } | null;
};

const STATUS: Record<Match['status'], string> = {
  proposed: 'En attente de réponse',
  accepted: 'Confirmé, à faire',
  declined: 'Refusé',
  cancelled: 'Annulé',
  completed: 'Trajet réalisé',
};

export function Matches() {
  const [me, setMe] = useState<string | null>(null);
  const [rows, setRows] = useState<Match[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('matches')
      .select(
        'id,status,proposed_by,driver_id,passenger_id,driver_confirmed,passenger_confirmed,' +
          'trips(origin_label,dest_label,window_start),requests(origin_label,dest_label)',
      )
      .order('created_at', { ascending: false });
    if (error) setMsg(error.message);
    else setRows((data as unknown as Match[]) ?? []);
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
    load();
  }, []);

  async function respond(id: string, accept: boolean) {
    const { error } = await supabase.rpc('respond_match', { p_match_id: id, p_accept: accept });
    setMsg(error ? error.message : null);
    load();
  }

  async function confirm(id: string) {
    const { data, error } = await supabase.rpc('confirm_match', { p_match_id: id });
    setMsg(error ? error.message : data === 'completed' ? 'Trajet confirmé des deux côtés : points attribués !' : 'Confirmé. En attente de l\'autre personne.');
    load();
  }

  async function cancel(id: string) {
    const { error } = await supabase.rpc('cancel_match', { p_match_id: id });
    setMsg(error ? error.message : null);
    load();
  }

  return (
    <section>
      <h2>Mes trajets</h2>
      {msg && <p className="msg">{msg}</p>}
      {rows.length === 0 && <p>Rien pour l'instant. Publie un trajet ou cherche un passager.</p>}
      <ul className="list">
        {rows.map((m) => {
          const isDriver = me === m.driver_id;
          const iConfirmed = isDriver ? m.driver_confirmed : m.passenger_confirmed;
          return (
            <li key={m.id}>
              <div>
                <strong>
                  {m.trips ? `${m.trips.origin_label} → ${m.trips.dest_label}` : 'Trajet'}
                </strong>
                <small>
                  {m.trips && fmt(m.trips.window_start)} · {isDriver ? 'Passager' : 'Conducteur'} ·{' '}
                  {STATUS[m.status]}
                </small>
              </div>
              <div className="actions">
                {m.status === 'proposed' && m.proposed_by !== me && (
                  <>
                    <button onClick={() => respond(m.id, true)}>Accepter</button>
                    <button className="secondary" onClick={() => respond(m.id, false)}>
                      Refuser
                    </button>
                  </>
                )}
                {m.status === 'accepted' && (
                  <button onClick={() => confirm(m.id)} disabled={iConfirmed}>
                    {iConfirmed ? 'Ma confirmation est envoyée' : 'Confirmer le trajet'}
                  </button>
                )}
                {(m.status === 'proposed' || m.status === 'accepted') && (
                  <button className="secondary" onClick={() => cancel(m.id)}>
                    Annuler
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
