\set ON_ERROR_STOP on
\pset pager off
-- Utilisateurs : conducteur + 4 passagers
insert into auth.users (id, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000001', '{"display_name":"Émir (conducteur)"}'),
 ('00000000-0000-0000-0000-00000000000a', '{"display_name":"A même sens"}'),
 ('00000000-0000-0000-0000-00000000000b', '{"display_name":"B sens inverse"}'),
 ('00000000-0000-0000-0000-00000000000c', '{"display_name":"C trop loin"}'),
 ('00000000-0000-0000-0000-00000000000d', '{"display_name":"D mauvais horaire"}');

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
set role authenticated;

-- Conducteur : Argenteuil -> Paris Saint-Lazare, fenêtre souple de -1h à +3h
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
insert into ids select 'trip', publish_trip('Argenteuil', 2.2470, 48.9472, 'Paris Saint-Lazare', 2.3256, 48.8763,
                                            now() - interval '1 hour', now() + interval '3 hours', 2);

-- A : Asnières -> Saint-Lazare, plus tard mais dans la fenêtre  => DOIT matcher
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into ids select 'reqA', publish_request('Asnières', 2.2855, 48.9105, 'Saint-Lazare', 2.3240, 48.8770,
                                               now(), now() + interval '150 minutes');
-- B : sens inverse => ne doit PAS matcher
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into ids select 'reqB', publish_request('Saint-Lazare', 2.3240, 48.8770, 'Asnières', 2.2855, 48.9105,
                                               now(), now() + interval '2 hours');
-- C : part de Versailles => ne doit PAS matcher
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
insert into ids select 'reqC', publish_request('Versailles', 2.1301, 48.8049, 'Saint-Lazare', 2.3240, 48.8770,
                                               now(), now() + interval '2 hours');
-- D : bon trajet mais demain => ne doit PAS matcher
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
insert into ids select 'reqD', publish_request('Asnières', 2.2855, 48.9105, 'Saint-Lazare', 2.3240, 48.8770,
                                               now() + interval '26 hours', now() + interval '28 hours');

\echo '--- Recherche côté passagers (attendu : A=1, B=0, C=0, D=0)'
do $$
declare r record; n int; expected int;
begin
  for r in select * from (values ('a','reqA',1),('b','reqB',0),('c','reqC',0),('d','reqD',0)) x(u,k,e) loop
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000' || r.u, false);
    select count(*) into n from find_trips_for_request((select v from ids where k = r.k));
    raise notice 'passager % : % trajet(s)', r.u, n;
    if n <> r.e then raise exception 'ECHEC matching pour %', r.u; end if;
  end loop;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select driver_name, pickup_m, dropoff_m, shared_km, seats_left,
       overlap_end - overlap_start as creneau_commun
  from find_trips_for_request((select v from ids where k = 'reqA'));

\echo '--- Confidentialité : A ne voit pas le trajet tant qu''il n''y a pas de mise en relation ; C ne lit pas la demande de A'
do $$ begin
  if (select count(*) from trips) <> 0 then raise exception 'ECHEC RLS trips'; end if;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
  if exists (select 1 from requests where passenger_id <> auth.uid()) then raise exception 'ECHEC RLS requests'; end if;
  if (select count(*) from find_trips_for_request((select v from ids where k = 'reqA'))) <> 0 then
    raise exception 'ECHEC : recherche sur la demande d''un autre'; end if;
end $$;

\echo '--- Côté conducteur : propositions automatiques (attendu : 1, le passager A)'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select passenger_name, pickup_m, shared_km from find_requests_for_trip((select v from ids where k = 'trip'));

\echo '--- Cycle complet : A propose, ne peut pas s''auto-accepter, le conducteur accepte, les deux confirment'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into ids select 'match', propose_match((select v from ids where k='trip'), (select v from ids where k='reqA'));
do $$ begin
  begin
    perform respond_match((select v from ids where k='match'), true);
    raise exception 'ECHEC : auto-acceptation possible';
  exception when others then
    if sqlerrm like 'ECHEC%' then raise; end if;
    raise notice 'auto-acceptation refusée : %', sqlerrm;
  end;
  -- B (non compatible) ne peut pas forcer une proposition
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  begin
    perform propose_match((select v from ids where k='trip'), (select v from ids where k='reqB'));
    raise exception 'ECHEC : proposition non compatible acceptée';
  exception when others then
    if sqlerrm like 'ECHEC%' then raise; end if;
    raise notice 'proposition incompatible refusée : %', sqlerrm;
  end;
  -- Écritures directes interdites
  begin
    update profiles set points = 9999 where id = auth.uid();
    raise exception 'ECHEC : points modifiables à la main';
  exception when insufficient_privilege then raise notice 'triche sur les points refusée';
  end;
end $$;

-- Téléphones : A le fournit, le conducteur aussi
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select set_phone('06 12 34 56 78');
do $$ begin
  if (select other_phone from my_matches()) is not null then raise exception 'ECHEC : téléphone visible avant acceptation'; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_phone('+33 7 00 00 00 01');
do $$ begin
  if (select count(*) from notifications) <> 1 then raise exception 'ECHEC : le conducteur doit avoir 1 notification (demande)'; end if;
  if (select other_phone from my_matches()) is not null then raise exception 'ECHEC : téléphone visible avant acceptation'; end if;
  if exists (select 1 from profile_private where user_id <> auth.uid()) then raise exception 'ECHEC RLS téléphone'; end if;
end $$;
select set_vehicle('Peugeot 208', 'grise', 'ab-123-cd');
-- Un groupe de 3 ne rentre pas dans un trajet à 2 places
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
insert into ids select 'reqD3', publish_request('Asnières', 2.2855, 48.9105, 'Saint-Lazare', 2.3240, 48.8770,
                                                now(), now() + interval '2 hours', 3, 'Deux valises');
do $$ begin
  if (select count(*) from find_trips_for_request((select v from ids where k='reqD3'))) <> 0 then
    raise exception 'ECHEC : groupe de 3 proposé sur un trajet à 2 places'; end if;
  perform cancel_request((select v from ids where k='reqD3'));
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  if (select vehicle_plate from my_matches()) is not null then raise exception 'ECHEC : plaque visible avant acceptation'; end if;
  if exists (select 1 from vehicles) then raise exception 'ECHEC RLS véhicule'; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select passenger_name, seats, note from find_requests_for_trip((select v from ids where k='trip'));
select respond_match((select v from ids where k='match'), true) as reponse_conducteur;
select role, other_name, other_phone, stage from my_matches();
do $$ begin
  if (select other_phone from my_matches()) <> '0612345678' then raise exception 'ECHEC : téléphone du passager attendu après acceptation'; end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select role, vehicle_model, vehicle_color, vehicle_plate from my_matches();
do $$ begin
  if (select vehicle_plate from my_matches()) <> 'AB-123-CD' then raise exception 'ECHEC : plaque attendue après acceptation'; end if;
end $$;
\echo '--- Étapes : seul le conducteur fait avancer le trajet ; avis impossible avant la fin'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ begin
  begin perform advance_match((select v from ids where k='match')); raise exception 'ECHEC : le passager fait avancer le trajet';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
  begin perform submit_review((select v from ids where k='match'), 5, null); raise exception 'ECHEC : avis avant la fin';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select advance_match((select v from ids where k='match')) as conducteur_1;
select advance_match((select v from ids where k='match')) as conducteur_2;
select advance_match((select v from ids where k='match')) as conducteur_fin;

\echo '--- Avis : A note le conducteur, pas deux fois, pas par un tiers'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select submit_review((select v from ids where k='match'), 5, '  Super trajet, ponctuel  ');
do $$ begin
  begin perform submit_review((select v from ids where k='match'), 1, null); raise exception 'ECHEC : double avis';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
  begin perform submit_review((select v from ids where k='match'), 9, null); raise exception 'ECHEC : note hors bornes';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
  if not (select reviewed_by_me from my_matches()) then raise exception 'ECHEC reviewed_by_me'; end if;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
  begin perform submit_review((select v from ids where k='match'), 1, 'intrus'); raise exception 'ECHEC : avis par un tiers';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
  begin insert into reviews (match_id, author_id, target_id, rating) select v, auth.uid(), '00000000-0000-0000-0000-000000000001', 1 from ids where k='match';
    raise exception 'ECHEC : écriture directe d''un avis';
  exception when insufficient_privilege then raise notice 'écriture directe refusée'; end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select submit_review((select v from ids where k='match'), 4, null);
select role, title, body from notifications order by id;
select rating, comment from reviews order by id;
do $$ begin
  if (select other_rating from my_matches()) <> 4.0 then raise exception 'ECHEC note moyenne'; end if;
end $$;
do $$ begin
  if (select other_phone from my_matches()) is not null then raise exception 'ECHEC : téléphone encore visible après le trajet'; end if;
  perform mark_notifications_read();
  if exists (select 1 from notifications where read_at is null) then raise exception 'ECHEC lecture notifications'; end if;
  begin
    perform publish_trip('Argenteuil', 2.2470, 48.9472, 'Paris Saint-Lazare', 2.3256, 48.8763, now(), now() + interval '1 hour', 2);
    raise exception 'ECHEC : doublon de trajet accepté';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'doublon refusé : %', sqlerrm; end;
end $$;

\echo '--- Résultat : points et badges'
select display_name, points from profiles where points > 0 order by points desc;
select p.display_name, b.badge_code from user_badges b join profiles p on p.id = b.user_id order by 1;
do $$ begin
  if (select sum(points) from profiles) <> 25 then raise exception 'ECHEC points'; end if;
  if (select count(*) from user_badges) <> 2 then raise exception 'ECHEC badges'; end if;
end $$;

\echo '--- Annulation : nouvelle demande acceptée puis annulée => la place est rendue'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into ids select 'reqB2', publish_request('Asnières', 2.2855, 48.9105, 'Saint-Lazare', 2.3240, 48.8770,
                                                now(), now() + interval '2 hours');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
insert into ids select 'match2', propose_match((select v from ids where k='trip'), (select v from ids where k='reqB2'));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select respond_match((select v from ids where k='match2'), true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$ begin
  if (select status || '/' || seats_taken from trips) <> 'full/2' then raise exception 'ECHEC trajet complet'; end if;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  perform cancel_request((select v from ids where k='reqB2'));
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  if (select status || '/' || seats_taken from trips) <> 'open/1' then raise exception 'ECHEC place non rendue'; end if;
end $$;
\echo 'TOUS LES TESTS PASSENT'
