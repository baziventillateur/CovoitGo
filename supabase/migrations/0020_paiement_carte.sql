-- Paiement par carte ou en espèces, frais de service, crédit du porte-monnaie, remboursement.

-- Frais de service : 0,35 € + 5 % du prix, arrondis à 5 centimes. Déduits de ce que reçoit le conducteur.
create function public.service_fee(p_cents integer) returns integer
language sql immutable as $$
  select case when coalesce(p_cents, 0) <= 0 then 0
              else least(p_cents, (round((35 + 0.05 * p_cents) / 5.0) * 5)::int) end
$$;

alter table public.requests
  add column pay_method text not null default 'cash' check (pay_method in ('cash', 'card'));
alter table public.matches
  add column pay_method text not null default 'cash' check (pay_method in ('cash', 'card')),
  add column fee_cents integer not null default 0,
  add column checkout_session_id text,
  add column payment_intent_id text,
  add column paid_at timestamptz,
  add column refunded_at timestamptz;

-- Le passager choisit son mode de paiement, tant que rien n'est confirmé.
create function public.set_request_pay_method(p_request_id uuid, p_method text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_method not in ('cash', 'card') then raise exception 'Mode de paiement inconnu'; end if;
  update requests set pay_method = p_method
   where id = p_request_id and passenger_id = auth.uid() and status = 'open';
  if not found then raise exception 'Demande introuvable'; end if;
  update matches set pay_method = p_method where request_id = p_request_id and status = 'proposed';
end $$;

-- À la création d'une mise en relation : mode de paiement de la demande et frais figés avec le prix.
create function public._match_payment_defaults() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  select r.pay_method into new.pay_method from requests r where r.id = new.request_id;
  new.fee_cents := service_fee(new.price_cents);
  return new;
end $$;
create trigger matches_payment_defaults before insert on public.matches
  for each row execute function public._match_payment_defaults();

-- Trajet payé par carte : le conducteur ne part pas tant que le passager n'a pas payé.
create function public._match_paid_before_start() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if old.stage = 'scheduled' and new.stage <> 'scheduled' and new.pay_method = 'card' and new.paid_at is null then
    raise exception 'Le passager n''a pas encore payé par carte : attends son paiement avant de partir';
  end if;
  return new;
end $$;
create trigger matches_paid_before_start before update of stage on public.matches
  for each row execute function public._match_paid_before_start();

-- Suites d'un changement de statut : invitation à payer, crédit du porte-monnaie, remboursement.
create function public._match_payment_events() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url text;
begin
  if new.status = 'accepted' and old.status <> 'accepted' and new.pay_method = 'card' and new.paid_at is null then
    insert into notifications (user_id, role, kind, title, body, match_id)
    values (new.passenger_id, 'passenger', 'pay', 'Paie ton trajet',
            'Ton trajet est accepté. Règle-le par carte pour le confirmer : ton chauffeur partira ensuite.', new.id);
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    if new.pay_method = 'card' and new.paid_at is not null and new.refunded_at is null
       and coalesce(new.price_cents, 0) - new.fee_cents > 0 then
      insert into wallet_entries (user_id, kind, cents, match_id)
      values (new.driver_id, 'ride', new.price_cents - new.fee_cents, new.id);
    elsif new.pay_method = 'cash' and new.fee_cents > 0 then
      insert into wallet_entries (user_id, kind, cents, match_id)
      values (new.driver_id, 'cash_fee', -new.fee_cents, new.id);
    end if;
  end if;

  if new.status in ('cancelled', 'declined') and old.status not in ('cancelled', 'declined')
     and new.paid_at is not null and new.refunded_at is null then
    select value into v_url from app_settings where key = 'refund_function_url';
    if v_url is not null then
      begin
        perform net.http_post(url := v_url, body := jsonb_build_object('match_id', new.id),
                              headers := '{"Content-Type": "application/json"}'::jsonb);
      exception when others then null;
      end;
    end if;
  end if;
  return new;
end $$;
create trigger matches_payment_events after update of status on public.matches
  for each row execute function public._match_payment_events();

-- ---- Fonctions réservées au serveur ----------------------------------------
create function public.match_pay_info(p_match_id uuid, p_user uuid)
returns table (role text, status text, pay_method text, price_cents integer, paid boolean,
               checkout_session_id text, from_label text, to_label text)
language sql stable security definer set search_path = public, extensions as $$
  select case when m.passenger_id = p_user then 'passenger' else 'driver' end, m.status::text, m.pay_method,
         coalesce(m.price_cents, 0), m.paid_at is not null, m.checkout_session_id, r.origin_label, r.dest_label
    from matches m join requests r on r.id = m.request_id
   where m.id = p_match_id and p_user in (m.passenger_id, m.driver_id)
$$;

create function public.match_checkout_save(p_match_id uuid, p_session text) returns void
language sql security definer set search_path = public, extensions as $$
  update matches set checkout_session_id = p_session where id = p_match_id and paid_at is null
$$;

create function public.match_mark_paid(p_match_id uuid, p_payment_intent text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
begin
  update matches set paid_at = now(), payment_intent_id = p_payment_intent
   where id = p_match_id and paid_at is null returning * into m;
  if not found then return false; end if;
  insert into notifications (user_id, role, kind, title, body, match_id)
  values (m.driver_id, 'driver', 'paid', 'Trajet payé',
          'Ton passager a payé par carte. Tu peux partir à l''heure prévue.', m.id);
  -- Payé alors que le trajet n'est plus d'actualité : remboursement.
  if m.status in ('cancelled', 'declined') then
    update matches set status = status where id = m.id;
  end if;
  return true;
end $$;

-- Remboursement : réservé une seule fois ; relâché si Stripe échoue.
create function public.match_refund_claim(p_match_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_pi text;
begin
  update matches set refunded_at = now()
   where id = p_match_id and status in ('cancelled', 'declined') and paid_at is not null
     and refunded_at is null and payment_intent_id is not null
  returning payment_intent_id into v_pi;
  return v_pi;
end $$;

create function public.match_refund_release(p_match_id uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update matches set refunded_at = null where id = p_match_id
$$;

create function public.match_refund_notify(p_match_id uuid) returns void
language sql security definer set search_path = public, extensions as $$
  insert into notifications (user_id, role, kind, title, body, match_id)
  select m.passenger_id, 'passenger', 'refund', 'Trajet remboursé',
         'Ton paiement par carte est remboursé. Il revient sur ton compte sous quelques jours.', m.id
    from matches m where m.id = p_match_id
$$;

revoke execute on function public._match_payment_defaults(), public._match_paid_before_start(),
  public._match_payment_events(), public.match_pay_info(uuid, uuid), public.match_checkout_save(uuid, text),
  public.match_mark_paid(uuid, text), public.match_refund_claim(uuid), public.match_refund_release(uuid),
  public.match_refund_notify(uuid) from public, anon, authenticated;
revoke execute on function public.set_request_pay_method(uuid, text) from public, anon;
grant execute on function public.set_request_pay_method(uuid, text), public.service_fee(integer) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.match_pay_info(uuid, uuid), public.match_checkout_save(uuid, text),
      public.match_mark_paid(uuid, text), public.match_refund_claim(uuid), public.match_refund_release(uuid),
      public.match_refund_notify(uuid) to service_role;
  end if;
end $$;
