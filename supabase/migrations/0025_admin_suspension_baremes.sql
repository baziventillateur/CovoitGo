-- Panel admin : suspendre un compte, et régler les barèmes (prix au kilomètre, frais de service).

-- ============ Suspension de compte ============
create table public.user_blocks (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  reason     text not null default '',
  created_at timestamptz not null default now()
);
alter table public.user_blocks enable row level security;
revoke all on public.user_blocks from public, anon, authenticated;

-- Un compte suspendu ne peut plus publier, demander, proposer ni accepter.
create function public._not_blocked() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is not null and exists (select 1 from user_blocks where user_id = auth.uid()) then
    raise exception 'Ton compte est suspendu. Écris au support pour en savoir plus.';
  end if;
  return new;
end $$;
create trigger trips_not_blocked before insert on public.trips for each row execute function public._not_blocked();
create trigger requests_not_blocked before insert on public.requests for each row execute function public._not_blocked();
create trigger matches_not_blocked before insert on public.matches for each row execute function public._not_blocked();
create trigger matches_accept_not_blocked before update of status on public.matches
  for each row when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function public._not_blocked();

create function public.admin_set_block(p_user uuid, p_blocked boolean, p_reason text default '') returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Accès réservé'; end if;
  if p_blocked then
    if exists (select 1 from admins where user_id = p_user) then raise exception 'Un compte admin ne peut pas être suspendu'; end if;
    insert into user_blocks (user_id, reason) values (p_user, left(coalesce(p_reason, ''), 300))
    on conflict (user_id) do update set reason = excluded.reason;
    -- Ses annonces ouvertes disparaissent des recherches ; les propositions en attente tombent.
    update trips set status = 'paused' where driver_id = p_user and status = 'open';
    update requests set status = 'cancelled' where passenger_id = p_user and status = 'open';
    update matches set status = 'cancelled', updated_at = now()
     where status = 'proposed' and p_user in (driver_id, passenger_id);
  else
    delete from user_blocks where user_id = p_user;
  end if;
end $$;

create function public.admin_blocked() returns table (user_id uuid, reason text)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Accès réservé'; end if;
  return query select b.user_id, b.reason from user_blocks b;
end $$;

-- ============ Barèmes réglables ============
create table public.pricing_settings (
  id              integer primary key default 1 check (id = 1),
  price_base      integer not null default 150 check (price_base between 0 and 1000),
  price_min       integer not null default 250 check (price_min between 50 and 2000),
  km_short        integer not null default 40 check (km_short between 5 and 100),   -- centimes/km, 0 à 20 km
  km_mid          integer not null default 34 check (km_mid between 5 and 100),     -- 20 à 60 km
  km_long         integer not null default 15 check (km_long between 2 and 100),    -- au-delà de 60 km
  fee_fixed       integer not null default 35 check (fee_fixed between 0 and 300),  -- centimes
  fee_percent     numeric not null default 5 check (fee_percent between 0 and 25)
);
insert into public.pricing_settings (id) values (1);
alter table public.pricing_settings enable row level security;
revoke all on public.pricing_settings from public, anon, authenticated;
grant select on public.pricing_settings to authenticated;
create policy pricing_settings_read on public.pricing_settings for select to authenticated using (true);

create or replace function public.price_for_km(p_km numeric) returns integer
language sql stable security definer set search_path = public, extensions as $$
  select greatest(s.price_min, (round((
           s.price_base
           + s.km_short * least(greatest(p_km, 0), 20)
           + s.km_mid   * least(greatest(p_km - 20, 0), 40)
           + s.km_long  * greatest(p_km - 60, 0)
         ) / 50.0) * 50)::int)
    from pricing_settings s where s.id = 1
$$;

create or replace function public.service_fee(p_cents integer) returns integer
language sql stable security definer set search_path = public, extensions as $$
  select case when coalesce(p_cents, 0) <= 0 then 0
              else least(p_cents, (round((s.fee_fixed + s.fee_percent / 100.0 * p_cents) / 5.0) * 5)::int) end
    from pricing_settings s where s.id = 1
$$;

create function public.admin_set_pricing(p jsonb) returns void
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
    fee_percent = coalesce((p ->> 'fee_percent')::numeric, fee_percent)
   where id = 1;
end $$;

revoke execute on function public._not_blocked(), public.admin_set_block(uuid, boolean, text), public.admin_blocked(),
  public.admin_set_pricing(jsonb) from public, anon;
revoke execute on function public._not_blocked() from authenticated;
grant execute on function public.admin_set_block(uuid, boolean, text), public.admin_blocked(),
  public.admin_set_pricing(jsonb) to authenticated;
