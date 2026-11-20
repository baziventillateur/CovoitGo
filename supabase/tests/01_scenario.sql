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

\echo '--- Prix : barème, fourchette, refus hors fourchette'
select km, price_for_km(km) as conseille, price_margin(price_for_km(km)) as marge
  from (values (3::numeric), (5), (10), (23), (40), (100), (300)) v(km);
select * from quote_trip(2.2470, 48.9472, 2.3256, 48.8763);
do $$ declare q record; begin
  select * into q from quote_trip(2.2470, 48.9472, 2.3256, 48.8763);
  if (select cost_share_cents from trips) <> q.reco_cents then raise exception 'ECHEC : prix par défaut = prix conseillé'; end if;
  begin perform publish_trip('X', 2.2470, 48.9472, 'Y', 2.40, 48.80, now(), now() + interval '1 hour', 2, 5000);
    raise exception 'ECHEC : prix abusif accepté';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
  begin perform publish_trip('X', 2.2470, 48.9472, 'Y', 2.40, 48.80, now(), now() + interval '1 hour', 2, 10);
    raise exception 'ECHEC : prix trop bas accepté';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
end $$;

select set_trip_duration((select v from ids where k='trip'), 30);    -- plausible : retenue
select set_trip_duration((select v from ids where k='trip'), 2000);  -- absurde : ignorée
do $$ begin
  if (select duration_min from trips) <> 30 then raise exception 'ECHEC durée du trajet'; end if;
end $$;
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
select driver_name, pickup_m, dropoff_m, shared_km, seats_left, cost_share_cents as prix_passager, ride_minutes,
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
do $$ begin
  if (select cost_share_cents from my_matches()) >= (select cost_share_cents from trips where id = (select v from ids where k='trip')) then
    raise exception 'ECHEC : le passager d''une portion doit payer moins que le trajet complet'; end if;
  if (select cost_share_cents from my_matches()) < 100 then raise exception 'ECHEC prix figé'; end if;
  if (select ride_minutes from matches) not between 2 and 30 then raise exception 'ECHEC durée de la portion'; end if;
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
do $$ begin
  if (select status from trips where id = (select v from ids where k='trip')) <> 'full' then
    raise exception 'ECHEC : un trajet parti doit être fermé aux nouvelles demandes'; end if;
  perform submit_claim((select v from ids where k='match'), 'retard', 'Le passager a 20 minutes de retard');
  begin perform submit_claim((select v from ids where k='match'), 'retard', 'x'); raise exception 'ECHEC : réclamation vide';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  if exists (select 1 from claims) then raise exception 'ECHEC : réclamation visible par l''autre personne'; end if;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
  begin perform submit_claim((select v from ids where k='match'), 'autre', 'Je ne suis pas concerné'); raise exception 'ECHEC : réclamation par un tiers';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; raise notice 'refusé : %', sqlerrm; end;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
end $$;
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
  if (select status from trips where id = (select v from ids where k='trip')) <> 'done' then
    raise exception 'ECHEC : un trajet terminé doit être clos'; end if;
  -- Le trajet clos ne bloque pas une nouvelle publication ; un vrai doublon, si.
  update ids set v = publish_trip('Argenteuil', 2.2470, 48.9472, 'Paris Saint-Lazare', 2.3256, 48.8763,
                                  now() - interval '1 hour', now() + interval '3 hours', 2) where k = 'trip';
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
  if (select status || '/' || seats_taken from trips where id = (select v from ids where k='trip')) <> 'open/1' then raise exception 'ECHEC trajet complet'; end if;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  perform cancel_request((select v from ids where k='reqB2'));
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  if (select status || '/' || seats_taken from trips where id = (select v from ids where k='trip')) <> 'open/0' then raise exception 'ECHEC place non rendue'; end if;
end $$;
-- Circulation : réservation d'un appel puis durée recalée (fonctions réservées au serveur).
reset role;
do $$
declare v_trip uuid; v_driver uuid; v_n int;
begin
  select id, driver_id into v_trip, v_driver from trips where status in ('open','full') limit 1;
  if v_trip is null then raise notice 'circulation : aucun trajet ouvert, test sauté'; return; end if;
  select count(*) into v_n from traffic_reserve(v_trip, v_driver, false);
  if v_n <> 1 then raise exception 'ECHEC circulation : réservation refusée'; end if;
  select count(*) into v_n from traffic_reserve(v_trip, v_driver, false);
  if v_n <> 0 then raise exception 'ECHEC circulation : second appel immédiat accepté'; end if;
  if traffic_apply(v_trip, 100000, 5) then raise exception 'ECHEC circulation : durée absurde retenue'; end if;
  begin perform traffic_reserve(v_trip, gen_random_uuid(), false);
    raise exception 'ECHEC circulation : trajet d''un autre accepté';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  if has_function_privilege('authenticated', 'traffic_apply(uuid,integer,integer)', 'execute') then
    raise exception 'ECHEC circulation : fonction ouverte à l''appli';
  end if;
