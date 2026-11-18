-- =====================================================================
-- Prix encadré : conseillé selon la distance, ajustable par le conducteur
-- dans une fourchette étroite ; le passager paie au prorata de sa portion.
-- =====================================================================

-- Barème par place (en centimes), dégressif avec la distance, arrondi à 0,50 €.
--   1 € de base + 0,18 €/km jusqu'à 20 km, 0,11 €/km de 20 à 60 km, 0,07 €/km au-delà.
create function public.price_for_km(p_km numeric) returns integer
language sql immutable as $$
  select greatest(150, (round((
           100
           + 18 * least(greatest(p_km, 0), 20)
           + 11 * least(greatest(p_km - 20, 0), 40)
           +  7 * greatest(p_km - 60, 0)
         ) / 50.0) * 50)::int)
$$;

-- Marge d'ajustement du conducteur : 1 € + 10 % du prix, plafonnée à 5 €.
-- Elle pèse donc lourd sur un petit prix (± 60 % à 2 €) et peu sur un grand (± 12 % à 40 €).
create function public.price_margin(p_reco integer) returns integer
language sql immutable as $$
  select (round(least(500, 100 + p_reco * 0.10) / 50.0) * 50)::int
$$;

alter table public.trips
  add column route_factor numeric not null default 1,   -- 1,3 quand le tracé est une ligne droite
  add column price_ratio  numeric not null default 1;   -- prix choisi / prix conseillé
alter table public.matches add column price_cents integer;  -- prix figé à la mise en relation

-- Tracé validé (ou ligne droite à défaut) et facteur de correction de distance.
create function public._route_for(o extensions.geography, d extensions.geography, p_route_geojson text,
                                  out route extensions.geometry, out factor numeric)
language plpgsql immutable set search_path = public, extensions as $$
begin
  if p_route_geojson is not null then
    if char_length(p_route_geojson) > 400000 then raise exception 'Tracé trop volumineux'; end if;
    route := st_setsrid(st_geomfromgeojson(p_route_geojson), 4326);
    if geometrytype(route) <> 'LINESTRING' or st_npoints(route) < 2 then
      raise exception 'Le tracé doit être une LineString';
    end if;
    if st_distance(st_startpoint(route)::geography, o) > 1000
       or st_distance(st_endpoint(route)::geography, d) > 1000 then
      raise exception 'Le tracé ne correspond pas au départ / à l''arrivée';
    end if;
    -- Un « tracé » démesuré par rapport au vol d'oiseau gonflerait le prix : on le borne.
    factor := 1;
    if st_length(route::geography) > 2.5 * st_distance(o, d) + 2000 then
      raise exception 'Le tracé est incohérent avec le trajet';
    end if;
  else
    route := st_makeline(o::geometry, d::geometry);
    factor := 1.3;  -- une route réelle est en moyenne 30 % plus longue que la ligne droite
  end if;
end $$;

-- Devis avant publication : distance, prix conseillé et fourchette autorisée.
create function public.quote_trip(
  p_origin_lng double precision, p_origin_lat double precision,
  p_dest_lng double precision, p_dest_lat double precision,
  p_route_geojson text default null
) returns table (km numeric, reco_cents integer, min_cents integer, max_cents integer)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_o geography := _point(p_origin_lng, p_origin_lat);
  v_d geography := _point(p_dest_lng, p_dest_lat);
  r   record;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into r from _route_for(v_o, v_d, p_route_geojson);
  km := round((st_length(r.route::geography) * r.factor / 1000.0)::numeric, 1);
  reco_cents := price_for_km(km);
  min_cents := greatest(100, reco_cents - price_margin(reco_cents));
  max_cents := reco_cents + price_margin(reco_cents);
  return next;
end $$;

