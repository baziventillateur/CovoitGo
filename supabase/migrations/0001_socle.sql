-- =====================================================================
-- Socle covoiturage — MVP
-- Trajets conducteurs + demandes passagers avec FENÊTRES horaires souples,
-- matching géographique PostGIS (aucun appel d'API payant), points et badges.
-- Toutes les écritures passent par des fonctions (RPC) ; les tables sont
-- en lecture seule pour les utilisateurs, protégées par RLS.
-- =====================================================================

create extension if not exists postgis with schema extensions;

-- ---------- Types ----------------------------------------------------
create type public.trip_status    as enum ('open', 'full', 'done', 'cancelled');
create type public.request_status as enum ('open', 'matched', 'done', 'cancelled');
create type public.match_status   as enum ('proposed', 'accepted', 'declined', 'cancelled', 'completed');

-- ---------- Tables ---------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  points       integer not null default 0 check (points >= 0),
  created_at   timestamptz not null default now()
);

create table public.trips (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null references public.profiles (id) on delete cascade,
  origin_label text not null check (char_length(origin_label) between 1 and 120),
  dest_label   text not null check (char_length(dest_label) between 1 and 120),
  origin       extensions.geography(Point, 4326) not null,
  destination  extensions.geography(Point, 4326) not null,
  -- Tracé calculé UNE fois à la publication (ou ligne droite par défaut).
  route        extensions.geography(LineString, 4326) not null,
  -- Fenêtre de départ souple : « je pars entre 9h et 12h ».
  window_start timestamptz not null,
  window_end   timestamptz not null,
  seats        smallint not null check (seats between 1 and 6),
  seats_taken  smallint not null default 0,
  -- Partage de frais indicatif (pas de paiement dans le MVP).
  cost_share_cents integer not null default 0 check (cost_share_cents between 0 and 20000),
  status       public.trip_status not null default 'open',
  created_at   timestamptz not null default now(),
  check (window_end > window_start),
  check (window_end - window_start <= interval '24 hours'),
  check (seats_taken between 0 and seats)
);
create index trips_route_gix  on public.trips using gist (route);
create index trips_open_idx   on public.trips (window_end) where status = 'open';
create index trips_driver_idx on public.trips (driver_id);

create table public.requests (
  id           uuid primary key default gen_random_uuid(),
  passenger_id uuid not null references public.profiles (id) on delete cascade,
  origin_label text not null check (char_length(origin_label) between 1 and 120),
  dest_label   text not null check (char_length(dest_label) between 1 and 120),
  origin       extensions.geography(Point, 4326) not null,
  destination  extensions.geography(Point, 4326) not null,
  window_start timestamptz not null,
  window_end   timestamptz not null,
  status       public.request_status not null default 'open',
  created_at   timestamptz not null default now(),
  check (window_end > window_start),
  check (window_end - window_start <= interval '24 hours')
);
create index requests_origin_gix    on public.requests using gist (origin);
create index requests_passenger_idx on public.requests (passenger_id);

create table public.matches (
  id                  uuid primary key default gen_random_uuid(),
  trip_id             uuid not null references public.trips (id) on delete cascade,
  request_id          uuid not null references public.requests (id) on delete cascade,
  driver_id           uuid not null references public.profiles (id) on delete cascade,
  passenger_id        uuid not null references public.profiles (id) on delete cascade,
  proposed_by         uuid not null references public.profiles (id) on delete cascade,
  status              public.match_status not null default 'proposed',
  driver_confirmed    boolean not null default false,
  passenger_confirmed boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (trip_id, request_id),
  check (driver_id <> passenger_id)
);
create index matches_driver_idx    on public.matches (driver_id);
create index matches_passenger_idx on public.matches (passenger_id);

create table public.points_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  delta      integer not null,
  reason     text not null,
  match_id   uuid references public.matches (id) on delete set null,
  created_at timestamptz not null default now()
);
create index points_ledger_user_idx on public.points_ledger (user_id, created_at);

create table public.badges (
  code        text primary key,
  label       text not null,
  description text not null,
  trips_required integer not null
);
insert into public.badges (code, label, description, trips_required) values
  ('premier-trajet', 'Premier trajet', 'Un premier covoiturage réalisé', 1),
  ('habitue',        'Habitué',        '10 covoiturages réalisés',       10),
  ('pilier',         'Pilier',         '50 covoiturages réalisés',       50);

