-- « Meilleurs créneaux » : comparaison de trois heures de départ, à la demande du conducteur.
-- Limite par personne et par jour, en plus du plafond global.
create table public.traffic_user_calls (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day     date not null,
  calls   integer not null default 0,
  primary key (user_id, day)
);
alter table public.traffic_user_calls enable row level security;
revoke all on public.traffic_user_calls from public, anon, authenticated;

create function public.traffic_reserve_slots(p_user uuid, p_n integer) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_n not between 1 and 3 or not exists (select 1 from profiles where id = p_user) then return false; end if;
  insert into traffic_user_calls as u (user_id, day, calls) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set calls = u.calls + 1 where u.calls < 6;
  if not found then return false; end if;
  insert into traffic_calls as c (day, calls) values (current_date, p_n)
  on conflict (day) do update set calls = c.calls + p_n where c.calls + p_n <= 2000;
  return found;
end $$;

revoke execute on function public.traffic_reserve_slots(uuid, integer) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.traffic_reserve_slots(uuid, integer) to service_role;
    grant all on public.traffic_user_calls to service_role;
  end if;
end $$;
