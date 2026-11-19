-- Actions sur toute une série récurrente. Les dates passées et celles qui ont déjà
-- un passager confirmé ne sont jamais touchées : elles restent à gérer une par une.
create function public.series_action(p_series uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id   uuid;
  v_done integer := 0;
  v_kept integer := 0;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_action not in ('pause', 'resume', 'cancel', 'cancel_requests') then raise exception 'Action inconnue'; end if;

  if p_action = 'cancel_requests' then
    for v_id in select r.id from requests r
                 where r.series_id = p_series and r.passenger_id = auth.uid()
                   and r.status in ('open', 'matched') and r.window_end > now() loop
      if exists (select 1 from matches m where m.request_id = v_id and m.status = 'accepted') then
        v_kept := v_kept + 1;
      else
        perform cancel_request(v_id);
        v_done := v_done + 1;
      end if;
    end loop;
    return jsonb_build_object('done', v_done, 'kept', v_kept);
  end if;

  for v_id in select t.id from trips t
               where t.series_id = p_series and t.driver_id = auth.uid() and t.window_end > now()
                 and t.status = case p_action when 'pause' then 'open'::trip_status
                                              when 'resume' then 'paused'::trip_status
                                              else t.status end
                 and t.status in ('open', 'paused') loop
    if p_action <> 'resume' and exists (select 1 from matches m where m.trip_id = v_id and m.status = 'accepted') then
      v_kept := v_kept + 1;
      continue;
    end if;
    if p_action = 'pause' then perform pause_trip(v_id);
    elsif p_action = 'resume' then perform resume_trip(v_id);
    else perform cancel_trip(v_id);
    end if;
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('done', v_done, 'kept', v_kept);
end $$;
revoke execute on function public.series_action(uuid, text) from public, anon;
grant execute on function public.series_action(uuid, text) to authenticated;
