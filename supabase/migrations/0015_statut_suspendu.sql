-- Nouveau statut : trajet suspendu (invisible pour les passagers, conservé par le conducteur).
alter type public.trip_status add value if not exists 'paused';
