-- Frais des trajets en espèces : au-delà de 5 € dus, le chauffeur ne peut plus proposer ni accepter
-- de trajet payé en espèces. Il règle en rechargeant son porte-monnaie par carte (ou ses trajets
-- payés par carte remboursent la dette d'eux-mêmes). Retraits : un par mois.

alter table public.pricing_settings
  add column cash_debt_max integer not null default 500 check (cash_debt_max between 0 and 5000),          -- centimes
  add column withdrawals_per_month integer not null default 1 check (withdrawals_per_month between 1 and 10);

alter table public.wallet_entries drop constraint wallet_entries_kind_check;
alter table public.wallet_entries add constraint wallet_entries_kind_check
  check (kind in ('ride', 'cash_fee', 'withdrawal', 'refund', 'adjustment', 'topup'));

-- ============ Dette de frais ============
-- Ce que le chauffeur doit : la part négative de son porte-monnaie, en centimes.
create function public._cash_debt(p_user uuid) returns integer
language sql stable security definer set search_path = public, extensions as $$
  select greatest(0, -coalesce(sum(cents), 0))::int from wallet_entries where user_id = p_user
$$;

create function public._euros(p_cents integer) returns text language sql immutable as $$
  select replace(to_char(p_cents / 100.0, 'FM9990.00'), '.', ',') || ' €'
$$;

create function public.cash_debt_status() returns table (debt integer, max_debt integer, blocked boolean)
language sql stable security definer set search_path = public, extensions as $$
  select x.d, s.cash_debt_max, x.d > s.cash_debt_max
    from (select _cash_debt(auth.uid()) as d) x, pricing_settings s
   where s.id = 1
$$;

-- Seul le chauffeur est retenu : le passager peut toujours demander ou accepter.
create function public._cash_debt_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_debt integer;
  v_max  integer;
begin
  if new.pay_method <> 'cash' or auth.uid() is null or auth.uid() <> new.driver_id then return new; end if;
  select cash_debt_max into v_max from pricing_settings where id = 1;
  v_debt := _cash_debt(new.driver_id);
  if v_debt > v_max then
    raise exception 'Tu dois % de frais de service. Règle-les dans ton porte-monnaie pour proposer ou accepter des trajets payés en espèces.', _euros(v_debt);
  end if;
  return new;
end $$;
-- Noms choisis pour passer après matches_payment_defaults (qui fixe le mode de paiement).
create trigger matches_payment_guard before insert on public.matches
  for each row execute function public._cash_debt_guard();
create trigger matches_payment_guard_accept before update of status on public.matches
  for each row when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function public._cash_debt_guard();

-- Suites d'un changement de statut (version 0020) + alerte quand la dette dépasse le seuil.
create or replace function public._match_payment_events() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url  text;
  v_debt integer;
  v_max  integer;
begin
  if new.status = 'accepted' and old.status <> 'accepted' and new.pay_method = 'card' and new.paid_at is null then
    insert into notifications (user_id, role, kind, title, body, match_id)
    values (new.passenger_id, 'passenger', 'pay', 'Paie ton trajet',
            'Ton trajet est accepté. Règle-le par carte pour le confirmer : ton chauffeur partira ensuite.', new.id);
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    if new.pay_method = 'card' and new.paid_at is not null and new.refunded_at is null
       and coalesce(new.price_cents, 0) - new.fee_cents > 0 then
      insert into wallet_entries (user_id, kind, cents, match_id)
      values (new.driver_id, 'ride', new.price_cents - new.fee_cents, new.id);
    elsif new.pay_method = 'cash' and new.fee_cents > 0 then
      insert into wallet_entries (user_id, kind, cents, match_id)
      values (new.driver_id, 'cash_fee', -new.fee_cents, new.id);
      select cash_debt_max into v_max from pricing_settings where id = 1;
      v_debt := _cash_debt(new.driver_id);
      if v_debt > v_max and v_debt - new.fee_cents <= v_max then
        insert into notifications (user_id, role, kind, title, body)
        values (new.driver_id, 'driver', 'debt', 'Frais de service à régler',
                'Tu dois ' || _euros(v_debt) || ' de frais sur tes trajets en espèces. Règle-les dans ton porte-monnaie '
                || 'pour continuer à prendre des passagers qui paient en espèces.');
      end if;
    end if;
  end if;

  if new.status in ('cancelled', 'declined') and old.status not in ('cancelled', 'declined')
     and new.paid_at is not null and new.refunded_at is null then
    select value into v_url from app_settings where key = 'refund_function_url';
    if v_url is not null then
      begin
        perform net.http_post(url := v_url, body := jsonb_build_object('match_id', new.id),
                              headers := '{"Content-Type": "application/json"}'::jsonb);
      exception when others then null;
      end;
    end if;
  end if;
  return new;
end $$;

-- ============ Recharge par carte ============
create table public.wallet_topups (
  session_id text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  cents      integer not null check (cents between 50 and 10000),
  created_at timestamptz not null default now(),
  paid_at    timestamptz
);
create index wallet_topups_pending_idx on public.wallet_topups (user_id, created_at desc) where paid_at is null;
alter table public.wallet_topups enable row level security;
revoke all on public.wallet_topups from public, anon, authenticated;

create function public.wallet_topup_start(p_user uuid, p_session text, p_cents integer) returns void
language sql security definer set search_path = public, extensions as $$
  insert into wallet_topups (session_id, user_id, cents) values (p_session, p_user, p_cents)
  on conflict (session_id) do nothing
$$;

create function public.wallet_topup_pending(p_user uuid) returns table (session_id text, cents integer)
language sql stable security definer set search_path = public, extensions as $$
  select t.session_id, t.cents from wallet_topups t
   where t.user_id = p_user and t.paid_at is null and t.created_at > now() - interval '3 days'
   order by t.created_at desc limit 3
$$;

-- Crédite une recharge payée, une seule fois. Renvoie le montant crédité (0 si déjà fait).
create function public.wallet_topup_credit(p_session text, p_payment_intent text) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  t wallet_topups;
begin
  update wallet_topups set paid_at = now() where session_id = p_session and paid_at is null returning * into t;
  if not found then return 0; end if;
  insert into wallet_entries (user_id, kind, cents, stripe_ref) values (t.user_id, 'topup', t.cents, nullif(p_payment_intent, ''));
  return t.cents;
end $$;

-- ============ Retraits : nombre limité par mois (heure de Paris) ============
create or replace function public.wallet_withdraw_reserve(p_user uuid)
returns table (entry_id bigint, cents integer, stripe_account_id text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  a      payout_accounts;
  v_bal  integer;
  v_id   bigint;
  v_per  integer;
  v_from timestamptz := date_trunc('month', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  v_next text;
begin
  perform pg_advisory_xact_lock(hashtext('wallet:' || p_user::text));
  select * into a from payout_accounts where user_id = p_user;
  if not found or not a.payouts_enabled then raise exception 'Ajoute d''abord ton RIB pour recevoir tes versements'; end if;
  select withdrawals_per_month into v_per from pricing_settings where id = 1;
  if (select count(*) from wallet_entries w where w.user_id = p_user and w.kind = 'withdrawal' and w.created_at >= v_from) >= v_per then
    v_next := (array['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'])
              [extract(month from (v_from at time zone 'Europe/Paris') + interval '1 month')::int];
    raise exception '% : prochain retrait possible le 1er %',
      case when v_per = 1 then 'Un retrait par mois' else v_per || ' retraits par mois au maximum' end, v_next;
  end if;
  select coalesce(sum(w.cents), 0) into v_bal from wallet_entries w where w.user_id = p_user;
  if v_bal < wallet_min_withdrawal() then raise exception 'Retrait possible à partir de 25 €'; end if;
  insert into wallet_entries (user_id, kind, cents) values (p_user, 'withdrawal', -v_bal) returning id into v_id;
  return query select v_id, v_bal, a.stripe_account_id;
end $$;

-- ============ Barèmes : les deux nouveaux réglages ============
create or replace function public.admin_set_pricing(p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Accès réservé'; end if;
  update pricing_settings set
    price_base  = coalesce((p ->> 'price_base')::int, price_base),
    price_min   = coalesce((p ->> 'price_min')::int, price_min),
    km_short    = coalesce((p ->> 'km_short')::int, km_short),
    km_mid      = coalesce((p ->> 'km_mid')::int, km_mid),
    km_long     = coalesce((p ->> 'km_long')::int, km_long),
    fee_fixed   = coalesce((p ->> 'fee_fixed')::int, fee_fixed),
    fee_percent = coalesce((p ->> 'fee_percent')::numeric, fee_percent),
    cash_debt_max         = coalesce((p ->> 'cash_debt_max')::int, cash_debt_max),
    withdrawals_per_month = coalesce((p ->> 'withdrawals_per_month')::int, withdrawals_per_month)
   where id = 1;
end $$;

revoke execute on function public._cash_debt(uuid), public._cash_debt_guard(), public.wallet_topup_start(uuid, text, integer),
  public.wallet_topup_pending(uuid), public.wallet_topup_credit(text, text) from public, anon, authenticated;
revoke execute on function public.cash_debt_status() from public, anon;
grant execute on function public.cash_debt_status() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.wallet_topup_start(uuid, text, integer), public.wallet_topup_pending(uuid),
      public.wallet_topup_credit(text, text) to service_role;
    grant all on public.wallet_topups to service_role;
  end if;
end $$;
