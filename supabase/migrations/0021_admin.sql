-- Panel admin : réservé aux comptes listés dans « admins » (ajoutés à la main, hors dépôt).
create table public.admins (user_id uuid primary key references public.profiles (id) on delete cascade);
alter table public.admins enable row level security;
revoke all on public.admins from public, anon, authenticated;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from admins where user_id = auth.uid())
$$;

-- Dernière visite et installation de l'appli sur l'écran d'accueil.
create table public.user_meta (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  installed_at timestamptz
);
alter table public.user_meta enable row level security;
revoke all on public.user_meta from public, anon, authenticated;

create function public.touch_seen(p_installed boolean) returns void
language sql security definer set search_path = public, extensions as $$
  insert into user_meta (user_id, last_seen_at, installed_at)
  select auth.uid(), now(), case when p_installed then now() end where auth.uid() is not null
  on conflict (user_id) do update
    set last_seen_at = now(),
        installed_at = coalesce(user_meta.installed_at, excluded.installed_at)
$$;

create function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v jsonb;
begin
  if not is_admin() then raise exception 'Accès réservé'; end if;
  select jsonb_build_object(
    'users_total',     (select count(*) from profiles),
    'users_new_7d',    (select count(*) from profiles where created_at > now() - interval '7 days'),
    'active_7d',       (select count(*) from user_meta where last_seen_at > now() - interval '7 days'),
    'active_30d',      (select count(*) from user_meta where last_seen_at > now() - interval '30 days'),
    'installed',       (select count(*) from user_meta where installed_at is not null),
    'push',            (select count(distinct user_id) from push_subscriptions),
    'never_used',      (select count(*) from profiles p
                         where not exists (select 1 from trips t where t.driver_id = p.id)
                           and not exists (select 1 from requests r where r.passenger_id = p.id)),
    'trips_open',      (select count(*) from trips where status = 'open' and window_end > now()),
    'requests_open',   (select count(*) from requests where status = 'open' and window_end > now()),
    'proposed',        (select count(*) from matches where status = 'proposed'),
    'accepted',        (select count(*) from matches where status = 'accepted'),
    'completed_total', (select count(*) from matches where status = 'completed'),
    'completed_7d',    (select count(*) from matches where status = 'completed' and updated_at > now() - interval '7 days'),
    'cancelled_7d',    (select count(*) from matches where status in ('cancelled', 'declined') and updated_at > now() - interval '7 days'),
    'answered',        (select count(*) from matches where status in ('accepted', 'completed', 'declined')),
    'answered_yes',    (select count(*) from matches where status in ('accepted', 'completed')),
    'volume_total',    (select coalesce(sum(price_cents), 0) from matches where status = 'completed'),
    'volume_30d',      (select coalesce(sum(price_cents), 0) from matches where status = 'completed' and updated_at > now() - interval '30 days'),
    'fees_total',      (select coalesce(sum(fee_cents), 0) from matches where status = 'completed'),
    'fees_30d',        (select coalesce(sum(fee_cents), 0) from matches where status = 'completed' and updated_at > now() - interval '30 days'),
    'card_rides',      (select count(*) from matches where status = 'completed' and pay_method = 'card'),
    'cash_rides',      (select count(*) from matches where status = 'completed' and pay_method = 'cash'),
    'wallets_total',   (select coalesce(sum(cents), 0) from wallet_entries),
    'cash_fees_due',   (select coalesce(-sum(b), 0) from (select sum(cents) as b from wallet_entries group by user_id) x where b < 0),
    'withdrawn',       (select coalesce(-sum(cents), 0) from wallet_entries where kind = 'withdrawal'),
    'claims_open',     (select count(*) from claims where status = 'ouverte'),
    'days',            (select jsonb_agg(jsonb_build_object(
                           'day', d::date,
                           'signups', (select count(*) from profiles where created_at::date = d::date),
                           'completed', (select count(*) from matches where status = 'completed' and updated_at::date = d::date)) order by d)
                          from generate_series(current_date - 13, current_date, interval '1 day') d)
  ) into v;
  return v;
end $$;