-- Publication : le prix demandé doit rester dans la fourchette (0 ou vide = prix conseillé).
create or replace function public.publish_trip(
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
  r       record;
  v_reco  integer;
  v_price integer;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'Connexion requise'; end if;
  perform _check_window(p_window_start, p_window_end);
  if st_distance(v_o, v_d) < 500 then raise exception 'Trajet trop court'; end if;

  select * into r from _route_for(v_o, v_d, p_route_geojson);
  v_reco := price_for_km((st_length(r.route::geography) * r.factor / 1000.0)::numeric);
  v_price := case when coalesce(p_cost_share_cents, 0) <= 0 then v_reco else p_cost_share_cents end;
  if v_price < greatest(100, v_reco - price_margin(v_reco)) or v_price > v_reco + price_margin(v_reco) then
    raise exception 'Le prix doit rester dans la fourchette proposée';
  end if;

  insert into trips (driver_id, origin_label, dest_label, origin, destination, route,
                     window_start, window_end, seats, cost_share_cents, route_factor, price_ratio)
  values (v_uid, p_origin_label, p_dest_label, v_o, v_d, r.route::geography,
          p_window_start, p_window_end, p_seats, v_price, r.factor, v_price::numeric / v_reco)
  returning id into v_id;
  return v_id;
end $$;

-- Prix d'un passager : barème sur SA portion du trajet, avec le même ajustement que le
-- conducteur a choisi, multiplié par le nombre de places, sans dépasser le prix du trajet complet.
create function public._passenger_price(p_trip_id uuid, p_shared_km numeric, p_seats integer) returns integer
language sql stable security definer set search_path = public, extensions as $$
  select p_seats * least(
           t.cost_share_cents,
           greatest(100, (round(price_for_km(p_shared_km * t.route_factor) * t.price_ratio / 50.0) * 50)::int))
    from trips t where t.id = p_trip_id
$$;

-- Le prix est figé au moment de la proposition : il ne bouge plus ensuite.
create or replace function public.propose_match(p_trip_id uuid, p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  c     record;
  v_id  uuid;
begin
  if v_uid is null then raise exception 'Connexion requise'; end if;
  select * into c from _match_candidates(3000, p_trip_id, p_request_id) m;
  if not found then raise exception 'Trajet et demande non compatibles'; end if;
  if v_uid not in (c.driver_id, c.passenger_id) then raise exception 'Action non autorisée'; end if;

  insert into matches (trip_id, request_id, driver_id, passenger_id, proposed_by, price_cents)
  values (p_trip_id, p_request_id, c.driver_id, c.passenger_id, v_uid,
          _passenger_price(p_trip_id, c.shared_km, (select seats from requests where id = p_request_id)))
  on conflict (trip_id, request_id) do nothing
  returning id into v_id;
  if v_id is null then raise exception 'Une proposition existe déjà pour ce trajet'; end if;
  return v_id;
end $$;

-- Recherche côté passager : le prix affiché est celui qu'il paiera réellement.
create or replace function public.find_trips_for_request(p_request_id uuid, p_radius_m integer default 1000)
returns table (
  trip_id uuid, user_id uuid, driver_name text, rating numeric, reviews integer,
  origin_label text, dest_label text,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric,
  seats_left integer, cost_share_cents integer
)
language sql stable security definer set search_path = public, extensions as $$
  select c.trip_id, p.id, p.display_name, rv.rating, rv.reviews, t.origin_label, t.dest_label,
         c.overlap_start, c.overlap_end, c.pickup_m, c.dropoff_m, c.shared_km,
         c.seats_left, _passenger_price(c.trip_id, c.shared_km, r.seats)
    from _match_candidates(p_radius_m, null, p_request_id) c
    join trips t on t.id = c.trip_id
    join requests r on r.id = c.request_id
    join profiles p on p.id = c.driver_id
    left join lateral (select round(avg(x.rating), 1) as rating, count(*)::int as reviews
                         from reviews x where x.target_id = p.id) rv on true
   where c.request_id = p_request_id
     and c.passenger_id = auth.uid()
   order by c.pickup_m + c.dropoff_m, c.overlap_start
   limit 30
$$;

create or replace function public.my_matches()
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
         greatest(t.window_start, r.window_start), coalesce(m.price_cents, t.cost_share_cents), m.updated_at,
         r.seats::int, r.note,
         case when m.status = 'accepted' then v.model end,
         case when m.status = 'accepted' then v.color end,
         case when m.status = 'accepted' then v.plate end
    from matches m
    join trips t on t.id = m.trip_id
    join requests r on r.id = m.request_id
    join profiles p on p.id = case when m.driver_id = auth.uid() then m.passenger_id else m.driver_id end
    left join profile_private pp on pp.user_id = p.id
    left join vehicles v on v.user_id = m.driver_id and m.passenger_id = auth.uid()
    left join lateral (select round(avg(x.rating), 1) as rating, count(*)::int as reviews
                         from reviews x where x.target_id = p.id) rv on true
   where auth.uid() in (m.driver_id, m.passenger_id)
   order by m.updated_at desc
   limit 60
$$;

revoke execute on function public.price_for_km(numeric), public.price_margin(integer),
  public._route_for(extensions.geography, extensions.geography, text),
  public._passenger_price(uuid, numeric, integer),
  public.quote_trip(double precision, double precision, double precision, double precision, text)
  from public, anon;
grant execute on function public.quote_trip(double precision, double precision, double precision, double precision, text)
  to authenticated;
-- Le barème n'a rien de secret : il peut être consulté par les personnes connectées.
grant execute on function public.price_for_km(numeric), public.price_margin(integer) to authenticated;