end $$;

-- Meilleurs créneaux : 6 demandes par personne et par jour.
do $$
declare v_user uuid; i int;
begin
  select id into v_user from profiles limit 1;
  for i in 1..6 loop
    if not traffic_reserve_slots(v_user, 3) then raise exception 'ECHEC créneaux : demande % refusée', i; end if;
  end loop;
  if traffic_reserve_slots(v_user, 3) then raise exception 'ECHEC créneaux : 7e demande acceptée'; end if;
  if traffic_reserve_slots(gen_random_uuid(), 3) then raise exception 'ECHEC créneaux : inconnu accepté'; end if;
end $$;

-- Suspendre, reprendre, modifier, supprimer un trajet.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$
declare v_trip uuid; v_new uuid;
begin
  v_trip := publish_trip('Lyon', 4.8357, 45.7640, 'Villeurbanne', 4.8795, 45.7719,
                         now() + interval '3 days', now() + interval '3 days 2 hours', 3, 0);
  perform pause_trip(v_trip);
  if (select status from trips where id = v_trip) <> 'paused' then raise exception 'ECHEC suspension'; end if;
  begin perform publish_trip('Lyon', 4.8357, 45.7640, 'Villeurbanne', 4.8795, 45.7719,
                         now() + interval '3 days', now() + interval '3 days 2 hours', 3, 0);
    raise exception 'ECHEC : doublon d''un trajet suspendu accepté';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform resume_trip(v_trip);
  if (select status from trips where id = v_trip) <> 'open' then raise exception 'ECHEC reprise'; end if;
  if (select count(*) from trip_for_edit(v_trip)) <> 1 then raise exception 'ECHEC lecture pour modification'; end if;
  perform pause_trip(v_trip);
  v_new := replace_trip(v_trip, 'Lyon', 4.8357, 45.7640, 'Bron', 4.9130, 45.7390,
                        now() + interval '4 days', now() + interval '4 days 1 hour', 2, 0);
  if (select status from trips where id = v_trip) <> 'cancelled' then raise exception 'ECHEC modification : ancien trajet conservé'; end if;
  if (select status from trips where id = v_new) <> 'paused' or (select dest_label from trips where id = v_new) <> 'Bron' then
    raise exception 'ECHEC modification';
  end if;
  perform cancel_trip(v_new);
  if (select status from trips where id = v_new) <> 'cancelled' then raise exception 'ECHEC suppression'; end if;
end $$;

-- Détour, approche du chauffeur, abonnement aux notifications.
reset role;
do $$
declare v_trip uuid; v_req uuid; v_match uuid; v_d int; v_n int;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  v_trip := publish_trip('Nantes', -1.5536, 47.2184, 'Rezé', -1.5490, 47.1810,
                         now() + interval '20 minutes', now() + interval '2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  v_req := publish_request('Nantes centre', -1.5530, 47.2150, 'Rezé', -1.5492, 47.1815,
                           now() + interval '20 minutes', now() + interval '2 hours');
  v_match := propose_match(v_trip, v_req);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  perform respond_match(v_match, true);

  if driver_ping(v_match, -1.5530, 47.2150) is not null then raise exception 'ECHEC approche : acceptée avant le départ'; end if;
  perform advance_match(v_match);
  v_d := driver_ping(v_match, -1.60, 47.25);
  if v_d is null or v_d < 3000 then raise exception 'ECHEC approche : distance %', v_d; end if;
  if (select count(*) from notifications where match_id = v_match and kind = 'near') <> 0 then raise exception 'ECHEC approche : alerte trop tôt'; end if;
  update matches set driver_seen_at = null where id = v_match;
  perform driver_ping(v_match, -1.5531, 47.2151);
  update matches set driver_seen_at = null where id = v_match;
  perform driver_ping(v_match, -1.5531, 47.2151);
  select count(*) into v_n from notifications where match_id = v_match and kind = 'near';
  if v_n <> 1 then raise exception 'ECHEC approche : % alerte(s) au lieu d''une', v_n; end if;

  perform save_push_subscription('https://fcm.googleapis.com/fcm/send/abc', repeat('k', 87), repeat('a', 22));
  perform save_push_subscription('https://fcm.googleapis.com/fcm/send/abc', repeat('k', 87), repeat('b', 22));
  if (select count(*) from push_subscriptions) <> 1 then raise exception 'ECHEC abonnement en double'; end if;
  begin perform save_push_subscription('http://exemple.test/x', repeat('k', 87), repeat('a', 22));
    raise exception 'ECHEC : abonnement invalide accepté';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform remove_push_subscription('https://fcm.googleapis.com/fcm/send/abc');
  if (select count(*) from push_subscriptions) <> 0 then raise exception 'ECHEC désabonnement'; end if;
  if has_function_privilege('authenticated', 'traffic_detour_save(uuid,uuid,integer)', 'execute') then
    raise exception 'ECHEC : enregistrement de détour ouvert à l''appli';
  end if;
