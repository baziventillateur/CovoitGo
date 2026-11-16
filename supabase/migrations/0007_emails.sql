-- =====================================================================
-- E-mails : trajet confirmé et trajet terminé (récapitulatif).
-- La base prévient la fonction « send-email », qui envoie via Resend.
-- =====================================================================

-- Préférence d'envoi + jeton de désabonnement (lien en pied d'e-mail).
create table public.email_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  enabled boolean not null default true,
  token   uuid not null unique default gen_random_uuid()
);
alter table public.email_prefs enable row level security;
revoke all on public.email_prefs from anon, authenticated;
grant select (user_id, enabled) on public.email_prefs to authenticated;
create policy email_prefs_self on public.email_prefs for select to authenticated
  using (user_id = (select auth.uid()));

create function public.set_email_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  insert into email_prefs (user_id, enabled) values (auth.uid(), coalesce(p_enabled, true))
  on conflict (user_id) do update set enabled = excluded.enabled;
end $$;
revoke execute on function public.set_email_enabled(boolean) from public, anon;
grant execute on function public.set_email_enabled(boolean) to authenticated;

-- Une notification n'est envoyée par e-mail qu'une seule fois.
alter table public.notifications add column emailed_at timestamptz;

-- Réglages internes (aucun accès côté appli) : adresse de la fonction d'envoi.
create table public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

-- pg_net n'existe que sur Supabase : sans lui (tests locaux), aucun e-mail ne part.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

create function public._email_hook() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url text;
begin
  if new.kind not in ('accepted', 'completed') then return new; end if;
  select value into v_url from app_settings where key = 'email_function_url';
  if v_url is null then return new; end if;
  begin
    -- Seul l'identifiant part : la fonction relit tout en base, rien n'est cru sur parole.
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('notification_id', new.id),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  exception when others then
    null;  -- un souci d'e-mail ne doit jamais bloquer l'appli
  end;
  return new;
end $$;
revoke execute on function public._email_hook() from public, anon, authenticated;

create trigger notifications_email after insert on public.notifications
  for each row execute function public._email_hook();