create table public.user_badges (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  badge_code text not null references public.badges (code) on delete cascade,
  earned_at  timestamptz not null default now(),
  primary key (user_id, badge_code)
);

-- ---------- Profil créé automatiquement à l'inscription ---------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_name text := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
begin
  if char_length(v_name) < 2 then v_name := 'Utilisateur'; end if;
  insert into public.profiles (id, display_name) values (new.id, left(v_name, 40));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Helpers internes -----------------------------------------
create function public._point(p_lng double precision, p_lat double precision)
returns extensions.geography
language plpgsql immutable set search_path = public, extensions as $$
begin
  if p_lng is null or p_lat is null
     or p_lng not between -180 and 180 or p_lat not between -90 and 90 then
    raise exception 'Coordonnées invalides';
  end if;
  return st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
end $$;

create function public._check_window(p_start timestamptz, p_end timestamptz)
returns void language plpgsql stable as $$
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'Fenêtre horaire invalide';
  end if;
  if p_end <= now() then
    raise exception 'La fenêtre horaire est déjà passée';
  end if;
end $$;

-- Attribution de points : journal + solde, plafonné à 4 trajets récompensés par jour
-- (garde-fou simple contre les faux trajets entre complices).
create function public._award_trip_points(p_user uuid, p_delta integer, p_match uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_today integer;
  v_done  integer;
begin
  select count(*) into v_today from points_ledger
   where user_id = p_user and reason = 'trajet' and created_at >= date_trunc('day', now());
  if v_today < 4 then
    insert into points_ledger (user_id, delta, reason, match_id) values (p_user, p_delta, 'trajet', p_match);
    update profiles set points = points + p_delta where id = p_user;
  end if;

  select count(*) into v_done from matches
   where status = 'completed' and (driver_id = p_user or passenger_id = p_user);
  insert into user_badges (user_id, badge_code)
    select p_user, b.code from badges b where b.trips_required <= v_done
  on conflict do nothing;
end $$;

-- ---------- RPC : publier un trajet (conducteur) ----------------------
-- p_route_geojson : LineString GeoJSON renvoyée par l'API d'itinéraire (optionnel).
-- Sans tracé, on prend la ligne droite départ → arrivée.
create function public.publish_trip(
  p_origin_label text, p_origin_lng double precision, p_origin_lat double precision,
  p_dest_label   text, p_dest_lng   double precision, p_dest_lat   double precision,
  p_window_start timestamptz, p_window_end timestamptz,
  p_seats integer default 3,
  p_cost_share_cents integer default 0,
  p_route_geojson text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid   uuid := auth.uid();
  v_o     geography := _point(p_origin_lng, p_origin_lat);
  v_d     geography := _point(p_dest_lng, p_dest_lat);
  v_route geometry;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'Connexion requise'; end if;
  perform _check_window(p_window_start, p_window_end);
  if st_distance(v_o, v_d) < 500 then raise exception 'Trajet trop court'; end if;

  if p_route_geojson is not null then
    if char_length(p_route_geojson) > 400000 then raise exception 'Tracé trop volumineux'; end if;
    v_route := st_setsrid(st_geomfromgeojson(p_route_geojson), 4326);
    if geometrytype(v_route) <> 'LINESTRING' or st_npoints(v_route) < 2 then
      raise exception 'Le tracé doit être une LineString';
    end if;
    -- Le tracé doit bien relier le départ et l'arrivée annoncés.
    if st_distance(st_startpoint(v_route)::geography, v_o) > 1000
       or st_distance(st_endpoint(v_route)::geography, v_d) > 1000 then
      raise exception 'Le tracé ne correspond pas au départ / à l''arrivée';
    end if;
  else
    v_route := st_makeline(v_o::geometry, v_d::geometry);
  end if;

  insert into trips (driver_id, origin_label, dest_label, origin, destination, route,
                     window_start, window_end, seats, cost_share_cents)
  values (v_uid, p_origin_label, p_dest_label, v_o, v_d, v_route::geography,
          p_window_start, p_window_end, p_seats, p_cost_share_cents)
  returning id into v_id;
  return v_id;
end $$;

-- ---------- RPC : publier une demande (passager) ----------------------
create function public.publish_request(
  p_origin_label text, p_origin_lng double precision, p_origin_lat double precision,
  p_dest_label   text, p_dest_lng   double precision, p_dest_lat   double precision,
  p_window_start timestamptz, p_window_end timestamptz
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_o   geography := _point(p_origin_lng, p_origin_lat);
  v_d   geography := _point(p_dest_lng, p_dest_lat);
  v_id  uuid;
begin
  if v_uid is null then raise exception 'Connexion requise'; end if;
  perform _check_window(p_window_start, p_window_end);
  if st_distance(v_o, v_d) < 500 then raise exception 'Trajet trop court'; end if;

  insert into requests (passenger_id, origin_label, dest_label, origin, destination, window_start, window_end)
  values (v_uid, p_origin_label, p_dest_label, v_o, v_d, p_window_start, p_window_end)
  returning id into v_id;
  return v_id;
end $$;

-- ---------- Cœur du matching ------------------------------------------
-- Un trajet « colle » à une demande si :
--   1. le point de montée ET le point de descente sont à moins de p_radius_m du tracé ;
--   2. la montée est AVANT la descente le long du tracé (même sens de circulation) ;
--   3. les deux fenêtres horaires se chevauchent ;
--   4. il reste une place, et la partie commune fait au moins 1 km.
create function public._match_candidates(p_radius_m integer, p_trip_id uuid default null, p_request_id uuid default null)
returns table (
  trip_id uuid, request_id uuid, driver_id uuid, passenger_id uuid,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric, seats_left integer
)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, r.id, t.driver_id, r.passenger_id,
         greatest(t.window_start, r.window_start),
         least(t.window_end, r.window_end),
         round(st_distance(t.route, r.origin))::int,
         round(st_distance(t.route, r.destination))::int,
         round((((f.fd - f.fo) * st_length(t.route)) / 1000.0)::numeric, 1),
         (t.seats - t.seats_taken)::int
    from requests r
    join trips t
      on t.status = 'open' and r.status = 'open'
     and t.driver_id <> r.passenger_id
     and t.seats_taken < t.seats
     and st_dwithin(t.route, r.origin, least(greatest(p_radius_m, 200), 3000))
     and st_dwithin(t.route, r.destination, least(greatest(p_radius_m, 200), 3000))
     and t.window_start < r.window_end and r.window_start < t.window_end
     and least(t.window_end, r.window_end) > now()
   cross join lateral (
     select st_linelocatepoint(t.route::geometry, r.origin::geometry)      as fo,
            st_linelocatepoint(t.route::geometry, r.destination::geometry) as fd
   ) f
   where (p_trip_id is null or t.id = p_trip_id)
     and (p_request_id is null or r.id = p_request_id)
     and f.fo < f.fd
     and (f.fd - f.fo) * st_length(t.route) >= 1000
$$;

-- Passager : « quels conducteurs passent par mon trajet ? »
create function public.find_trips_for_request(p_request_id uuid, p_radius_m integer default 1000)
returns table (
  trip_id uuid, driver_name text, origin_label text, dest_label text,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric,
  seats_left integer, cost_share_cents integer
)
language sql stable security definer set search_path = public, extensions as $$
  select c.trip_id, p.display_name, t.origin_label, t.dest_label,
         c.overlap_start, c.overlap_end, c.pickup_m, c.dropoff_m, c.shared_km,
         c.seats_left, t.cost_share_cents
    from _match_candidates(p_radius_m, null, p_request_id) c
    join trips t on t.id = c.trip_id
    join profiles p on p.id = c.driver_id
   where c.request_id = p_request_id
     and c.passenger_id = auth.uid()
   order by c.pickup_m + c.dropoff_m, c.overlap_start
   limit 30
$$;

-- Conducteur : « qui pourrais-je prendre sur ce trajet ? » (propositions automatiques)
create function public.find_requests_for_trip(p_trip_id uuid, p_radius_m integer default 1000)
returns table (
  request_id uuid, passenger_name text, origin_label text, dest_label text,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric
)
language sql stable security definer set search_path = public, extensions as $$
  select c.request_id, p.display_name, r.origin_label, r.dest_label,
         c.overlap_start, c.overlap_end, c.pickup_m, c.dropoff_m, c.shared_km
    from _match_candidates(p_radius_m, p_trip_id, null) c
    join requests r on r.id = c.request_id
    join profiles p on p.id = c.passenger_id
   where c.trip_id = p_trip_id
     and c.driver_id = auth.uid()
   order by c.pickup_m + c.dropoff_m, c.overlap_start
   limit 30
$$;

-- ---------- RPC : cycle de vie d'une mise en relation -----------------
-- Proposer : le passager demande une place, ou le conducteur invite un passager.
create function public.propose_match(p_trip_id uuid, p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  c     record;
  v_id  uuid;
begin
  if v_uid is null then raise exception 'Connexion requise'; end if;
  -- On ne peut proposer que sur une paire réellement compatible (rayon max).
  select * into c from _match_candidates(3000, p_trip_id, p_request_id) m;
  if not found then raise exception 'Trajet et demande non compatibles'; end if;
  if v_uid not in (c.driver_id, c.passenger_id) then raise exception 'Action non autorisée'; end if;

  insert into matches (trip_id, request_id, driver_id, passenger_id, proposed_by)
  values (p_trip_id, p_request_id, c.driver_id, c.passenger_id, v_uid)
  on conflict (trip_id, request_id) do nothing
  returning id into v_id;
  if v_id is null then raise exception 'Une proposition existe déjà pour ce trajet'; end if;
  return v_id;
end $$;

-- Répondre : seule l'AUTRE partie peut accepter ou refuser.
create function public.respond_match(p_match_id uuid, p_accept boolean)
returns public.match_status
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  m     matches;
  t     trips;
  r     requests;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or v_uid is null or v_uid not in (m.driver_id, m.passenger_id) then
    raise exception 'Proposition introuvable';
  end if;
  if m.status <> 'proposed' then raise exception 'Proposition déjà traitée'; end if;
  if m.proposed_by = v_uid then raise exception 'C''est à l''autre personne de répondre'; end if;

  if not p_accept then
    update matches set status = 'declined', updated_at = now() where id = m.id;
    return 'declined';
  end if;

  select * into t from trips where id = m.trip_id for update;
  select * into r from requests where id = m.request_id for update;
  if t.status <> 'open' or t.seats_taken >= t.seats then raise exception 'Plus de place sur ce trajet'; end if;
  if r.status <> 'open' then raise exception 'Cette demande n''est plus disponible'; end if;

  update trips set seats_taken = seats_taken + 1,
                   status = case when seats_taken + 1 >= seats then 'full' else status end
   where id = t.id;
  update requests set status = 'matched' where id = r.id;
  update matches set status = 'accepted', updated_at = now() where id = m.id;
  -- Les autres propositions en attente pour cette demande tombent.
  update matches set status = 'cancelled', updated_at = now()
   where request_id = r.id and id <> m.id and status = 'proposed';
  return 'accepted';
end $$;

-- Annuler (avant réalisation) : libère la place et rouvre la demande.
create function public.cancel_match(p_match_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  m     matches;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or v_uid is null or v_uid not in (m.driver_id, m.passenger_id) then
    raise exception 'Proposition introuvable';
  end if;
  if m.status not in ('proposed', 'accepted') then raise exception 'Annulation impossible'; end if;

  if m.status = 'accepted' then
    update trips set seats_taken = seats_taken - 1,
                     status = case when status = 'full' then 'open' else status end
     where id = m.trip_id;
    update requests set status = 'open' where id = m.request_id and status = 'matched';
  end if;
  update matches set status = 'cancelled', updated_at = now() where id = m.id;
end $$;

-- Confirmer le trajet réalisé : il faut la confirmation des DEUX personnes,
-- et pas avant le début de la fenêtre. Les points tombent à ce moment-là.
create function public.confirm_match(p_match_id uuid)
returns public.match_status
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  m     matches;
  t     trips;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or v_uid is null or v_uid not in (m.driver_id, m.passenger_id) then
    raise exception 'Trajet introuvable';
  end if;
  if m.status <> 'accepted' then raise exception 'Ce trajet n''est pas en cours'; end if;
  select * into t from trips where id = m.trip_id;
  if now() < t.window_start then raise exception 'Le trajet n''a pas encore commencé'; end if;

  if v_uid = m.driver_id then m.driver_confirmed := true; else m.passenger_confirmed := true; end if;

  if m.driver_confirmed and m.passenger_confirmed then
    update matches set driver_confirmed = true, passenger_confirmed = true,
                       status = 'completed', updated_at = now() where id = m.id;
    update requests set status = 'done' where id = m.request_id;
    perform _award_trip_points(m.driver_id, 15, m.id);     -- le conducteur partage sa voiture
    perform _award_trip_points(m.passenger_id, 10, m.id);
    return 'completed';
  end if;

  update matches set driver_confirmed = m.driver_confirmed,
                     passenger_confirmed = m.passenger_confirmed, updated_at = now() where id = m.id;
  return 'accepted';
end $$;

-- Annuler son trajet / sa demande (annule aussi les mises en relation ouvertes).
create function public.cancel_trip(p_trip_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update trips set status = 'cancelled'
   where id = p_trip_id and driver_id = auth.uid() and status in ('open', 'full');
  if not found then raise exception 'Trajet introuvable'; end if;
  update requests set status = 'open'
   where status = 'matched'
     and id in (select request_id from matches where trip_id = p_trip_id and status = 'accepted');
  update matches set status = 'cancelled', updated_at = now()
   where trip_id = p_trip_id and status in ('proposed', 'accepted');
end $$;

create function public.cancel_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
begin
  perform 1 from requests
   where id = p_request_id and passenger_id = auth.uid() and status in ('open', 'matched') for update;
  if not found then raise exception 'Demande introuvable'; end if;
  for m in select * from matches where request_id = p_request_id and status = 'accepted' loop
    update trips set seats_taken = seats_taken - 1,
                     status = case when status = 'full' then 'open' else status end
     where id = m.trip_id;
  end loop;
  update matches set status = 'cancelled', updated_at = now()
   where request_id = p_request_id and status in ('proposed', 'accepted');
  update requests set status = 'cancelled' where id = p_request_id;
end $$;

-- ---------- Sécurité : RLS + droits -----------------------------------
alter table public.profiles      enable row level security;
alter table public.trips         enable row level security;
alter table public.requests      enable row level security;
alter table public.matches       enable row level security;
alter table public.points_ledger enable row level security;
alter table public.badges        enable row level security;
alter table public.user_badges   enable row level security;

-- Lecture seule côté client ; aucune écriture directe sur les tables.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.trips, public.requests, public.matches,
                public.points_ledger, public.badges, public.user_badges to authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Un trajet (adresses, horaires) n'est lisible que par son conducteur
-- et par les passagers mis en relation ; la recherche passe par les RPC.
create policy trips_read on public.trips for select to authenticated using (
  driver_id = (select auth.uid())
  or exists (select 1 from public.matches m
              where m.trip_id = trips.id and m.passenger_id = (select auth.uid())
                and m.status in ('proposed', 'accepted', 'completed'))
);
create policy requests_read on public.requests for select to authenticated using (
  passenger_id = (select auth.uid())
  or exists (select 1 from public.matches m
              where m.request_id = requests.id and m.driver_id = (select auth.uid())
                and m.status in ('proposed', 'accepted', 'completed'))
);
create policy matches_read on public.matches for select to authenticated using (
  driver_id = (select auth.uid()) or passenger_id = (select auth.uid())
);
create policy ledger_read on public.points_ledger for select to authenticated
  using (user_id = (select auth.uid()));
create policy badges_read on public.badges for select to authenticated using (true);
create policy user_badges_read on public.user_badges for select to authenticated using (true);

-- Fonctions : rien pour le public, uniquement les RPC utiles pour les connectés.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.publish_trip(text, double precision, double precision, text, double precision, double precision,
                      timestamptz, timestamptz, integer, integer, text),
  public.publish_request(text, double precision, double precision, text, double precision, double precision,
                         timestamptz, timestamptz),
  public.find_trips_for_request(uuid, integer),
  public.find_requests_for_trip(uuid, integer),
  public.propose_match(uuid, uuid),
  public.respond_match(uuid, boolean),
  public.cancel_match(uuid),
  public.confirm_match(uuid),
  public.cancel_trip(uuid),
  public.cancel_request(uuid)
to authenticated;
