-- Mise en relation élargie : un passager dont le départ ou l'arrivée est jusqu'à 12 km de la route
-- du conducteur peut être proposé. C'est ensuite le détour réel (en minutes) qui décide de l'affichage.
-- Les définitions existantes sont reprises telles quelles, seul le rayon change.
do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public._match_candidates(integer,uuid,uuid)'::regprocedure);
  if v_def not like '%200), 3000))%' then raise exception 'Rayon de recherche introuvable'; end if;
  execute replace(v_def, '200), 3000))', '200), 12000))');

  v_def := pg_get_functiondef('public.propose_match(uuid,uuid)'::regprocedure);
  if v_def not like '%_match_candidates(3000,%' then raise exception 'Rayon de proposition introuvable'; end if;
  execute replace(v_def, '_match_candidates(3000,', '_match_candidates(12000,');

  v_def := pg_get_functiondef('public.traffic_detour_inputs(uuid,uuid,uuid[])'::regprocedure);
  if v_def not like '%_match_candidates(3000,%' then raise exception 'Rayon du détour introuvable'; end if;
  execute replace(v_def, '_match_candidates(3000,', '_match_candidates(12000,');
end $$;
