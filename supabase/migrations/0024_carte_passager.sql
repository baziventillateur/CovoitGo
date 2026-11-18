-- Carte du trajet d'un passager, pour le conducteur : point de montée, point de dépose, et son propre tracé.
-- Tant qu'aucune mise en relation n'existe entre eux, les points sont volontairement approximatifs
-- (ramenés à une grille d'environ 400 m) : l'adresse précise n'est pas dévoilée à un simple candidat.
create function public.request_map(p_trip_id uuid, p_request_id uuid)
returns table (a_lng double precision, a_lat double precision, b_lng double precision, b_lat double precision,
               exact boolean, trip_route text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  t       trips;
  v_exact boolean;
begin
  select * into t from trips where id = p_trip_id and driver_id = auth.uid();
  if not found then raise exception 'Trajet introuvable'; end if;
  v_exact := exists (select 1 from matches m
                      where m.trip_id = p_trip_id and m.request_id = p_request_id and m.status in ('proposed', 'accepted'));
  if not v_exact and not exists (select 1 from _match_candidates(12000, p_trip_id, p_request_id)) then
    raise exception 'Ce passager n''est pas sur ta route';
  end if;
  return query
    select case when v_exact then st_x(r.origin::geometry) else round(st_x(r.origin::geometry) / 0.005) * 0.005 end,
           case when v_exact then st_y(r.origin::geometry) else round(st_y(r.origin::geometry) / 0.0035) * 0.0035 end,
           case when v_exact then st_x(r.destination::geometry) else round(st_x(r.destination::geometry) / 0.005) * 0.005 end,
           case when v_exact then st_y(r.destination::geometry) else round(st_y(r.destination::geometry) / 0.0035) * 0.0035 end,
           v_exact,
           st_asgeojson(st_simplifypreservetopology(t.route::geometry, 0.0003))
      from requests r where r.id = p_request_id;
end $$;
revoke execute on function public.request_map(uuid, uuid) from public, anon;
grant execute on function public.request_map(uuid, uuid) to authenticated;
