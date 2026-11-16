-- =====================================================================
-- Demande : nombre de places (1 à 3) + commentaire (bagages, trottinette…).
-- Conducteur : véhicule (modèle, couleur, plaque), montré au passager
-- uniquement pendant un trajet accepté.
-- =====================================================================

alter table public.requests
  add column seats smallint not null default 1 check (seats between 1 and 3),
  add column note  text check (char_length(note) <= 200);

-- ---------- Véhicule ----------------------------------------------------
create table public.vehicles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  model   text not null check (char_length(model) between 2 and 40),
  color   text check (char_length(color) <= 20),
  plate   text not null check (plate ~ '^[A-Z0-9-]{4,12}$')
);
alter table public.vehicles enable row level security;
revoke all on public.vehicles from anon, authenticated;
grant select on public.vehicles to authenticated;
create policy vehicles_self on public.vehicles for select to authenticated
  using (user_id = (select auth.uid()));

create function public.set_vehicle(p_model text, p_color text, p_plate text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_model text := trim(coalesce(p_model, ''));
  v_color text := nullif(trim(coalesce(p_color, '')), '');
  v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '[\s.]', '', 'g'));
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if char_length(v_model) not between 2 and 40 then raise exception 'Indique la marque et le modèle du véhicule'; end if;
  if v_plate !~ '^[A-Z0-9-]{4,12}$' then raise exception 'Plaque d''immatriculation invalide'; end if;
  insert into vehicles (user_id, model, color, plate) values (auth.uid(), v_model, left(v_color, 20), v_plate)
  on conflict (user_id) do update set model = excluded.model, color = excluded.color, plate = excluded.plate;
end $$;

-- ---------- Publier une demande : places + commentaire ------------------
drop function public.publish_request(text, double precision, double precision, text, double precision, double precision,
                                     timestamptz, timestamptz);
