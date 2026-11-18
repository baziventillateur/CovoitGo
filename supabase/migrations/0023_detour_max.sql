-- Détour maximum accepté par le conducteur pour passer prendre un passager : 15 min par défaut, entre 5 et 30.
create table public.driver_settings (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  max_detour_min integer not null default 15 check (max_detour_min between 5 and 30)
);
alter table public.driver_settings enable row level security;
revoke all on public.driver_settings from public, anon, authenticated;
grant select on public.driver_settings to authenticated;
create policy driver_settings_read on public.driver_settings for select to authenticated
  using (user_id = (select auth.uid()));

create function public.set_max_detour(p_minutes integer) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v integer := least(30, greatest(5, coalesce(p_minutes, 15)));
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  insert into driver_settings (user_id, max_detour_min) values (auth.uid(), v)
  on conflict (user_id) do update set max_detour_min = excluded.max_detour_min;
  return v;
end $$;
revoke execute on function public.set_max_detour(integer) from public, anon;
grant execute on function public.set_max_detour(integer) to authenticated;
