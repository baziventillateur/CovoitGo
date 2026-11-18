-- Durée avec circulation (TomTom), appelée par la fonction serveur « trafic ».
-- La clé TomTom reste côté serveur ; ces deux fonctions ne sont pas appelables depuis l'appli.

alter table public.trips
  add column traffic_delay_min  integer,
  add column traffic_checked_at timestamptz;

-- Compteur journalier, pour rester sous le quota gratuit du fournisseur.
create table public.traffic_calls (
  day   date primary key,
  calls integer not null default 0
);
alter table public.traffic_calls enable row level security;
revoke all on public.traffic_calls from public, anon, authenticated;

-- Réserve un appel : vérifie que le trajet appartient au conducteur, qu'il n'a pas été
-- recalculé dans les 2 dernières minutes et que le plafond du jour n'est pas atteint.
-- Ne renvoie aucune ligne quand l'appel doit être sauté.
create function public.traffic_reserve(p_trip_id uuid, p_user uuid, p_live boolean)
returns table (o_lat double precision, o_lng double precision,
               d_lat double precision, d_lng double precision, depart_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  t trips;
begin
  select * into t from trips
   where id = p_trip_id and driver_id = p_user and status in ('open', 'full') for update;
  if not found then raise exception 'Trajet introuvable'; end if;
  if t.traffic_checked_at > now() - interval '2 minutes' then return; end if;

  insert into traffic_calls as c (day, calls) values (current_date, 1)
  on conflict (day) do update set calls = c.calls + 1 where c.calls < 2000;
  if not found then return; end if;

  update trips set traffic_checked_at = now() where id = t.id;
  return query select
    st_y(t.origin::geometry), st_x(t.origin::geometry),
    st_y(t.destination::geometry), st_x(t.destination::geometry),
    -- Départ plus tard : circulation habituelle à cette heure-là ; sinon circulation du moment.
    case when not p_live and t.window_start > now() + interval '10 minutes' then t.window_start end;
end $$;

-- Enregistre la durée avec circulation (si plausible) et recale la durée des portions passagers.
create function public.traffic_apply(p_trip_id uuid, p_minutes integer, p_delay_min integer)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_km  numeric;
  v_old integer;
begin
  select st_length(route) * route_factor / 1000.0, duration_min into v_km, v_old
    from trips where id = p_trip_id for update;
  if not found or p_minutes is null
     or p_minutes not between ceil(v_km / 130 * 60) and ceil(v_km / 6 * 60) + 10 then
    return false;
  end if;
  update trips set duration_min = p_minutes,
                   traffic_delay_min = greatest(0, least(coalesce(p_delay_min, 0), p_minutes))
   where id = p_trip_id;
  if v_old > 0 then
    update matches set ride_minutes = greatest(2, round(ride_minutes * p_minutes::numeric / v_old))::int
     where trip_id = p_trip_id and status in ('proposed', 'accepted') and ride_minutes is not null;
  end if;
  return true;
end $$;

revoke execute on function public.traffic_reserve(uuid, uuid, boolean),
  public.traffic_apply(uuid, integer, integer) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.traffic_reserve(uuid, uuid, boolean),
      public.traffic_apply(uuid, integer, integer) to service_role;
    grant all on public.traffic_calls to service_role;
  end if;
end $$;