create function public.admin_users(p_search text default null, p_limit integer default 100)
returns table (user_id uuid, name text, email text, created_at timestamptz, last_seen_at timestamptz,
               installed boolean, trips integer, requests integer, completed integer, rating numeric, wallet_cents integer)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Accès réservé'; end if;
  return query
    select p.id, p.display_name, u.email::text, p.created_at, um.last_seen_at, um.installed_at is not null,
           (select count(*)::int from trips t where t.driver_id = p.id),
           (select count(*)::int from requests r where r.passenger_id = p.id),
           (select count(*)::int from matches m where m.status = 'completed' and p.id in (m.driver_id, m.passenger_id)),
           (select round(avg(x.rating), 1) from reviews x where x.target_id = p.id),
           (select coalesce(sum(w.cents), 0)::int from wallet_entries w where w.user_id = p.id)
      from profiles p
      join auth.users u on u.id = p.id
      left join user_meta um on um.user_id = p.id
     where p_search is null or p_search = ''
        or p.display_name ilike '%' || p_search || '%' or u.email ilike '%' || p_search || '%'
     order by p.created_at desc
     limit least(greatest(p_limit, 1), 500);
end $$;

-- Journal des évènements importants, du plus récent au plus ancien.
create function public.admin_activity(p_kind text default null, p_limit integer default 100)
returns table (at timestamptz, kind text, who text, detail text)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Accès réservé'; end if;
  return query
  select e.at, e.kind, e.who, e.detail from (
    select p.created_at as at, 'inscription' as kind, p.display_name as who, 'Nouveau compte' as detail from profiles p
    union all
    select t.created_at, 'trajet', p.display_name, t.origin_label || ' → ' || t.dest_label
      from trips t join profiles p on p.id = t.driver_id
    union all
    select r.created_at, 'demande', p.display_name, r.origin_label || ' → ' || r.dest_label
      from requests r join profiles p on p.id = r.passenger_id
    union all
    select m.created_at, 'proposition', pb.display_name,
           'Avec ' || case when m.proposed_by = m.driver_id then pp.display_name else pd.display_name end
      from matches m join profiles pb on pb.id = m.proposed_by
      join profiles pp on pp.id = m.passenger_id join profiles pd on pd.id = m.driver_id
    union all
    select m.updated_at,
           case m.status when 'accepted' then 'acceptation' when 'completed' then 'termine' else 'annulation' end,
           pd.display_name || ' et ' || pp.display_name,
           r.origin_label || ' → ' || r.dest_label
             || case when m.price_cents is not null then ' · ' || to_char(m.price_cents / 100.0, 'FM990D00') || ' €' else '' end
      from matches m join requests r on r.id = m.request_id
      join profiles pp on pp.id = m.passenger_id join profiles pd on pd.id = m.driver_id
     where m.status in ('accepted', 'completed', 'cancelled', 'declined')
    union all
    select m.paid_at, 'paiement', pp.display_name, 'Carte · ' || to_char(m.price_cents / 100.0, 'FM990D00') || ' €'
      from matches m join profiles pp on pp.id = m.passenger_id where m.paid_at is not null
    union all
    select m.refunded_at, 'remboursement', pp.display_name, to_char(m.price_cents / 100.0, 'FM990D00') || ' €'
      from matches m join profiles pp on pp.id = m.passenger_id where m.refunded_at is not null
    union all
    select w.created_at, 'retrait', p.display_name, to_char(-w.cents / 100.0, 'FM990D00') || ' €'
      from wallet_entries w join profiles p on p.id = w.user_id where w.kind = 'withdrawal'
    union all
    select c.created_at, 'reclamation', p.display_name, c.category || ' : ' || left(c.message, 120)
      from claims c join profiles p on p.id = c.author_id
  ) e
  where p_kind is null or p_kind = '' or e.kind = p_kind
  order by e.at desc
  limit least(greatest(p_limit, 1), 300);
end $$;

revoke execute on function public.is_admin(), public.touch_seen(boolean), public.admin_overview(),
  public.admin_users(text, integer), public.admin_activity(text, integer) from public, anon;
grant execute on function public.is_admin(), public.touch_seen(boolean), public.admin_overview(),
  public.admin_users(text, integer), public.admin_activity(text, integer) to authenticated;
