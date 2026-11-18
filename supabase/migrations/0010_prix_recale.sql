-- Barème recalé : proche des applis de covoiturage urbain à la demande, légèrement en dessous.
--   1,50 € de base + 0,40 €/km jusqu'à 20 km, 0,30 €/km de 20 à 60 km, 0,15 €/km au-delà.
--   Exemples : 5 km 3,50 € · 10 km 5,50 € · 23 km 10,50 € · 50 km 18,50 € · 100 km 27,50 €.
create or replace function public.price_for_km(p_km numeric) returns integer
language sql immutable as $$
  select greatest(250, (round((
           150
           + 40 * least(greatest(p_km, 0), 20)
           + 30 * least(greatest(p_km - 20, 0), 40)
           + 15 * greatest(p_km - 60, 0)
         ) / 50.0) * 50)::int)
$$;
