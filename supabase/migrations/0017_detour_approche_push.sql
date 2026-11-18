-- Trois ajouts : détour réel par passager, alerte « ton chauffeur approche », notifications sur le téléphone.

-- ============ A. Détour réel (minutes en plus pour le conducteur) ============
create table public.trip_detours (
  trip_id     uuid not null references public.trips (id) on delete cascade,
  request_id  uuid not null references public.requests (id) on delete cascade,
  detour_min  integer not null check (detour_min between 0 and 240),
  computed_at timestamptz not null default now(),
  primary key (trip_id, request_id)
);
alter table public.trip_detours enable row level security;
revoke all on public.trip_detours from public, anon, authenticated;
grant select on public.trip_detours to authenticated;
-- Seul le conducteur du trajet lit ses détours.
create policy trip_detours_read on public.trip_detours for select to authenticated using (
  exists (select 1 from public.trips t where t.id = trip_detours.trip_id and t.driver_id = (select auth.uid()))
);

-- Points à faire calculer (5 passagers au plus par appel), pour des demandes réellement compatibles
-- avec ce trajet et pas encore calculées. Réserve les appels sur le plafond du jour.
create function public.traffic_detour_inputs(p_trip_id uuid, p_user uuid, p_request_ids uuid[])
returns table (request_id uuid,
               o_lat double precision, o_lng double precision, p_lat double precision, p_lng double precision,
               q_lat double precision, q_lng double precision, d_lat double precision, d_lng double precision,
               depart_at timestamptz, direct_min integer)
language plpgsql security definer set search_path = public, extensions as $$
declare
  t     trips;
  v_ids uuid[];
  v_n   integer;
begin
  select * into t from trips where id = p_trip_id and driver_id = p_user and status = 'open';
  if not found then raise exception 'Trajet introuvable'; end if;

  select array_agg(x.request_id) into v_ids from (
    select c.request_id from _match_candidates(3000, p_trip_id, null) c
     where c.request_id = any(p_request_ids)
       and not exists (select 1 from trip_detours d where d.trip_id = p_trip_id and d.request_id = c.request_id)
     limit 5) x;
  if v_ids is null then return; end if;

  -- Un appel par passager, plus un pour le trajet direct si sa durée avec circulation n'est pas connue.
  v_n := array_length(v_ids, 1) + (case when t.traffic_checked_at is null or t.duration_min is null then 1 else 0 end);
  insert into traffic_calls as c (day, calls) values (current_date, v_n)
  on conflict (day) do update set calls = c.calls + v_n where c.calls + v_n <= 2000;
  if not found then return; end if;

  return query
    select r.id,
           st_y(t.origin::geometry), st_x(t.origin::geometry), st_y(r.origin::geometry), st_x(r.origin::geometry),
           st_y(r.destination::geometry), st_x(r.destination::geometry),
           st_y(t.destination::geometry), st_x(t.destination::geometry),
           case when t.window_start > now() + interval '10 minutes' then t.window_start end,
           case when t.traffic_checked_at is not null then t.duration_min end
      from requests r where r.id = any(v_ids);
end $$;

create function public.traffic_detour_save(p_trip_id uuid, p_request_id uuid, p_detour_min integer) returns void
language sql security definer set search_path = public, extensions as $$
  insert into trip_detours (trip_id, request_id, detour_min)
  values (p_trip_id, p_request_id, greatest(0, least(240, p_detour_min)))
  on conflict (trip_id, request_id) do update set detour_min = excluded.detour_min, computed_at = now()
$$;

-- ============ B. « Ton chauffeur approche » ============
-- Aucune position n'est enregistrée : seule la distance au point de rendez-vous est gardée.
alter table public.matches
  add column driver_distance_m integer,
  add column driver_seen_at    timestamptz,
  add column near_notified_at  timestamptz;

create function public.driver_ping(p_match_id uuid, p_lng double precision, p_lat double precision) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  m      matches;
  v_dist integer;
  v_name text;
begin
  select * into m from matches
   where id = p_match_id and driver_id = auth.uid() and status = 'accepted' and stage = 'driver_en_route' for update;
  if not found then return null; end if;
  if m.driver_seen_at > now() - interval '8 seconds' then return m.driver_distance_m; end if;

  select round(st_distance(_point(p_lng, p_lat), r.origin))::int into v_dist from requests r where r.id = m.request_id;
  update matches set driver_distance_m = v_dist, driver_seen_at = now() where id = m.id;

  if v_dist <= 1200 and m.near_notified_at is null then
    update matches set near_notified_at = now() where id = m.id;
    select display_name into v_name from profiles where id = m.driver_id;
    insert into notifications (user_id, role, kind, title, body, match_id)
    values (m.passenger_id, 'passenger', 'near', v_name || ' arrive',
            'Ton chauffeur est tout près, à environ 1 km. Tiens-toi prêt au point de rendez-vous.', m.id);
  end if;
  return v_dist;
end $$;

-- ============ C. Notifications sur le téléphone (Web Push) ============
create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_endpoint !~ '^https://[a-z0-9.-]+/' or char_length(p_endpoint) > 1000
     or char_length(p_p256dh) not between 20 and 200 or char_length(p_auth) not between 8 and 100 then
    raise exception 'Abonnement invalide';
  end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
  -- Dix appareils au plus par personne : les plus anciens sont retirés.
  delete from push_subscriptions where user_id = auth.uid() and id not in (
    select id from push_subscriptions where user_id = auth.uid() order by created_at desc limit 10);
end $$;

create function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public, extensions as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

alter table public.notifications add column pushed_at timestamptz;

create function public._push_hook() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url text;
begin
  select value into v_url from app_settings where key = 'push_function_url';
  if v_url is null or not exists (select 1 from push_subscriptions where user_id = new.user_id) then return new; end if;
  begin
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('notification_id', new.id),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  exception when others then
    null;  -- un souci de notification ne doit jamais bloquer l'appli
  end;
  return new;
end $$;
create trigger notifications_push after insert on public.notifications
  for each row execute function public._push_hook();

-- ============ Droits ============
revoke execute on function public.traffic_detour_inputs(uuid, uuid, uuid[]), public.traffic_detour_save(uuid, uuid, integer),
  public._push_hook() from public, anon, authenticated;
revoke execute on function public.driver_ping(uuid, double precision, double precision),
  public.save_push_subscription(text, text, text), public.remove_push_subscription(text) from public, anon;
grant execute on function public.driver_ping(uuid, double precision, double precision),
  public.save_push_subscription(text, text, text), public.remove_push_subscription(text) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.traffic_detour_inputs(uuid, uuid, uuid[]),
      public.traffic_detour_save(uuid, uuid, integer) to service_role;
    grant all on public.trip_detours, public.push_subscriptions to service_role;
  end if;
end $$;
