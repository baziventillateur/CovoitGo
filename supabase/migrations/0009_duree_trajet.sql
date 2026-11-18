-- Durée estimée du trajet du passager, figée à la mise en relation.
-- Sert à faire avancer la petite voiture au prorata du temps (sans GPS).
alter table public.matches add column ride_minutes integer;

create or replace function public.propose_match(p_trip_id uuid, p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  c     record;
  v_km  numeric;
  v_id  uuid;
begin
  if v_uid is null then raise exception 'Connexion requise'; end if;
  select * into c from _match_candidates(3000, p_trip_id, p_request_id) m;
  if not found then raise exception 'Trajet et demande non compatibles'; end if;
  if v_uid not in (c.driver_id, c.passenger_id) then raise exception 'Action non autorisée'; end if;

  select c.shared_km * t.route_factor into v_km from trips t where t.id = p_trip_id;

  insert into matches (trip_id, request_id, driver_id, passenger_id, proposed_by, price_cents, ride_minutes)
  values (p_trip_id, p_request_id, c.driver_id, c.passenger_id, v_uid,
          _passenger_price(p_trip_id, c.shared_km, (select seats from requests where id = p_request_id)),
          -- Vitesse moyenne supposée : 28 km/h en ville, jusqu'à 70 km/h sur les longs trajets.
          greatest(3, ceil(v_km / (28 + least(v_km, 60) * 0.7) * 60))::int)
  on conflict (trip_id, request_id) do nothing
  returning id into v_id;
  if v_id is null then raise exception 'Une proposition existe déjà pour ce trajet'; end if;
  return v_id;
end $$;