create function public.publish_request(
  p_origin_label text, p_origin_lng double precision, p_origin_lat double precision,
  p_dest_label   text, p_dest_lng   double precision, p_dest_lat   double precision,
  p_window_start timestamptz, p_window_end timestamptz,
  p_seats integer default 1, p_note text default null
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
  if p_seats is null or p_seats not between 1 and 3 then raise exception 'Entre 1 et 3 places par demande'; end if;

  insert into requests (passenger_id, origin_label, dest_label, origin, destination, window_start, window_end, seats, note)
  values (v_uid, p_origin_label, p_dest_label, v_o, v_d, p_window_start, p_window_end, p_seats,
          nullif(trim(left(coalesce(p_note, ''), 200)), ''))
  returning id into v_id;
  return v_id;
end $$;

-- ---------- Matching : il faut assez de places pour tout le groupe ------
create or replace function public._match_candidates(p_radius_m integer, p_trip_id uuid default null, p_request_id uuid default null)
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
     and t.seats - t.seats_taken >= r.seats
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

-- ---------- Accepter / annuler : on compte les places du groupe ---------
create or replace function public.respond_match(p_match_id uuid, p_accept boolean)
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
  if t.status <> 'open' or t.seats - t.seats_taken < r.seats then raise exception 'Plus assez de places sur ce trajet'; end if;
  if r.status <> 'open' then raise exception 'Cette demande n''est plus disponible'; end if;

  update trips set seats_taken = seats_taken + r.seats,
                   status = case when seats_taken + r.seats >= seats then 'full' else status end
   where id = t.id;
  update requests set status = 'matched' where id = r.id;
  update matches set status = 'accepted', updated_at = now() where id = m.id;
  update matches set status = 'cancelled', updated_at = now()
   where request_id = r.id and id <> m.id and status = 'proposed';
  return 'accepted';
end $$;

create or replace function public.cancel_match(p_match_id uuid)
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
    update trips set seats_taken = greatest(seats_taken - (select seats from requests where id = m.request_id), 0),
                     status = case when status = 'full' then 'open' else status end
     where id = m.trip_id;
    update requests set status = 'open' where id = m.request_id and status = 'matched';
  end if;
  update matches set status = 'cancelled', updated_at = now() where id = m.id;
end $$;

create or replace function public.cancel_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
  r requests;
begin
  select * into r from requests
   where id = p_request_id and passenger_id = auth.uid() and status in ('open', 'matched') for update;
  if not found then raise exception 'Demande introuvable'; end if;
  for m in select * from matches where request_id = p_request_id and status = 'accepted' loop
    update trips set seats_taken = greatest(seats_taken - r.seats, 0),
                     status = case when status = 'full' then 'open' else status end
     where id = m.trip_id;
  end loop;
  update matches set status = 'cancelled', updated_at = now()
   where request_id = p_request_id and status in ('proposed', 'accepted');
  update requests set status = 'cancelled' where id = p_request_id;
end $$;

-- ---------- Lectures enrichies -------------------------------------------
drop function public.find_requests_for_trip(uuid, integer);
create function public.find_requests_for_trip(p_trip_id uuid, p_radius_m integer default 1000)
returns table (
  request_id uuid, user_id uuid, passenger_name text, rating numeric, reviews integer,
  origin_label text, dest_label text,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric,
  seats integer, note text
)
language sql stable security definer set search_path = public, extensions as $$
  select c.request_id, p.id, p.display_name, rv.rating, rv.reviews, r.origin_label, r.dest_label,
         c.overlap_start, c.overlap_end, c.pickup_m, c.dropoff_m, c.shared_km,
         r.seats::int, r.note
    from _match_candidates(p_radius_m, p_trip_id, null) c
    join requests r on r.id = c.request_id
    join profiles p on p.id = c.passenger_id
    left join lateral (select round(avg(x.rating), 1) as rating, count(*)::int as reviews
                         from reviews x where x.target_id = p.id) rv on true
   where c.trip_id = p_trip_id
     and c.driver_id = auth.uid()
   order by c.pickup_m + c.dropoff_m, c.overlap_start
   limit 30
$$;

-- Téléphone et véhicule de l'autre personne : uniquement pendant un trajet accepté.
drop function public.my_matches();
create function public.my_matches()
returns table (
  id uuid, trip_id uuid, request_id uuid, role text, status text, stage text,
  proposed_by_me boolean, other_id uuid, other_name text, other_phone text,
  other_rating numeric, other_reviews integer, reviewed_by_me boolean,
  pickup_label text, dropoff_label text, trip_origin_label text, trip_dest_label text,
  meet_at timestamptz, cost_share_cents integer, updated_at timestamptz,
  seats integer, note text, vehicle_model text, vehicle_color text, vehicle_plate text
)
language sql stable security definer set search_path = public, extensions as $$
  select m.id, m.trip_id, m.request_id,
         case when m.driver_id = auth.uid() then 'driver' else 'passenger' end,
         m.status::text, m.stage::text, m.proposed_by = auth.uid(),
         p.id, p.display_name,
         case when m.status = 'accepted' then pp.phone end,
         rv.rating, rv.reviews,
         exists (select 1 from reviews x where x.match_id = m.id and x.author_id = auth.uid()),
         r.origin_label, r.dest_label, t.origin_label, t.dest_label,
         greatest(t.window_start, r.window_start), t.cost_share_cents, m.updated_at,
         r.seats::int, r.note,
         case when m.status = 'accepted' then v.model end,
         case when m.status = 'accepted' then v.color end,
         case when m.status = 'accepted' then v.plate end
    from matches m
    join trips t on t.id = m.trip_id
    join requests r on r.id = m.request_id
    join profiles p on p.id = case when m.driver_id = auth.uid() then m.passenger_id else m.driver_id end
    left join profile_private pp on pp.user_id = p.id
    -- Le véhicule n'a de sens que pour le passager : c'est celui du conducteur.
    left join vehicles v on v.user_id = m.driver_id and m.passenger_id = auth.uid()
    left join lateral (select round(avg(x.rating), 1) as rating, count(*)::int as reviews
                         from reviews x where x.target_id = p.id) rv on true
   where auth.uid() in (m.driver_id, m.passenger_id)
   order by m.updated_at desc
   limit 60
$$;

-- ---------- Droits ------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.publish_trip(text, double precision, double precision, text, double precision, double precision,
                      timestamptz, timestamptz, integer, integer, text),
  public.publish_request(text, double precision, double precision, text, double precision, double precision,
                         timestamptz, timestamptz, integer, text),
  public.find_trips_for_request(uuid, integer),
  public.find_requests_for_trip(uuid, integer),
  public.propose_match(uuid, uuid),
  public.respond_match(uuid, boolean),
  public.cancel_match(uuid),
  public.advance_match(uuid),
  public.cancel_trip(uuid),
  public.cancel_request(uuid),
  public.set_phone(text),
  public.set_vehicle(text, text, text),
  public.mark_notifications_read(),
  public.my_matches(),
  public.submit_review(uuid, integer, text)
to authenticated;
