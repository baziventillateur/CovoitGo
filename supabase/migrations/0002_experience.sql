-- =====================================================================
-- Expérience v2 : notifications (cloche), étapes de trajet en direct,
-- téléphone visible uniquement après acceptation, anti-doublons.
-- =====================================================================

-- ---------- Téléphone : donnée privée, table à part --------------------
create table public.profile_private (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  phone   text not null check (phone ~ '^\+?[0-9]{8,15}$')
);
alter table public.profile_private enable row level security;
revoke all on public.profile_private from anon, authenticated;
grant select on public.profile_private to authenticated;
-- Lecture directe : uniquement son propre numéro. Celui de l'autre personne
-- n'est renvoyé que par my_matches(), et seulement pour un trajet accepté.
create policy profile_private_self on public.profile_private for select to authenticated
  using (user_id = (select auth.uid()));

create function public._clean_phone(p_phone text) returns text
language sql immutable as $$
  select regexp_replace(coalesce(p_phone, ''), '[\s.\-()]', '', 'g')
$$;

create function public.set_phone(p_phone text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_phone text := _clean_phone(p_phone);
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'Numéro de téléphone invalide'; end if;
  insert into profile_private (user_id, phone) values (auth.uid(), v_phone)
  on conflict (user_id) do update set phone = excluded.phone;
end $$;

-- L'inscription peut fournir le téléphone dans les métadonnées.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_name  text := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  v_phone text := _clean_phone(new.raw_user_meta_data ->> 'phone');
begin
  if char_length(v_name) < 2 then v_name := 'Utilisateur'; end if;
  insert into public.profiles (id, display_name) values (new.id, left(v_name, 40));
  if v_phone ~ '^\+?[0-9]{8,15}$' then
    insert into public.profile_private (user_id, phone) values (new.id, v_phone);
  end if;
  return new;
end $$;

-- ---------- Étapes d'un trajet accepté ---------------------------------
create type public.match_stage as enum ('scheduled', 'driver_en_route', 'driver_arrived', 'on_board');
alter table public.matches add column stage public.match_stage not null default 'scheduled';

-- L'ancienne double confirmation est remplacée par les étapes.
drop function public.confirm_match(uuid);

-- Conducteur : je pars -> je suis arrivé -> (le passager monte) -> trajet terminé.
-- Passager  : je suis à bord. Les deux personnes interviennent, donc les points
-- ne peuvent pas être obtenus par une seule.
create function public.advance_match(p_match_id uuid) returns text
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

  select greatest(t.window_start, r.window_start) into v_meet
    from trips t, requests r where t.id = m.trip_id and r.id = m.request_id;

  if v_uid = m.driver_id then
    if m.stage = 'scheduled' then
      if now() < v_meet - interval '1 hour' then
        raise exception 'Tu pourras démarrer une heure avant le rendez-vous';
      end if;
      update matches set stage = 'driver_en_route', updated_at = now() where id = m.id;
      return 'driver_en_route';
    elsif m.stage = 'driver_en_route' then
      update matches set stage = 'driver_arrived', updated_at = now() where id = m.id;
      return 'driver_arrived';
    elsif m.stage = 'driver_arrived' then
      raise exception 'En attente : ton passager doit confirmer qu''il est à bord';
    else
      update matches set status = 'completed', driver_confirmed = true, updated_at = now() where id = m.id;
      update requests set status = 'done' where id = m.request_id;
      perform _award_trip_points(m.driver_id, 15, m.id);
      perform _award_trip_points(m.passenger_id, 10, m.id);
      return 'completed';
    end if;
  end if;

  -- Passager
  if m.stage in ('driver_en_route', 'driver_arrived') then
    update matches set stage = 'on_board', passenger_confirmed = true, updated_at = now() where id = m.id;
    return 'on_board';
  elsif m.stage = 'scheduled' then
    raise exception 'Ton chauffeur n''est pas encore parti';
  end if;
  raise exception 'C''est au chauffeur de terminer le trajet';
end $$;

-- ---------- Notifications (cloche) -------------------------------------
create table public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('driver', 'passenger')),  -- mode concerné chez le destinataire
  kind       text not null,
  title      text not null,
  body       text not null default '',
  match_id   uuid references public.matches (id) on delete cascade,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
create policy notifications_read on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

create function public.mark_notifications_read() returns void
language sql security definer set search_path = public, extensions as $$
  update notifications set read_at = now() where user_id = auth.uid() and read_at is null
$$;

-- Une notification part à chaque évènement d'une mise en relation.
create function public._notify_match() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor   uuid := auth.uid();
  v_driver  text;
  v_pass    text;
  v_route   text;
  v_meet    text;
  v_to_driver boolean := false;
  v_to_pass   boolean := false;
  v_kind    text;
  v_title_d text;  -- titre vu par le conducteur
  v_title_p text;  -- titre vu par le passager
  v_body    text;
