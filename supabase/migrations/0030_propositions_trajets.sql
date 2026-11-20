-- Une proposition = ce qui a été publié d'un coup : un aller seul, ou un aller-retour (récurrent ou non).
-- round_id relie l'aller et le retour ; is_return marque le retour. L'historique des trajets réalisés
-- a sa propre lecture, et les actions « toute la proposition » portent sur une liste de dates.

alter table public.trips    add column round_id uuid, add column is_return boolean not null default false;
alter table public.requests add column round_id uuid, add column is_return boolean not null default false;
create index trips_round_idx    on public.trips (round_id)    where round_id is not null;
create index requests_round_idx on public.requests (round_id) where round_id is not null;

-- Rattache les dates d'un aller-retour publié d'un coup (uniquement les siennes).
create function public.set_round(p_ids uuid[], p_round uuid, p_return_ids uuid[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if coalesce(array_length(p_ids, 1), 0) < 2 then return; end if;
  update trips set round_id = p_round, is_return = (id = any(coalesce(p_return_ids, '{}')))
   where id = any(p_ids) and driver_id = auth.uid();
  update requests set round_id = p_round, is_return = (id = any(coalesce(p_return_ids, '{}')))
   where id = any(p_ids) and passenger_id = auth.uid();
end $$;
revoke execute on function public.set_round(uuid[], uuid, uuid[]) from public, anon;
grant execute on function public.set_round(uuid[], uuid, uuid[]) to authenticated;

-- Une date modifiée reste dans sa série et dans son aller-retour.
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
  update trips set series_id = t.series_id, round_id = t.round_id, is_return = t.is_return,
                   status = case when t.status = 'paused' then 'paused'::trip_status else status end
   where id = v_new;
  return v_new;
end $$;

-- Actions sur plusieurs dates d'un coup (toute une proposition). Comme pour une série : les dates
-- passées et celles qui ont un passager confirmé ne sont jamais touchées.
create function public.listings_action(p_ids uuid[], p_action text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id   uuid;
  v_done integer := 0;
  v_kept integer := 0;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_action not in ('pause', 'resume', 'cancel', 'cancel_requests') then raise exception 'Action inconnue'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 400 then raise exception 'Trop de dates d''un coup'; end if;

  if p_action = 'cancel_requests' then
    for v_id in select r.id from requests r
                 where r.id = any(p_ids) and r.passenger_id = auth.uid()
                   and r.status in ('open', 'matched') and r.window_end > now() loop
      if exists (select 1 from matches m where m.request_id = v_id and m.status = 'accepted') then
        v_kept := v_kept + 1;
      else
        perform cancel_request(v_id);
        v_done := v_done + 1;
      end if;
    end loop;
    return jsonb_build_object('done', v_done, 'kept', v_kept);
  end if;

  for v_id in select t.id from trips t
               where t.id = any(p_ids) and t.driver_id = auth.uid() and t.window_end > now()
                 and t.status = case p_action when 'pause' then 'open'::trip_status
                                              when 'resume' then 'paused'::trip_status
                                              else t.status end
                 and t.status in ('open', 'paused') loop
    if p_action <> 'resume' and exists (select 1 from matches m where m.trip_id = v_id and m.status = 'accepted') then
      v_kept := v_kept + 1;
      continue;
    end if;
    if p_action = 'pause' then perform pause_trip(v_id);
    elsif p_action = 'resume' then perform resume_trip(v_id);
    else perform cancel_trip(v_id);
    end if;
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('done', v_done, 'kept', v_kept);
end $$;
revoke execute on function public.listings_action(uuid[], text) from public, anon;
grant execute on function public.listings_action(uuid[], text) to authenticated;

-- Mes trajets réalisés, les plus récents d'abord. Conducteur : un trajet avec tous ses passagers et ce
-- qu'il lui reste (prix moins les frais de service) ; passager : chaque trajet et ce qu'il a payé.
create function public.my_history(p_role text, p_limit integer default 200)
returns table (listing_id uuid, origin_label text, dest_label text, depart_at timestamptz, done_at timestamptz,
               people jsonb, cents integer)
language sql stable security definer set search_path = public, extensions as $$
  select * from (
    select t.id, t.origin_label, t.dest_label, min(greatest(t.window_start, r.window_start)), max(m.updated_at),
           jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by m.updated_at),
           sum(coalesce(m.price_cents, t.cost_share_cents) - coalesce(m.fee_cents, 0))::int
      from matches m
      join trips t on t.id = m.trip_id
      join requests r on r.id = m.request_id
      join profiles p on p.id = m.passenger_id
     where p_role = 'driver' and m.driver_id = auth.uid() and m.status = 'completed'
     group by t.id
    union all
    select r.id, r.origin_label, r.dest_label, greatest(t.window_start, r.window_start), m.updated_at,
           jsonb_build_array(jsonb_build_object('id', p.id, 'name', p.display_name)),
           coalesce(m.price_cents, t.cost_share_cents)::int
      from matches m
      join trips t on t.id = m.trip_id
      join requests r on r.id = m.request_id
      join profiles p on p.id = m.driver_id
     where p_role = 'passenger' and m.passenger_id = auth.uid() and m.status = 'completed'
  ) h
  order by 5 desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;
revoke execute on function public.my_history(text, integer) from public, anon;
grant execute on function public.my_history(text, integer) to authenticated;

-- Rattrapage : un aller et un retour publiés d'un coup (même personne, trajet inversé, publiés à moins
-- de 2 minutes d'écart) forment un aller-retour. Une série compte comme un seul bloc.
do $$
declare
  k record;
  v uuid;
begin
  for k in
    with u as (
      select coalesce(series_id::text, id::text) as unit, driver_id as who, origin_label o, dest_label d,
             min(created_at) c, min(window_start) w, array_agg(id) ids
        from trips where round_id is null and status <> 'cancelled'
       group by 1, 2, 3, 4
    ), pairs as (
      select distinct on (a.unit) a.unit ua, b.unit ub, a.ids ida, b.ids idb
        from u a join u b on a.who = b.who and a.o = b.d and a.d = b.o and a.unit <> b.unit
             and b.c between a.c - interval '2 minutes' and a.c + interval '2 minutes' and a.w < b.w
       order by a.unit, abs(extract(epoch from b.c - a.c))
    )
    select distinct on (ub) * from pairs order by ub
  loop
    v := gen_random_uuid();
    update trips set round_id = v, is_return = (id = any(k.idb))
     where id = any(k.ida || k.idb) and round_id is null;
  end loop;

  for k in
    with u as (
      select coalesce(series_id::text, id::text) as unit, passenger_id as who, origin_label o, dest_label d,
             min(created_at) c, min(window_start) w, array_agg(id) ids
        from requests where round_id is null and status <> 'cancelled'
       group by 1, 2, 3, 4
    ), pairs as (
      select distinct on (a.unit) a.unit ua, b.unit ub, a.ids ida, b.ids idb
        from u a join u b on a.who = b.who and a.o = b.d and a.d = b.o and a.unit <> b.unit
             and b.c between a.c - interval '2 minutes' and a.c + interval '2 minutes' and a.w < b.w
       order by a.unit, abs(extract(epoch from b.c - a.c))
    )
    select distinct on (ub) * from pairs order by ub
  loop
    v := gen_random_uuid();
    update requests set round_id = v, is_return = (id = any(k.idb))
     where id = any(k.ida || k.idb) and round_id is null;
  end loop;
end $$;
