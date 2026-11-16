-- =====================================================================
-- Avis (1 à 5 étoiles + commentaire facultatif) et parcours simplifié :
-- le conducteur fait avancer le trajet seul, plus d'étape « à bord ».
-- =====================================================================

-- ---------- Parcours : conducteur uniquement ---------------------------
create or replace function public.advance_match(p_match_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid  uuid := auth.uid();
  m      matches;
  v_meet timestamptz;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or v_uid is null or v_uid not in (m.driver_id, m.passenger_id) then
    raise exception 'Trajet introuvable';
  end if;
  if m.status <> 'accepted' then raise exception 'Ce trajet n''est pas en cours'; end if;
  if v_uid <> m.driver_id then raise exception 'C''est le chauffeur qui fait avancer le trajet'; end if;

  if m.stage = 'scheduled' then
    select greatest(t.window_start, r.window_start) into v_meet
      from trips t, requests r where t.id = m.trip_id and r.id = m.request_id;
    if now() < v_meet - interval '1 hour' then
      raise exception 'Tu pourras démarrer une heure avant le rendez-vous';
    end if;
    update matches set stage = 'driver_en_route', updated_at = now() where id = m.id;
    return 'driver_en_route';
  elsif m.stage = 'driver_en_route' then
    update matches set stage = 'driver_arrived', updated_at = now() where id = m.id;
    return 'driver_arrived';
  end if;

  update matches set status = 'completed', driver_confirmed = true, updated_at = now() where id = m.id;
  update requests set status = 'done' where id = m.request_id;
  perform _award_trip_points(m.driver_id, 15, m.id);
  perform _award_trip_points(m.passenger_id, 10, m.id);
  return 'completed';
end $$;

-- ---------- Avis --------------------------------------------------------
create table public.reviews (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references public.matches (id) on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete cascade,
  target_id  uuid not null references public.profiles (id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  comment    text check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  unique (match_id, author_id),
  check (author_id <> target_id)
);
create index reviews_target_idx on public.reviews (target_id, created_at desc);
alter table public.reviews enable row level security;
revoke all on public.reviews from anon, authenticated;
grant select on public.reviews to authenticated;
-- Les avis sont publics pour les personnes connectées ; l'écriture passe par submit_review.
create policy reviews_read on public.reviews for select to authenticated using (true);

create function public.submit_review(p_match_id uuid, p_rating integer, p_comment text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid     uuid := auth.uid();
  m         matches;
  v_target  uuid;
  v_name    text;
  v_comment text := nullif(trim(left(coalesce(p_comment, ''), 500)), '');
begin
  select * into m from matches where id = p_match_id;
  if not found or v_uid is null or v_uid not in (m.driver_id, m.passenger_id) then
    raise exception 'Trajet introuvable';
  end if;
  if m.status <> 'completed' then raise exception 'Tu pourras noter une fois le trajet terminé'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'La note va de 1 à 5 étoiles'; end if;
  v_target := case when v_uid = m.driver_id then m.passenger_id else m.driver_id end;

  begin
    insert into reviews (match_id, author_id, target_id, rating, comment)
    values (m.id, v_uid, v_target, p_rating, v_comment);
  exception when unique_violation then
    raise exception 'Tu as déjà donné ton avis sur ce trajet';
  end;

  select display_name into v_name from profiles where id = v_uid;
  insert into notifications (user_id, role, kind, title, body, match_id)
  values (
    v_target,
    case when v_target = m.driver_id then 'driver' else 'passenger' end,
    'review',
    v_name || ' t''a laissé un avis',
    repeat('★', p_rating) || repeat('☆', 5 - p_rating) ||
      case when exists (select 1 from reviews where match_id = m.id and author_id = v_target)
           then '' else ' · À ton tour de donner ton avis' end,
    m.id
  );
end $$;

-- ---------- Fonctions de lecture enrichies (note moyenne, avis) ---------
drop function public.my_matches();
create function public.my_matches()
returns table (
  id uuid, trip_id uuid, request_id uuid, role text, status text, stage text,
  proposed_by_me boolean, other_id uuid, other_name text, other_phone text,
  other_rating numeric, other_reviews integer, reviewed_by_me boolean,
  pickup_label text, dropoff_label text, trip_origin_label text, trip_dest_label text,
  meet_at timestamptz, cost_share_cents integer, updated_at timestamptz
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
         greatest(t.window_start, r.window_start), t.cost_share_cents, m.updated_at
    from matches m
    join trips t on t.id = m.trip_id
    join requests r on r.id = m.request_id
    join profiles p on p.id = case when m.driver_id = auth.uid() then m.passenger_id else m.driver_id end
    left join profile_private pp on pp.user_id = p.id
    left join lateral (select round(avg(x.rating), 1) as rating, count(*)::int as reviews
                         from reviews x where x.target_id = p.id) rv on true
   where auth.uid() in (m.driver_id, m.passenger_id)
   order by m.updated_at desc
   limit 60
$$;

drop function public.find_trips_for_request(uuid, integer);
create function public.find_trips_for_request(p_request_id uuid, p_radius_m integer default 1000)
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
         c.seats_left, t.cost_share_cents
    from _match_candidates(p_radius_m, null, p_request_id) c
    join trips t on t.id = c.trip_id
    join profiles p on p.id = c.driver_id
    left join lateral (select round(avg(x.rating), 1) as rating, count(*)::int as reviews
                         from reviews x where x.target_id = p.id) rv on true
   where c.request_id = p_request_id
     and c.passenger_id = auth.uid()
   order by c.pickup_m + c.dropoff_m, c.overlap_start
   limit 30
$$;

drop function public.find_requests_for_trip(uuid, integer);
create function public.find_requests_for_trip(p_trip_id uuid, p_radius_m integer default 1000)
returns table (
  request_id uuid, user_id uuid, passenger_name text, rating numeric, reviews integer,
  origin_label text, dest_label text,
  overlap_start timestamptz, overlap_end timestamptz,
  pickup_m integer, dropoff_m integer, shared_km numeric
)
language sql stable security definer set search_path = public, extensions as $$
  select c.request_id, p.id, p.display_name, rv.rating, rv.reviews, r.origin_label, r.dest_label,
         c.overlap_start, c.overlap_end, c.pickup_m, c.dropoff_m, c.shared_km
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

-- ---------- Droits ------------------------------------------------------
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
  public.advance_match(uuid),
  public.cancel_trip(uuid),
  public.cancel_request(uuid),
  public.set_phone(text),
  public.mark_notifications_read(),
  public.my_matches(),
  public.submit_review(uuid, integer, text)
to authenticated;
