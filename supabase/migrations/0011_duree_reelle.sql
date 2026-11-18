-- Durée réelle du trajet (fournie par le calcul d'itinéraire) et barème ajusté.

-- Tranche 20-60 km portée à 0,34 €/km : un trajet de 45 km est conseillé à 18 €.
create or replace function public.price_for_km(p_km numeric) returns integer
language sql immutable as $$
  select greatest(250, (round((
           150
           + 40 * least(greatest(p_km, 0), 20)
           + 34 * least(greatest(p_km - 20, 0), 40)
           + 15 * greatest(p_km - 60, 0)
         ) / 50.0) * 50)::int)
$$;

alter table public.trips add column duration_min integer;

-- Le conducteur transmet la durée calculée par l'itinéraire, juste après la publication.
-- Elle n'est retenue que si elle est plausible pour la distance (entre 6 et 130 km/h de moyenne).
create function public.set_trip_duration(p_trip_id uuid, p_minutes integer) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_km numeric;
begin
  select st_length(route) * route_factor / 1000.0 into v_km
    from trips where id = p_trip_id and driver_id = auth.uid();
  if not found then raise exception 'Trajet introuvable'; end if;
  if p_minutes is not null and p_minutes between ceil(v_km / 130 * 60) and ceil(v_km / 6 * 60) + 10 then
    update trips set duration_min = p_minutes where id = p_trip_id;
  end if;
end $$;

-- Durée de la portion du passager : au prorata de la durée réelle quand elle est connue,
-- sinon estimée (28 km/h en ville, jusqu'à 70 km/h sur les longs trajets).
create function public._ride_minutes(p_trip_id uuid, p_shared_km numeric) returns integer
language sql stable security definer set search_path = public, extensions as $$
  select case
           when t.duration_min is not null and st_length(t.route) > 0 then
             greatest(2, ceil(t.duration_min * least(1, p_shared_km * 1000.0 / st_length(t.route))))::int
           else
             greatest(3, ceil(p_shared_km * t.route_factor / (28 + least(p_shared_km * t.route_factor, 60) * 0.7) * 60))::int
         end
    from trips t where t.id = p_trip_id
$$;

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

  insert into matches (trip_id, request_id, driver_id, passenger_id, proposed_by, price_cents, ride_minutes)
  values (p_trip_id, p_request_id, c.driver_id, c.passenger_id, v_uid,
          _passenger_price(p_trip_id, c.shared_km, (select seats from requests where id = p_request_id)),
          _ride_minutes(p_trip_id, c.shared_km))
  on conflict (trip_id, request_id) do nothing
  returning id into v_id;
  if v_id is null then raise exception 'Une proposition existe déjà pour ce trajet'; end if;
  return v_id;
end $$;

-- Recherche côté passager : la durée de sa portion est renvoyée avec le prix.
drop function public.find_trips_for_request(uuid, integer);
create function public.find_trips_for_request(p_request_id uuid, p_radius_m integer default 1000)
returns table (
  trip_id uuid, user_id uuid, driver_name text, rating numeric, reviews integer,
  origin_label text, dest_label text,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric,
  seats_left integer, cost_share_cents integer, ride_minutes integer
)
language sql stable security definer set search_path = public, extensions as $$
  select c.trip_id, p.id, p.display_name, rv.rating, rv.reviews, t.origin_label, t.dest_label,
         c.overlap_start, c.overlap_end, c.pickup_m, c.dropoff_m, c.shared_km,
         c.seats_left, _passenger_price(c.trip_id, c.shared_km, r.seats), _ride_minutes(c.trip_id, c.shared_km)
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

revoke execute on function public.find_trips_for_request(uuid, integer), public.set_trip_duration(uuid, integer),
  public._ride_minutes(uuid, numeric) from public, anon;
grant execute on function public.find_trips_for_request(uuid, integer), public.set_trip_duration(uuid, integer) to authenticated;