end $$;
do $$
declare v_trip uuid; v_driver uuid; v_req uuid; v_n int;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  v_trip := publish_trip('Lille', 3.0573, 50.6292, 'Roubaix', 3.1746, 50.6927, now() + interval '1 day', now() + interval '1 day 2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  v_req := publish_request('Lille', 3.0600, 50.6300, 'Roubaix', 3.1740, 50.6920, now() + interval '1 day', now() + interval '1 day 2 hours');
  select count(*) into v_n from traffic_detour_inputs(v_trip, '00000000-0000-0000-0000-000000000001', array[v_req]);
  if v_n <> 1 then raise exception 'ECHEC détour : % ligne(s)', v_n; end if;
  perform traffic_detour_save(v_trip, v_req, 7);
  select count(*) into v_n from traffic_detour_inputs(v_trip, '00000000-0000-0000-0000-000000000001', array[v_req]);
  if v_n <> 0 then raise exception 'ECHEC détour : recalcul inutile'; end if;
  begin perform traffic_detour_inputs(v_trip, '00000000-0000-0000-0000-00000000000a', array[v_req]);
    raise exception 'ECHEC détour : trajet d''un autre accepté';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
end $$;

-- Mes comptes : les trajets terminés apparaissent avec leur montant, côté conducteur.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$ begin
  if (select count(*) from my_money()) <> (select count(*) from matches where status = 'completed'
        and '00000000-0000-0000-0000-000000000001' in (driver_id, passenger_id)) then
    raise exception 'ECHEC mes comptes';
  end if;
end $$;
reset role;

-- Porte-monnaie : retrait refusé sans RIB ou sous 25 €, puis accepté ; annulation si Stripe échoue.
do $$
declare u uuid := '00000000-0000-0000-0000-000000000001'; v_id bigint; v_c int;
begin
  delete from wallet_entries where user_id = u;  -- frais des trajets en espèces joués plus haut
  insert into wallet_entries (user_id, kind, cents) values (u, 'ride', 3000);
  begin perform wallet_withdraw_reserve(u); raise exception 'ECHEC : retrait sans RIB';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform payout_account_save(u, 'acct_test_1', true, true);
  insert into wallet_entries (user_id, kind, cents) values (u, 'cash_fee', -1000);
  begin perform wallet_withdraw_reserve(u); raise exception 'ECHEC : retrait sous 25 €';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  insert into wallet_entries (user_id, kind, cents) values (u, 'ride', 1500);
  select entry_id, cents into v_id, v_c from wallet_withdraw_reserve(u);
  if v_c <> 3500 then raise exception 'ECHEC : montant retiré %', v_c; end if;
  perform wallet_withdraw_cancel(v_id);
  if (select coalesce(sum(cents),0) from wallet_entries where user_id = u) <> 3500 then raise exception 'ECHEC : annulation du retrait'; end if;
  select entry_id into v_id from wallet_withdraw_reserve(u);
  perform wallet_withdraw_confirm(v_id, 'tr_test');
  perform wallet_withdraw_cancel(v_id);
  if (select coalesce(sum(cents),0) from wallet_entries where user_id = u) <> 0 then raise exception 'ECHEC : retrait confirmé annulable'; end if;
  if has_table_privilege('authenticated', 'wallet_entries', 'insert') then raise exception 'ECHEC : porte-monnaie modifiable par l''appli'; end if;
  -- Un seul retrait par mois
  insert into wallet_entries (user_id, kind, cents) values (u, 'ride', 3000) returning id into v_id;
  begin perform wallet_withdraw_reserve(u); raise exception 'ECHEC : deux retraits dans le mois';
  exception when others then if sqlerrm not like 'Un retrait par mois%' then raise exception 'ECHEC retrait mensuel : %', sqlerrm; end if; end;
  delete from wallet_entries where id = v_id;
end $$;

-- Paiement : frais, carte obligatoire avant le départ, crédit du porte-monnaie, espèces, remboursement.
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a';
        v_trip uuid; v_req uuid; v_m uuid; v_price int; v_fee int; v_before int;
begin
  if service_fee(1800) <> 125 or service_fee(500) <> 60 or service_fee(0) <> 0 then raise exception 'ECHEC barème des frais'; end if;
  select coalesce(sum(cents), 0) into v_before from wallet_entries where user_id = d;

  -- Carte
  perform set_config('request.jwt.claim.sub', d::text, false);
  v_trip := publish_trip('Rennes', -1.6778, 48.1173, 'Cesson', -1.6030, 48.1210, now() + interval '20 minutes', now() + interval '2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_req := publish_request('Rennes', -1.6770, 48.1170, 'Cesson', -1.6035, 48.1212, now() + interval '20 minutes', now() + interval '2 hours');
  perform set_request_pay_method(v_req, 'card');
  v_m := propose_match(v_trip, v_req);
  select price_cents, fee_cents into v_price, v_fee from matches where id = v_m;
  if (select pay_method from matches where id = v_m) <> 'card' or v_fee <> service_fee(v_price) or v_fee = 0 then raise exception 'ECHEC paiement figé sur la mise en relation'; end if;
  perform set_config('request.jwt.claim.sub', d::text, false);
  perform respond_match(v_m, true);
  if (select count(*) from notifications where match_id = v_m and kind = 'pay') <> 1 then raise exception 'ECHEC invitation à payer'; end if;
  begin perform advance_match(v_m); raise exception 'ECHEC : départ sans paiement';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  if not match_mark_paid(v_m, 'pi_test_1') or match_mark_paid(v_m, 'pi_test_1') then raise exception 'ECHEC marquage payé'; end if;
  perform advance_match(v_m); perform advance_match(v_m); perform advance_match(v_m);
  if (select coalesce(sum(cents), 0) from wallet_entries where user_id = d) - v_before <> v_price - v_fee then
    raise exception 'ECHEC crédit du porte-monnaie';
  end if;
  if match_refund_claim(v_m) is not null then raise exception 'ECHEC : trajet terminé remboursable'; end if;

  -- Carte puis annulation : remboursable une seule fois
  v_trip := publish_trip('Brest', -4.4861, 48.3904, 'Guipavas', -4.4000, 48.4350, now() + interval '20 minutes', now() + interval '2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_req := publish_request('Brest', -4.4855, 48.3900, 'Guipavas', -4.4005, 48.4352, now() + interval '20 minutes', now() + interval '2 hours');
  perform set_request_pay_method(v_req, 'card');
  v_m := propose_match(v_trip, v_req);
  perform set_config('request.jwt.claim.sub', d::text, false);
  perform respond_match(v_m, true);
  perform match_mark_paid(v_m, 'pi_test_2');
  perform cancel_match(v_m);
  if match_refund_claim(v_m) <> 'pi_test_2' or match_refund_claim(v_m) is not null then raise exception 'ECHEC remboursement unique'; end if;

  -- Espèces : seuls les frais sont dus
  select coalesce(sum(cents), 0) into v_before from wallet_entries where user_id = d;
  v_trip := publish_trip('Caen', -0.3707, 49.1829, 'Ifs', -0.3520, 49.1390, now() + interval '20 minutes', now() + interval '2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_req := publish_request('Caen', -0.3700, 49.1825, 'Ifs', -0.3525, 49.1392, now() + interval '20 minutes', now() + interval '2 hours');
  v_m := propose_match(v_trip, v_req);
  perform set_config('request.jwt.claim.sub', d::text, false);
  perform respond_match(v_m, true);
  perform advance_match(v_m); perform advance_match(v_m); perform advance_match(v_m);
  select fee_cents into v_fee from matches where id = v_m;
  if (select coalesce(sum(cents), 0) from wallet_entries where user_id = d) - v_before <> -v_fee then raise exception 'ECHEC frais en espèces'; end if;
end $$;

-- Panel admin : fermé aux autres, ouvert à l'admin.
insert into admins values ('00000000-0000-0000-0000-000000000001');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ begin
  if is_admin() then raise exception 'ECHEC : admin pour tout le monde'; end if;
  begin perform admin_overview(); raise exception 'ECHEC : vue admin ouverte';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  begin perform count(*) from admin_users(); raise exception 'ECHEC : liste des comptes ouverte';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform touch_seen(true);
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$ begin
  if (admin_overview() ->> 'users_total')::int < 2 or (admin_overview() ->> 'installed')::int <> 1 then raise exception 'ECHEC indicateurs admin'; end if;
  if (select count(*) from admin_users('', 50)) < 2 then raise exception 'ECHEC liste des comptes'; end if;
  if (select count(*) from admin_activity('termine', 50)) < 1 or (select count(*) from admin_activity(null, 300)) < 5 then raise exception 'ECHEC journal'; end if;
end $$;
reset role;

-- Passager à quelques kilomètres de la route : trouvé avec le rayon large, pas avec le rayon étroit.
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a';
        v_trip uuid; v_req uuid;
begin
  perform set_config('request.jwt.claim.sub', d::text, false);
  v_trip := publish_trip('Épône', 1.8167, 48.9547, 'Paris', 2.3522, 48.8566, now() + interval '2 days', now() + interval '2 days 2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_req := publish_request('Épône', 1.8180, 48.9545, 'Argenteuil', 2.2470, 48.9472, now() + interval '2 days', now() + interval '2 days 2 hours');
  perform set_config('request.jwt.claim.sub', d::text, false);
  if exists (select 1 from find_requests_for_trip(v_trip, 1000) where request_id = v_req) then raise exception 'ECHEC : trouvé dans le rayon étroit'; end if;
  if not exists (select 1 from find_requests_for_trip(v_trip, 12000) where request_id = v_req) then raise exception 'ECHEC : passager sur la route non trouvé'; end if;
  if (select count(*) from traffic_detour_inputs(v_trip, d, array[v_req])) <> 1 then raise exception 'ECHEC : détour non calculable'; end if;
  perform propose_match(v_trip, v_req);
end $$;

-- Détour maximum : borné entre 5 et 30 minutes.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  if set_max_detour(2) <> 5 or set_max_detour(90) <> 30 or set_max_detour(20) <> 20 then raise exception 'ECHEC bornes du détour'; end if;
  if (select max_detour_min from driver_settings where user_id = '00000000-0000-0000-0000-000000000001') <> 20 then raise exception 'ECHEC détour enregistré'; end if;
end $$;

-- Carte du passager : approximative pour un simple candidat, exacte une fois la proposition faite, fermée aux autres.
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a';
        v_trip uuid; v_req uuid; r record;
begin
  perform set_config('request.jwt.claim.sub', d::text, false);
  v_trip := publish_trip('Tours', 0.6848, 47.3941, 'Amboise', 0.9824, 47.4133, now() + interval '3 days', now() + interval '3 days 2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_req := publish_request('Tours', 0.68731, 47.39382, 'Amboise', 0.98117, 47.41291, now() + interval '3 days', now() + interval '3 days 2 hours');
  begin perform request_map(v_trip, v_req); raise exception 'ECHEC : carte ouverte au passager';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub', d::text, false);
  select * into r from request_map(v_trip, v_req);
  if r.exact or abs(r.a_lng - 0.68731) < 0.00001 or r.trip_route is null then raise exception 'ECHEC : carte du candidat trop précise'; end if;
  perform propose_match(v_trip, v_req);
  select * into r from request_map(v_trip, v_req);
  if not r.exact or abs(r.a_lng - 0.68731) > 0.00001 then raise exception 'ECHEC : carte exacte après proposition'; end if;
end $$;

-- Admin : barèmes réglables (bornés), suspension d'un compte.
set role authenticated;
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a'; v_before int;
begin
  perform set_config('request.jwt.claim.sub', p::text, false);
  begin perform admin_set_pricing('{"fee_fixed": 0}'); raise exception 'ECHEC : barème ouvert à tous';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  begin perform admin_set_block(d, true, 'x'); raise exception 'ECHEC : suspension ouverte à tous';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;

  perform set_config('request.jwt.claim.sub', d::text, false);
  v_before := price_for_km(45.5);
  if v_before <> 1800 or service_fee(1800) <> 125 then raise exception 'ECHEC : barème par défaut modifié (%)', v_before; end if;
  perform admin_set_pricing('{"fee_fixed": 50, "fee_percent": 10, "km_mid": 40}');
  if service_fee(1800) <> 230 or price_for_km(45.5) <= v_before then raise exception 'ECHEC : nouveau barème non appliqué'; end if;
  begin perform admin_set_pricing('{"fee_percent": 80}'); raise exception 'ECHEC : frais hors bornes acceptés';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform admin_set_pricing('{"fee_fixed": 35, "fee_percent": 5, "km_mid": 34}');

  begin perform admin_set_block(d, true, 'x'); raise exception 'ECHEC : admin suspendu';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform admin_set_block(p, true, 'test');
  perform set_config('request.jwt.claim.sub', p::text, false);
  begin perform publish_request('Dijon', 5.0415, 47.3220, 'Chenôve', 5.0080, 47.2910, now() + interval '5 days', now() + interval '5 days 1 hour');
    raise exception 'ECHEC : compte suspendu actif';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub', d::text, false);
  if (select count(*) from admin_blocked()) <> 1 then raise exception 'ECHEC liste des suspendus'; end if;
  perform admin_set_block(p, false);
  perform set_config('request.jwt.claim.sub', p::text, false);
  perform publish_request('Dijon', 5.0415, 47.3220, 'Chenôve', 5.0080, 47.2910, now() + interval '5 days', now() + interval '5 days 1 hour');
end $$;
reset role;

-- Fiche client : fermée aux autres, complète pour l'admin.
set role authenticated;
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a'; v jsonb;
begin
  perform set_config('request.jwt.claim.sub', p::text, false);
  begin perform admin_user_detail(d); raise exception 'ECHEC : fiche ouverte à tous';
  exception when others then if sqlerrm like 'ECHEC%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub', d::text, false);
  v := admin_user_detail(p);
  if v ->> 'name' is null or jsonb_array_length(v -> 'matches') < 3 or jsonb_array_length(v -> 'requests') < 3 then raise exception 'ECHEC fiche client'; end if;
  if (v -> 'matches' -> 0 ->> 'other_id') is null then raise exception 'ECHEC : lien vers l''autre personne'; end if;
end $$;
reset role;

-- Séries : rattachement réservé à ses propres annonces, une date modifiée reste dans la série.
set role authenticated;
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a';
        a uuid; b uuid; c uuid; v_new uuid; sid uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', d::text, false);
  a := publish_trip('Lille', 3.0573, 50.6292, 'Douai', 3.0800, 50.3700, now() + interval '8 days', now() + interval '8 days 1 hour', 3, 0);
  b := publish_trip('Lille', 3.0573, 50.6292, 'Douai', 3.0800, 50.3700, now() + interval '9 days', now() + interval '9 days 1 hour', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  c := publish_request('Lille', 3.0573, 50.6292, 'Douai', 3.0800, 50.3700, now() + interval '8 days', now() + interval '8 days 1 hour');
  perform set_series(array[a, b], sid);
  if exists (select 1 from trips where id in (a, b) and series_id is not null) then raise exception 'ECHEC : série posée sur les trajets d''un autre'; end if;
  perform set_config('request.jwt.claim.sub', d::text, false);
  perform set_series(array[a, b, c], sid);
  if (select count(*) from trips where series_id = sid) <> 2 then raise exception 'ECHEC : série non posée'; end if;
  if exists (select 1 from requests where id = c and series_id is not null) then raise exception 'ECHEC : série posée sur la recherche d''un autre'; end if;
  v_new := replace_trip(a, 'Lille', 3.0573, 50.6292, 'Douai', 3.0800, 50.3700, now() + interval '8 days 1 hour', now() + interval '8 days 2 hours', 2, 0);
  if (select series_id from trips where id = v_new) is distinct from sid then raise exception 'ECHEC : date modifiée sortie de la série'; end if;
end $$;
reset role;

-- Actions de série : suspendre, reprendre, supprimer ; les dates avec un passager confirmé sont gardées.
set role authenticated;
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a';
        a uuid; b uuid; c uuid; r uuid; m uuid; sid uuid := gen_random_uuid(); res jsonb;
begin
  perform set_config('request.jwt.claim.sub', d::text, false);
  a := publish_trip('Metz', 6.1757, 49.1193, 'Thionville', 6.1683, 49.3579, now() + interval '10 days', now() + interval '10 days 1 hour', 3, 0);
  b := publish_trip('Metz', 6.1757, 49.1193, 'Thionville', 6.1683, 49.3579, now() + interval '11 days', now() + interval '11 days 1 hour', 3, 0);
  c := publish_trip('Metz', 6.1757, 49.1193, 'Thionville', 6.1683, 49.3579, now() + interval '12 days', now() + interval '12 days 1 hour', 3, 0);
  perform set_series(array[a, b, c], sid);
  perform set_config('request.jwt.claim.sub', p::text, false);
  r := publish_request('Metz', 6.1757, 49.1193, 'Thionville', 6.1683, 49.3579, now() + interval '10 days', now() + interval '10 days 1 hour');
  begin perform series_action(sid, 'cancel'); exception when others then null; end;
  if (select count(*) from trips where series_id = sid and status = 'cancelled') <> 0 then raise exception 'ECHEC : série d''un autre supprimée'; end if;
  m := propose_match(a, r);
  perform set_config('request.jwt.claim.sub', d::text, false);
  perform respond_match(m, true);
  res := series_action(sid, 'pause');
  if (res ->> 'done')::int <> 2 or (res ->> 'kept')::int <> 1 then raise exception 'ECHEC suspension de série : %', res; end if;
  res := series_action(sid, 'resume');
  if (res ->> 'done')::int <> 2 then raise exception 'ECHEC reprise de série : %', res; end if;
  res := series_action(sid, 'cancel');
  if (res ->> 'done')::int <> 2 or (select status from trips where id = a) = 'cancelled' then raise exception 'ECHEC suppression de série : %', res; end if;
end $$;
reset role;

-- Frais d'espèces : au-delà de 5 € dus, le chauffeur ne propose ni n'accepte de trajet en espèces ;
-- le passager n'est jamais bloqué ; la carte reste possible ; la recharge débloque, une seule fois.
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a';
        v_trip uuid; v_req uuid; v_m uuid;
begin
  delete from wallet_entries where user_id = d;
  insert into wallet_entries (user_id, kind, cents) values (d, 'cash_fee', -600);
  perform set_config('request.jwt.claim.sub', d::text, false);
  if not (select blocked from cash_debt_status()) or (select debt from cash_debt_status()) <> 600 then raise exception 'ECHEC état de la dette'; end if;
  v_trip := publish_trip('Nancy', 6.1844, 48.6921, 'Laxou', 6.1500, 48.6850, now() + interval '20 minutes', now() + interval '2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_req := publish_request('Nancy', 6.1840, 48.6920, 'Laxou', 6.1505, 48.6852, now() + interval '20 minutes', now() + interval '2 hours');
  perform set_config('request.jwt.claim.sub', d::text, false);
  begin perform propose_match(v_trip, v_req); raise exception 'ECHEC : proposition en espèces malgré la dette';
  exception when others then if sqlerrm not like 'Tu dois 6,00 €%' then raise exception 'ECHEC blocage proposition : %', sqlerrm; end if; end;
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_m := propose_match(v_trip, v_req);
  perform set_config('request.jwt.claim.sub', d::text, false);
  begin perform respond_match(v_m, true); raise exception 'ECHEC : acceptation en espèces malgré la dette';
  exception when others then if sqlerrm not like 'Tu dois%' then raise exception 'ECHEC blocage acceptation : %', sqlerrm; end if; end;
  perform set_config('request.jwt.claim.sub', p::text, false);
  perform set_request_pay_method(v_req, 'card');
  perform set_config('request.jwt.claim.sub', d::text, false);
  if respond_match(v_m, true) <> 'accepted' then raise exception 'ECHEC : trajet par carte refusé au chauffeur endetté'; end if;
  perform cancel_match(v_m);

  perform wallet_topup_start(d, 'cs_test_1', 600);
  if wallet_topup_credit('cs_test_1', 'pi_t') <> 600 or wallet_topup_credit('cs_test_1', 'pi_t') <> 0 then raise exception 'ECHEC recharge unique'; end if;
  if (select blocked from cash_debt_status()) or (select coalesce(sum(cents), 0) from wallet_entries where user_id = d) <> 0 then
    raise exception 'ECHEC : recharge sans effet';
  end if;
  if has_function_privilege('authenticated', 'wallet_topup_credit(text, text)', 'execute') then raise exception 'ECHEC : recharge créditable par l''appli'; end if;

  -- Passage du seuil : le chauffeur est prévenu une fois.
  insert into wallet_entries (user_id, kind, cents) values (d, 'cash_fee', -480);
  v_trip := publish_trip('Dijon', 5.0415, 47.3220, 'Chenôve', 5.0090, 47.2900, now() + interval '20 minutes', now() + interval '2 hours', 3, 0);
  perform set_config('request.jwt.claim.sub', p::text, false);
  v_req := publish_request('Dijon', 5.0410, 47.3215, 'Chenôve', 5.0095, 47.2905, now() + interval '20 minutes', now() + interval '2 hours');
  v_m := propose_match(v_trip, v_req);
  perform set_config('request.jwt.claim.sub', d::text, false);
  perform respond_match(v_m, true);
  perform advance_match(v_m); perform advance_match(v_m); perform advance_match(v_m);
  if (select count(*) from notifications where user_id = d and kind = 'debt') <> 1 then raise exception 'ECHEC alerte de dette'; end if;
  if not (select blocked from cash_debt_status()) then raise exception 'ECHEC : dette au-delà du seuil non bloquante'; end if;
  delete from wallet_entries where user_id = d;
end $$;

-- Propositions : aller-retour relié, actions sur toute la proposition, historique des trajets réalisés.
do $$
declare d uuid := '00000000-0000-0000-0000-000000000001'; p uuid := '00000000-0000-0000-0000-00000000000a';
        a1 uuid; a2 uuid; r1 uuid; r2 uuid; v_round uuid := gen_random_uuid(); v_new uuid; v_res jsonb; n int;
begin
  perform set_config('request.jwt.claim.sub', d::text, false);
  a1 := publish_trip('Metz', 6.1757, 49.1193, 'Thionville', 6.1683, 49.3579, now() + interval '1 day', now() + interval '1 day 2 hours', 3, 0);
  r1 := publish_trip('Thionville', 6.1683, 49.3579, 'Metz', 6.1757, 49.1193, now() + interval '1 day 9 hours', now() + interval '1 day 11 hours', 3, 0);
  a2 := publish_trip('Metz', 6.1757, 49.1193, 'Thionville', 6.1683, 49.3579, now() + interval '2 days', now() + interval '2 days 2 hours', 3, 0);
  r2 := publish_trip('Thionville', 6.1683, 49.3579, 'Metz', 6.1757, 49.1193, now() + interval '2 days 9 hours', now() + interval '2 days 11 hours', 3, 0);
  perform set_round(array[a1, r1, a2, r2], v_round, array[r1, r2]);
  if (select count(*) from trips where round_id = v_round) <> 4 or (select count(*) from trips where round_id = v_round and is_return) <> 2 then
    raise exception 'ECHEC aller-retour non relié';
  end if;
  -- Une date modifiée garde son aller-retour
  v_new := replace_trip(r2, 'Thionville', 6.1683, 49.3579, 'Metz', 6.1757, 49.1193, now() + interval '2 days 10 hours', now() + interval '2 days 12 hours', 3, 0);
  if not (select round_id = v_round and is_return from trips where id = v_new) then raise exception 'ECHEC modification hors aller-retour'; end if;
  -- Toute la proposition : suspendre puis supprimer
  v_res := listings_action(array[a1, r1, a2, v_new], 'pause');
  if (v_res ->> 'done')::int <> 4 then raise exception 'ECHEC suspension groupée : %', v_res; end if;
  v_res := listings_action(array[a1, r1, a2, v_new], 'cancel');
  if (v_res ->> 'done')::int <> 4 or exists (select 1 from trips where round_id = v_round and status <> 'cancelled') then
    raise exception 'ECHEC suppression groupée : %', v_res;
  end if;
  -- Les dates d'un autre ne bougent pas
  perform set_config('request.jwt.claim.sub', p::text, false);
  if (listings_action(array[a1], 'resume') ->> 'done')::int <> 0 then raise exception 'ECHEC : action sur les dates d''un autre'; end if;
  -- Historique : les trajets terminés du scénario
  select count(*) into n from my_history('passenger', 50);
  if n = 0 then raise exception 'ECHEC historique passager vide'; end if;
  perform set_config('request.jwt.claim.sub', d::text, false);
  if not exists (select 1 from my_history('driver', 50) where cents is not null and jsonb_array_length(people) >= 1) then
    raise exception 'ECHEC historique conducteur';
  end if;
end $$;

\echo 'TOUS LES TESTS PASSENT'