begin
  select display_name into v_driver from profiles where id = new.driver_id;
  select display_name into v_pass   from profiles where id = new.passenger_id;
  select r.origin_label || ' → ' || r.dest_label,
         to_char(greatest(t.window_start, r.window_start) at time zone 'Europe/Paris', 'DD/MM "à" HH24"h"MI')
    into v_route, v_meet
    from trips t, requests r where t.id = new.trip_id and r.id = new.request_id;
  v_body := v_route || ' · ' || v_meet;

  if tg_op = 'INSERT' then
    v_kind := 'proposal';
    if new.proposed_by = new.driver_id then
      v_to_pass := true;   v_title_p := v_driver || ' te propose une place';
    else
      v_to_driver := true; v_title_d := v_pass || ' demande une place';
    end if;

  elsif new.status is distinct from old.status then
    if new.status = 'accepted' then
      v_kind := 'accepted'; v_to_driver := true; v_to_pass := true;
      v_title_d := 'Trajet confirmé avec ' || v_pass;
      v_title_p := 'Trajet confirmé avec ' || v_driver;
      v_body := v_route || ' · rendez-vous le ' || v_meet;
    elsif new.status = 'declined' then
      v_kind := 'declined';
      v_to_driver := new.proposed_by = new.driver_id;
      v_to_pass   := not v_to_driver;
      v_title_d := v_pass || ' a décliné ta proposition';
      v_title_p := v_driver || ' a décliné ta demande';
    elsif new.status = 'cancelled' and old.status in ('proposed', 'accepted') then
      v_kind := 'cancelled';
      -- On prévient la personne qui n'est pas à l'origine de l'annulation.
      v_to_driver := v_actor is distinct from new.driver_id;
      v_to_pass   := v_actor is distinct from new.passenger_id and v_actor = new.driver_id;
      if v_actor is null then v_to_driver := true; v_to_pass := true; end if;
      v_title_d := case when old.status = 'accepted' then 'Trajet annulé par ' || v_pass else 'Proposition annulée' end;
      v_title_p := case when old.status = 'accepted' then 'Trajet annulé par ' || v_driver else 'Proposition annulée' end;
    elsif new.status = 'completed' then
      v_kind := 'completed'; v_to_driver := true; v_to_pass := true;
      v_title_d := 'Trajet terminé, bravo !';
      v_title_p := 'Trajet terminé, bravo !';
      v_body := v_route || ' · tes points sont crédités';
    end if;

  elsif new.stage is distinct from old.stage then
    v_kind := 'stage';
    if new.stage = 'driver_en_route' then
      v_to_pass := true;   v_title_p := v_driver || ' est en route vers toi';
    elsif new.stage = 'driver_arrived' then
      v_to_pass := true;   v_title_p := v_driver || ' est arrivé au point de rendez-vous';
    elsif new.stage = 'on_board' then
      v_to_driver := true; v_title_d := v_pass || ' est à bord';
    end if;
    v_body := v_route;
  end if;

  if v_to_driver then
    insert into notifications (user_id, role, kind, title, body, match_id)
    values (new.driver_id, 'driver', v_kind, v_title_d, v_body, new.id);
  end if;
  if v_to_pass then
    insert into notifications (user_id, role, kind, title, body, match_id)
    values (new.passenger_id, 'passenger', v_kind, v_title_p, v_body, new.id);
  end if;
  return new;
end $$;

create trigger matches_notify
  after insert or update of status, stage on public.matches
  for each row execute function public._notify_match();

-- Temps réel pour la cloche (la publication n'existe que sur Supabase).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- ---------- Anti-doublons ----------------------------------------------
create function public._no_duplicate_trip() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from trips t
              where t.driver_id = new.driver_id and t.status in ('open', 'full')
                and t.window_start < new.window_end and new.window_start < t.window_end
                and st_dwithin(t.origin, new.origin, 300)
                and st_dwithin(t.destination, new.destination, 300)) then
    raise exception 'Tu as déjà publié ce trajet sur ce créneau';
  end if;
  return new;
end $$;
create trigger trips_no_duplicate before insert on public.trips
  for each row execute function public._no_duplicate_trip();

create function public._no_duplicate_request() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from requests r
              where r.passenger_id = new.passenger_id and r.status in ('open', 'matched')
                and r.window_start < new.window_end and new.window_start < r.window_end
                and st_dwithin(r.origin, new.origin, 300)
                and st_dwithin(r.destination, new.destination, 300)) then
    raise exception 'Tu as déjà une recherche en cours pour ce trajet';
  end if;
  return new;
end $$;
create trigger requests_no_duplicate before insert on public.requests
  for each row execute function public._no_duplicate_request();

-- ---------- Vue d'ensemble de mes mises en relation --------------------
-- Renvoie le prénom de l'autre personne, et son téléphone UNIQUEMENT
-- tant que le trajet est accepté (ni avant, ni après).
create function public.my_matches()
returns table (
  id uuid, trip_id uuid, request_id uuid, role text, status text, stage text,
  proposed_by_me boolean, other_name text, other_phone text,
  pickup_label text, dropoff_label text, trip_origin_label text, trip_dest_label text,
  meet_at timestamptz, cost_share_cents integer, updated_at timestamptz
)
language sql stable security definer set search_path = public, extensions as $$
  select m.id, m.trip_id, m.request_id,
         case when m.driver_id = auth.uid() then 'driver' else 'passenger' end,
         m.status::text, m.stage::text, m.proposed_by = auth.uid(),
         p.display_name,
         case when m.status = 'accepted' then pp.phone end,
         r.origin_label, r.dest_label, t.origin_label, t.dest_label,
         greatest(t.window_start, r.window_start), t.cost_share_cents, m.updated_at
    from matches m
    join trips t on t.id = m.trip_id
    join requests r on r.id = m.request_id
    join profiles p on p.id = case when m.driver_id = auth.uid() then m.passenger_id else m.driver_id end
    left join profile_private pp on pp.user_id = p.id
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
  public.my_matches()
to authenticated;
