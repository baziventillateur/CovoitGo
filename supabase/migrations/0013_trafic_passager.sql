-- Recherche côté passager : retard dû à la circulation sur sa portion (au prorata), quand il est connu.
drop function public.find_trips_for_request(uuid, integer);
create function public.find_trips_for_request(p_request_id uuid, p_radius_m integer default 1000)
returns table (
  trip_id uuid, user_id uuid, driver_name text, rating numeric, reviews integer,
  origin_label text, dest_label text,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric,
  seats_left integer, cost_share_cents integer, ride_minutes integer, traffic_delay_min integer
)
language sql stable security definer set search_path = public, extensions as $$
  select c.trip_id, p.id, p.display_name, rv.rating, rv.reviews, t.origin_label, t.dest_label,
         c.overlap_start, c.overlap_end, c.pickup_m, c.dropoff_m, c.shared_km,
         c.seats_left, _passenger_price(c.trip_id, c.shared_km, r.seats), rm.minutes,
         case when t.traffic_delay_min is not null and t.duration_min > 0
              then round(t.traffic_delay_min * least(1, rm.minutes::numeric / t.duration_min))::int end
    from _match_candidates(p_radius_m, null, p_request_id) c
    join trips t on t.id = c.trip_id
    join requests r on r.id = c.request_id
    join profiles p on p.id = c.driver_id
    cross join lateral (select _ride_minutes(c.trip_id, c.shared_km) as minutes) rm
    left join lateral (select round(avg(x.rating), 1) as rating, count(*)::int as reviews
                         from reviews x where x.target_id = p.id) rv on true
   where c.request_id = p_request_id
     and c.passenger_id = auth.uid()
   order by c.pickup_m + c.dropoff_m, c.overlap_start
   limit 30
$$;
revoke execute on function public.find_trips_for_request(uuid, integer) from public, anon;
grant execute on function public.find_trips_for_request(uuid, integer) to authenticated;
