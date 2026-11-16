-- =====================================================================
-- Un trajet parti n'est plus proposé à personne, un trajet terminé est clos.
-- Assistance : réclamation liée à un trajet accepté ou terminé.
-- =====================================================================

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
    -- Le conducteur est parti : le trajet n'est plus proposé, les demandes restées sans réponse tombent.
    update trips set status = 'full' where id = m.trip_id and status = 'open';
    update matches set status = 'cancelled', updated_at = now()
     where trip_id = m.trip_id and status = 'proposed';
    return 'driver_en_route';
  elsif m.stage = 'driver_en_route' then
    update matches set stage = 'driver_arrived', updated_at = now() where id = m.id;
    return 'driver_arrived';
  end if;

  update matches set status = 'completed', driver_confirmed = true, updated_at = now() where id = m.id;
  update requests set status = 'done' where id = m.request_id;
  -- Plus aucun passager à déposer : le trajet est clos.
  update trips set status = 'done'
   where id = m.trip_id
     and not exists (select 1 from matches x where x.trip_id = m.trip_id and x.status = 'accepted');
  perform _award_trip_points(m.driver_id, 15, m.id);
  perform _award_trip_points(m.passenger_id, 10, m.id);
  return 'completed';
end $$;

-- Annuler après le départ ne remet pas le trajet en recherche de passagers.
create or replace function public.cancel_match(p_match_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  m     matches;
  v_departed boolean;
begin
  select * into m from matches where id = p_match_id for update;
  if not found or v_uid is null or v_uid not in (m.driver_id, m.passenger_id) then
    raise exception 'Proposition introuvable';
  end if;
  if m.status not in ('proposed', 'accepted') then raise exception 'Annulation impossible'; end if;

  if m.status = 'accepted' then
    select exists (select 1 from matches x where x.trip_id = m.trip_id and x.status = 'accepted' and x.stage <> 'scheduled')
      into v_departed;
    update trips set seats_taken = greatest(seats_taken - (select seats from requests where id = m.request_id), 0),
                     status = case when status = 'full' and not v_departed then 'open' else status end
     where id = m.trip_id;
    update requests set status = 'open' where id = m.request_id and status = 'matched';
  end if;
  update matches set status = 'cancelled', updated_at = now() where id = m.id;
end $$;

create or replace function public.cancel_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
  r requests;
begin
  select * into r from requests
   where id = p_request_id and passenger_id = auth.uid() and status in ('open', 'matched') for update;
  if not found then raise exception 'Demande introuvable'; end if;
  for m in select * from matches where request_id = p_request_id and status = 'accepted' loop
    update trips t set seats_taken = greatest(seats_taken - r.seats, 0),
                       status = case when status = 'full' and not exists (
                                       select 1 from matches x
                                        where x.trip_id = t.id and x.status = 'accepted' and x.stage <> 'scheduled')
                                     then 'open' else status end
     where t.id = m.trip_id;
  end loop;
  update matches set status = 'cancelled', updated_at = now()
   where request_id = p_request_id and status in ('proposed', 'accepted');
  update requests set status = 'cancelled' where id = p_request_id;
end $$;

-- Rattrapage : les trajets déjà terminés avant cette mise à jour sont clos.
update public.trips t set status = 'done'
 where t.status in ('open', 'full')
   and exists (select 1 from public.matches x where x.trip_id = t.id and x.status = 'completed')
   and not exists (select 1 from public.matches x where x.trip_id = t.id and x.status in ('proposed', 'accepted'));

-- ---------- Assistance : réclamations -----------------------------------
create table public.claims (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references public.matches (id) on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete cascade,
  category   text not null check (category in ('retard', 'absence', 'comportement', 'securite', 'autre')),
  message    text not null check (char_length(message) between 5 and 1000),
  status     text not null default 'ouverte' check (status in ('ouverte', 'traitee')),
  created_at timestamptz not null default now()
);
create index claims_author_idx on public.claims (author_id, created_at desc);
alter table public.claims enable row level security;
revoke all on public.claims from anon, authenticated;
grant select on public.claims to authenticated;
-- Chacun ne voit que ses propres réclamations ; l'autre personne du trajet ne les voit pas.
create policy claims_self on public.claims for select to authenticated
  using (author_id = (select auth.uid()));

create function public.submit_claim(p_match_id uuid, p_category text, p_message text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  m     matches;
  v_msg text := trim(coalesce(p_message, ''));
begin
  select * into m from matches where id = p_match_id;
  if not found or v_uid is null or v_uid not in (m.driver_id, m.passenger_id) then
    raise exception 'Trajet introuvable';
  end if;
  if m.status not in ('accepted', 'completed') then
    raise exception 'L''assistance est disponible pour un trajet confirmé ou terminé';
  end if;
  if p_category is null or p_category not in ('retard', 'absence', 'comportement', 'securite', 'autre') then
    raise exception 'Choisis un motif';
  end if;
  if char_length(v_msg) not between 5 and 1000 then raise exception 'Décris le problème en quelques mots'; end if;
  if (select count(*) from claims where match_id = m.id and author_id = v_uid) >= 5 then
    raise exception 'Tu as déjà envoyé plusieurs réclamations pour ce trajet';
  end if;
  insert into claims (match_id, author_id, category, message) values (m.id, v_uid, p_category, v_msg);
end $$;

revoke execute on function public.submit_claim(uuid, text, text) from public, anon;
grant execute on function public.submit_claim(uuid, text, text) to authenticated;
