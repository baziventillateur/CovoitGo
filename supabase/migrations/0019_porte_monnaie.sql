-- Porte-monnaie du chauffeur : solde, compte de versement Stripe (Connect), retrait à partir de 25 €.
-- L'appli ne fait que lire ; toutes les écritures passent par la fonction serveur « paiement ».

create table public.payout_accounts (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  stripe_account_id text not null unique,
  details_submitted boolean not null default false,
  payouts_enabled   boolean not null default false,
  updated_at        timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;
revoke all on public.payout_accounts from public, anon, authenticated;
grant select (user_id, details_submitted, payouts_enabled, updated_at) on public.payout_accounts to authenticated;
create policy payout_accounts_read on public.payout_accounts for select to authenticated
  using (user_id = (select auth.uid()));

-- Chaque mouvement du porte-monnaie, en centimes : positif = crédit, négatif = débit.
create table public.wallet_entries (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('ride', 'cash_fee', 'withdrawal', 'refund', 'adjustment')),
  cents      integer not null check (cents <> 0),
  match_id   uuid references public.matches (id) on delete set null,
  stripe_ref text,
  created_at timestamptz not null default now()
);
create index wallet_entries_user_idx on public.wallet_entries (user_id, created_at desc);
alter table public.wallet_entries enable row level security;
revoke all on public.wallet_entries from public, anon, authenticated;
grant select (id, user_id, kind, cents, match_id, created_at) on public.wallet_entries to authenticated;
create policy wallet_entries_read on public.wallet_entries for select to authenticated
  using (user_id = (select auth.uid()));

create function public.wallet_balance() returns integer
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(sum(cents), 0)::int from wallet_entries where user_id = auth.uid()
$$;

-- Seuil de retrait, en centimes.
create function public.wallet_min_withdrawal() returns integer language sql immutable as $$ select 2500 $$;

-- Réserve un retrait : tout le solde part, s'il atteint le seuil et que le compte de versement est prêt.
-- L'écriture est faite avant l'appel à Stripe ; en cas d'échec, elle est annulée par wallet_withdraw_cancel.
create function public.wallet_withdraw_reserve(p_user uuid)
returns table (entry_id bigint, cents integer, stripe_account_id text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  a     payout_accounts;
  v_bal integer;
  v_id  bigint;
begin
  perform pg_advisory_xact_lock(hashtext('wallet:' || p_user::text));
  select * into a from payout_accounts where user_id = p_user;
  if not found or not a.payouts_enabled then raise exception 'Ajoute d''abord ton RIB pour recevoir tes versements'; end if;
  select coalesce(sum(w.cents), 0) into v_bal from wallet_entries w where w.user_id = p_user;
  if v_bal < wallet_min_withdrawal() then raise exception 'Retrait possible à partir de 25 €'; end if;
  insert into wallet_entries (user_id, kind, cents) values (p_user, 'withdrawal', -v_bal) returning id into v_id;
  return query select v_id, v_bal, a.stripe_account_id;
end $$;

create function public.wallet_withdraw_confirm(p_entry_id bigint, p_stripe_ref text) returns void
language sql security definer set search_path = public, extensions as $$
  update wallet_entries set stripe_ref = p_stripe_ref where id = p_entry_id and kind = 'withdrawal' and stripe_ref is null
$$;

create function public.wallet_withdraw_cancel(p_entry_id bigint) returns void
language sql security definer set search_path = public, extensions as $$
  delete from wallet_entries where id = p_entry_id and kind = 'withdrawal' and stripe_ref is null
$$;

create function public.payout_account_save(p_user uuid, p_account text, p_details boolean, p_payouts boolean) returns void
language sql security definer set search_path = public, extensions as $$
  insert into payout_accounts (user_id, stripe_account_id, details_submitted, payouts_enabled)
  values (p_user, p_account, p_details, p_payouts)
  on conflict (user_id) do update
    set details_submitted = excluded.details_submitted, payouts_enabled = excluded.payouts_enabled, updated_at = now()
$$;

revoke execute on function public.wallet_withdraw_reserve(uuid), public.wallet_withdraw_confirm(bigint, text),
  public.wallet_withdraw_cancel(bigint), public.payout_account_save(uuid, text, boolean, boolean)
  from public, anon, authenticated;
revoke execute on function public.wallet_balance() from public, anon;
grant execute on function public.wallet_balance(), public.wallet_min_withdrawal() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.wallet_withdraw_reserve(uuid), public.wallet_withdraw_confirm(bigint, text),
      public.wallet_withdraw_cancel(bigint), public.payout_account_save(uuid, text, boolean, boolean) to service_role;
    grant all on public.payout_accounts, public.wallet_entries to service_role;
  end if;
end $$;
