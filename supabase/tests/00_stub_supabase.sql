-- Imite le strict nécessaire de Supabase pour tester la migration sur un Postgres local.
create schema if not exists extensions;
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create table auth.users (id uuid primary key default gen_random_uuid(), raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, extensions, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
alter database covoit_test set search_path = public, extensions;
