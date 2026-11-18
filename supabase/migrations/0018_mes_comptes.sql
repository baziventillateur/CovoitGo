-- « Mes comptes » : trajets terminés avec le montant convenu, reçus (conducteur) ou dépensés (passager).
create function public.my_money()
returns table (match_id uuid, role text, at timestamptz, cents integer, from_label text, to_label text)
language sql stable security definer set search_path = public, extensions as $$
  select m.id,
         case when m.driver_id = auth.uid() then 'driver' else 'passenger' end,
         m.updated_at,
         coalesce(m.price_cents, t.cost_share_cents, 0),
         r.origin_label, r.dest_label
    from matches m
    join trips t on t.id = m.trip_id
    join requests r on r.id = m.request_id
   where m.status = 'completed' and auth.uid() in (m.driver_id, m.passenger_id)
   order by m.updated_at desc
   limit 500
$$;
revoke execute on function public.my_money() from public, anon;
grant execute on function public.my_money() to authenticated;
