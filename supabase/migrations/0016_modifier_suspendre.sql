-- Suspendre / reprendre / modifier un trajet publié.

-- Suspendre : le trajet n'est plus proposé à personne ; les propositions restées sans réponse tombent.
create function public.pause_trip(p_trip_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update trips set status = 'paused'
   where id = p_trip_id and driver_id = auth.uid() and status = 'open';
  if not found then raise exception 'Ce trajet ne peut pas être suspendu'; end if;
  update matches set status = 'cancelled', updated_at = now()
   where trip_id = p_trip_id and status = 'proposed';
end $$;

create function public.resume_trip(p_trip_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  t trips;
begin
  select * into t from trips
   where id = p_trip_id and driver_id = auth.uid() and status = 'paused' for update;
  if not found then raise exception 'Trajet introuvable'; end if;
  if t.window_end <= now() then raise exception 'Le créneau de ce trajet est passé'; end if;
  update trips set status = (case
           when t.seats_taken >= t.seats
             or exists (select 1 from matches m where m.trip_id = t.id and m.status = 'accepted' and m.stage <> 'scheduled')
           then 'full' else 'open' end)::trip_status
   where id = t.id;
end $$;

-- Supprimer : vaut aussi pour un trajet suspendu.
create or replace function public.cancel_trip(p_trip_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update trips set status = 'cancelled'
   where id = p_trip_id and driver_id = auth.uid() and status in ('open', 'full', 'paused');
  if not found then raise exception 'Trajet introuvable'; end if;
  update requests set status = 'open'
   where status = 'matched'
     and id in (select request_id from matches where trip_id = p_trip_id and status = 'accepted');
  update matches set status = 'cancelled', updated_at = now()
   where trip_id = p_trip_id and status in ('proposed', 'accepted');
end $$;

-- Un trajet suspendu compte aussi comme « déjà publié » sur son créneau.
create or replace function public._no_duplicate_trip() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from trips t
              where t.driver_id = new.driver_id and t.status in ('open', 'full', 'paused')
                and t.window_start < new.window_end and new.window_start < t.window_end
                and st_dwithin(t.origin, new.origin, 300)
                and st_dwithin(t.destination, new.destination, 300)) then
    raise exception 'Tu as déjà publié ce trajet sur ce créneau';
  end if;
  return new;
end $$;

-- Données du trajet pour pré-remplir le formulaire de modification.
create function public.trip_for_edit(p_trip_id uuid)
returns table (origin_label text, origin_lng double precision, origin_lat double precision,
               dest_label text, dest_lng double precision, dest_lat double precision,
               window_start timestamptz, window_end timestamptz, seats integer, cost_share_cents integer)
language sql stable security definer set search_path = public, extensions as $$
  select t.origin_label, st_x(t.origin::geometry), st_y(t.origin::geometry),
         t.dest_label, st_x(t.destination::geometry), st_y(t.destination::geometry),
         t.window_start, t.window_end, t.seats::int, t.cost_share_cents
    from trips t where t.id = p_trip_id and t.driver_id = auth.uid()
$$;

-- Modifier : possible tant qu'aucun passager n'est confirmé. Le trajet est republié avec les
-- nouvelles valeurs (mêmes contrôles qu'à la publication) ; les propositions en attente sont annulées.
create function public.replace_trip(
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
  if t.status = 'paused' then update trips set status = 'paused' where id = v_new; end if;
  return v_new;
end $$;

revoke execute on function public.pause_trip(uuid), public.resume_trip(uuid), public.trip_for_edit(uuid),
  public.replace_trip(uuid, text, double precision, double precision, text, double precision, double precision,
                      timestamptz, timestamptz, integer, integer, text) from public, anon;
grant execute on function public.pause_trip(uuid), public.resume_trip(uuid), public.trip_for_edit(uuid),
  public.replace_trip(uuid, text, double precision, double precision, text, double precision, double precision,
                      timestamptz, timestamptz, integer, integer, text) to authenticated;
