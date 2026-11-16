-- L'assistance ne concerne que les trajets confirmés en cours : un trajet terminé est soldé.
create or replace function public.submit_claim(p_match_id uuid, p_category text, p_message text) returns void
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
  if m.status <> 'accepted' then
    raise exception 'L''assistance est disponible pendant un trajet confirmé';
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
