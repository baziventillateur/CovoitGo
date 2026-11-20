-- Messagerie entre le conducteur et le passager d'un trajet confirmé, comme des textos.
-- Ouverte tant que le trajet est confirmé (accepté, pas encore terminé) ; fermée ensuite.
-- Les messages sont gardés en base (rien ne se perd si l'autre est hors ligne) et arrivent
-- en direct par Supabase Realtime. Règles d'accès : seuls les deux participants les lisent ;
-- l'écriture passe par send_message (contrôles, anti-abus, notification).

create table public.messages (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references public.matches (id) on delete cascade,
  sender_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index messages_match_idx on public.messages (match_id, created_at);
alter table public.messages enable row level security;
create policy messages_participants on public.messages for select to authenticated
  using (exists (select 1 from public.matches m where m.id = match_id and auth.uid() in (m.driver_id, m.passenger_id)));
revoke all on public.messages from public, anon, authenticated;
grant select on public.messages to authenticated;

-- Dernière lecture de chaque participant : accusés de lecture (« Vu »), messages non lus,
-- et pas de notification quand l'autre a la conversation ouverte.
create table public.chat_reads (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id  uuid not null references public.profiles (id) on delete cascade,
  read_at  timestamptz not null default now(),
  primary key (match_id, user_id)
);
alter table public.chat_reads enable row level security;
create policy chat_reads_participants on public.chat_reads for select to authenticated
  using (exists (select 1 from public.matches m where m.id = match_id and auth.uid() in (m.driver_id, m.passenger_id)));
revoke all on public.chat_reads from public, anon, authenticated;
grant select on public.chat_reads to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages, public.chat_reads;
  end if;
end $$;

create function public.send_message(p_match_id uuid, p_body text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  m       matches;
  v_body  text;
  v_id    bigint;
  v_other uuid;
  v_seen  timestamptz;
  v_name  text;
  v_title text;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if exists (select 1 from user_blocks where user_id = auth.uid()) then
    raise exception 'Ton compte est suspendu. Écris au support pour en savoir plus.';
  end if;
  v_body := btrim(regexp_replace(coalesce(p_body, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g'));
  if v_body = '' then raise exception 'Message vide'; end if;
  if char_length(v_body) > 500 then raise exception 'Message trop long : 500 caractères au plus'; end if;

  select * into m from matches where id = p_match_id and auth.uid() in (driver_id, passenger_id);
  if not found then raise exception 'Conversation introuvable'; end if;
  if m.status <> 'accepted' then raise exception 'La conversation est fermée : le trajet n''est plus en cours.'; end if;
  if (select count(*) from messages where match_id = p_match_id and sender_id = auth.uid()
        and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'Trop de messages d''un coup : patiente un instant.';
  end if;

  insert into messages (match_id, sender_id, body) values (p_match_id, auth.uid(), v_body) returning id into v_id;
  insert into chat_reads (match_id, user_id, read_at) values (p_match_id, auth.uid(), now())
  on conflict (match_id, user_id) do update set read_at = now();

  -- Notification à l'autre, sauf s'il a la conversation ouverte en ce moment. Une rafale de
  -- messages non lus ne fait qu'une notification (mise à jour avec le dernier message).
  v_other := case when auth.uid() = m.driver_id then m.passenger_id else m.driver_id end;
  select read_at into v_seen from chat_reads where match_id = p_match_id and user_id = v_other;
  if v_seen is null or v_seen < now() - interval '25 seconds' then
    select display_name into v_name from profiles where id = auth.uid();
    v_title := 'Message de ' || coalesce(v_name, 'ton covoitureur');
    update notifications set body = left(v_body, 140), title = v_title, created_at = now()
     where id = (select n.id from notifications n
                  where n.user_id = v_other and n.match_id = p_match_id and n.kind = 'message'
                    and n.read_at is null and n.created_at > now() - interval '5 minutes'
                  order by n.created_at desc limit 1);
    if not found then
      insert into notifications (user_id, role, kind, title, body, match_id)
      values (v_other, case when v_other = m.driver_id then 'driver' else 'passenger' end,
              'message', v_title, left(v_body, 140), p_match_id);
    end if;
  end if;

  -- Ménage : les conversations des trajets finis depuis plus de 30 jours sont effacées.
  delete from messages x using matches mm
   where x.match_id = mm.id and mm.status <> 'accepted' and mm.updated_at < now() - interval '30 days';
  return v_id;
end $$;

-- La conversation est lue : accusé de lecture, et ses notifications passent en lu.
create function public.chat_mark_read(p_match_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from matches where id = p_match_id and auth.uid() in (driver_id, passenger_id)) then return; end if;
  insert into chat_reads (match_id, user_id, read_at) values (p_match_id, auth.uid(), now())
  on conflict (match_id, user_id) do update set read_at = now();
  update notifications set read_at = now()
   where user_id = auth.uid() and match_id = p_match_id and kind = 'message' and read_at is null;
end $$;

-- Messages non lus par trajet confirmé (pastille sur le bouton « Message »).
create function public.my_unread_messages() returns table (match_id uuid, unread integer)
language sql stable security definer set search_path = public, extensions as $$
  select m.id, count(x.id)::int
    from matches m
    join messages x on x.match_id = m.id and x.sender_id <> auth.uid()
    left join chat_reads r on r.match_id = m.id and r.user_id = auth.uid()
   where auth.uid() in (m.driver_id, m.passenger_id) and m.status = 'accepted'
     and x.created_at > coalesce(r.read_at, '-infinity'::timestamptz)
   group by m.id
$$;

revoke execute on function public.send_message(uuid, text), public.chat_mark_read(uuid), public.my_unread_messages()
  from public, anon;
grant execute on function public.send_message(uuid, text), public.chat_mark_read(uuid), public.my_unread_messages()
  to authenticated;
