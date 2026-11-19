-- Trajets et recherches récurrents : un identifiant de série relie toutes les dates publiées ensemble.
alter table public.trips add column series_id uuid;
alter table public.requests add column series_id uuid;
create index trips_series_idx on public.trips (series_id) where series_id is not null;
create index requests_series_idx on public.requests (series_id) where series_id is not null;

-- Rattache des annonces publiées d'un coup à une même série (uniquement les siennes).
create function public.set_series(p_ids uuid[], p_series uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if coalesce(array_length(p_ids, 1), 0) < 2 then return; end if;
  update trips set series_id = p_series where id = any(p_ids) and driver_id = auth.uid();
  update requests set series_id = p_series where id = any(p_ids) and passenger_id = auth.uid();
end $$;
revoke execute on function public.set_series(uuid[], uuid) from public, anon;
grant execute on function public.set_series(uuid[], uuid) to authenticated;

-- Une date modifiée reste dans sa série.
create or replace function public.replace_trip(
  p_trip_id uuid,
  p_origin_label text, p_origin_lng double precision, p_origin_lat double precision,
  p_dest_label   text, p_dest_lng   double precision, p_dest_lat   double precision,
  p_window_start timestamptz, p_window_end timestamptz,
  p_seats integer default 3,
  p_cost_share_cents integer default 0,
  p_route_geojson text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  t     trips;
  v_new uuid;
begin
  select * into t from trips
   where id = p_trip_id and driver_id = auth.uid() and status in ('open', 'paused') for update;
  if not found then raise exception 'Ce trajet ne peut plus être modifié'; end if;
  if exists (select 1 from matches where trip_id = t.id and status = 'accepted') then
    raise exception 'Un passager est déjà confirmé sur ce trajet : il ne peut plus être modifié';
  end if;
  perform cancel_trip(t.id);
  v_new := publish_trip(p_origin_label, p_origin_lng, p_origin_lat, p_dest_label, p_dest_lng, p_dest_lat,
                        p_window_start, p_window_end, p_seats, p_cost_share_cents, p_route_geojson);
  update trips set series_id = t.series_id,
                   status = case when t.status = 'paused' then 'paused'::trip_status else status end
   where id = v_new;
  return v_new;
end $$;

-- Rattrapage des séries déjà publiées : même personne, même trajet, même heure de départ,
-- publiés d'un coup (moins de 5 minutes entre deux publications).
with t as (
  select id, driver_id as who, origin_label, dest_label,
         to_char(window_start at time zone 'Europe/Paris', 'HH24:MI') as hm, created_at
    from trips where series_id is null and status in ('open', 'paused', 'full')
), g as (
  select *, case when created_at - lag(created_at) over w < interval '5 minutes' then 0 else 1 end as brk
    from t window w as (partition by who, origin_label, dest_label, hm order by created_at)
), s as (
  select *, sum(brk) over (partition by who, origin_label, dest_label, hm order by created_at) as grp from g
), k as materialized (
  select who, origin_label, dest_label, hm, grp, gen_random_uuid() as sid
    from s group by who, origin_label, dest_label, hm, grp having count(*) > 1
)
update trips set series_id = k.sid
  from s join k using (who, origin_label, dest_label, hm, grp)
 where trips.id = s.id;

with t as (
  select id, passenger_id as who, origin_label, dest_label,
         to_char(window_start at time zone 'Europe/Paris', 'HH24:MI') as hm, created_at
    from requests where series_id is null and status in ('open', 'matched')
), g as (
  select *, case when created_at - lag(created_at) over w < interval '5 minutes' then 0 else 1 end as brk
    from t window w as (partition by who, origin_label, dest_label, hm order by created_at)
), s as (
  select *, sum(brk) over (partition by who, origin_label, dest_label, hm order by created_at) as grp from g
), k as materialized (
  select who, origin_label, dest_label, hm, grp, gen_random_uuid() as sid
    from s group by who, origin_label, dest_label, hm, grp having count(*) > 1
)
update requests set series_id = k.sid
  from s join k using (who, origin_label, dest_label, hm, grp)
 where requests.id = s.id;
