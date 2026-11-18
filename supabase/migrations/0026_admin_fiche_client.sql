-- Panel admin : fiche complète d'un compte (identité, activité, mises en relation, avis, argent, réclamations).
create function public.admin_user_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v jsonb;
begin
  if not is_admin() then raise exception 'Accès réservé'; end if;
  select jsonb_build_object(
    'id', p.id, 'name', p.display_name, 'email', u.email, 'points', p.points, 'created_at', p.created_at,
    'phone', (select pp.phone from profile_private pp where pp.user_id = p.id),
    'last_seen_at', um.last_seen_at, 'installed', um.installed_at is not null,
    'blocked', exists (select 1 from user_blocks b where b.user_id = p.id),
    'block_reason', (select b.reason from user_blocks b where b.user_id = p.id),
    'admin', exists (select 1 from admins a where a.user_id = p.id),
    'push', exists (select 1 from push_subscriptions s where s.user_id = p.id),
    'emails', coalesce((select e.enabled from email_prefs e where e.user_id = p.id), true),
    'vehicle', (select jsonb_build_object('model', v2.model, 'color', v2.color, 'plate', v2.plate) from vehicles v2 where v2.user_id = p.id),
    'max_detour', (select d.max_detour_min from driver_settings d where d.user_id = p.id),
    'payout_ready', coalesce((select pa.payouts_enabled from payout_accounts pa where pa.user_id = p.id), false),
    'rating', (select round(avg(x.rating), 1) from reviews x where x.target_id = p.id),
    'wallet', (select coalesce(sum(w.cents), 0) from wallet_entries w where w.user_id = p.id),
    'earned', (select coalesce(sum(m.price_cents - m.fee_cents), 0) from matches m where m.driver_id = p.id and m.status = 'completed'),
    'spent', (select coalesce(sum(m.price_cents), 0) from matches m where m.passenger_id = p.id and m.status = 'completed'),
    'fees', (select coalesce(sum(m.fee_cents), 0) from matches m where m.driver_id = p.id and m.status = 'completed'),
    'trips', coalesce((select jsonb_agg(x order by x.at desc) from (
        select t.created_at as at, t.origin_label || ' → ' || t.dest_label as label, t.window_start as "when",
               t.status::text as status, t.cost_share_cents as cents, t.seats, t.seats_taken
          from trips t where t.driver_id = p.id order by t.created_at desc limit 100) x), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(x order by x.at desc) from (
        select r.created_at as at, r.origin_label || ' → ' || r.dest_label as label, r.window_start as "when",
               r.status::text as status, r.pay_method, r.seats
          from requests r where r.passenger_id = p.id order by r.created_at desc limit 100) x), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(x order by x.at desc) from (
        select m.updated_at as at, m.created_at as created_at,
               case when m.driver_id = p.id then 'driver' else 'passenger' end as role,
               o.id as other_id, o.display_name as other_name,
               m.proposed_by = p.id as proposed_by_me,
               m.status::text as status, m.stage::text as stage,
               r.origin_label || ' → ' || r.dest_label as label,
               m.price_cents as cents, m.fee_cents, m.pay_method, m.paid_at is not null as paid, m.refunded_at is not null as refunded
          from matches m
          join requests r on r.id = m.request_id
          join profiles o on o.id = case when m.driver_id = p.id then m.passenger_id else m.driver_id end
         where p.id in (m.driver_id, m.passenger_id) order by m.updated_at desc limit 200) x), '[]'::jsonb),
    'reviews_given', coalesce((select jsonb_agg(x order by x.at desc) from (
        select rv.created_at as at, o.id as other_id, o.display_name as other_name, rv.rating, rv.comment
          from reviews rv join profiles o on o.id = rv.target_id where rv.author_id = p.id order by rv.created_at desc limit 100) x), '[]'::jsonb),
    'reviews_received', coalesce((select jsonb_agg(x order by x.at desc) from (
        select rv.created_at as at, o.id as other_id, o.display_name as other_name, rv.rating, rv.comment
          from reviews rv join profiles o on o.id = rv.author_id where rv.target_id = p.id order by rv.created_at desc limit 100) x), '[]'::jsonb),
    'wallet_entries', coalesce((select jsonb_agg(x order by x.at desc) from (
        select w.created_at as at, w.kind, w.cents from wallet_entries w where w.user_id = p.id order by w.created_at desc limit 100) x), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(x order by x.at desc) from (
        select c.created_at as at, c.category, c.message, c.status from claims c where c.author_id = p.id order by c.created_at desc limit 50) x), '[]'::jsonb)
  ) into v
  from profiles p
  join auth.users u on u.id = p.id
  left join user_meta um on um.user_id = p.id
  where p.id = p_user;
  if v is null then raise exception 'Compte introuvable'; end if;
  return v;
end $$;
revoke execute on function public.admin_user_detail(uuid) from public, anon;
grant execute on function public.admin_user_detail(uuid) to authenticated;
