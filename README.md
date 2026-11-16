# CovoitGo — socle MVP

Appli de covoiturage du quotidien : fenêtres horaires souples, propositions automatiques
au conducteur, points et badges. Pas de paiement dans le MVP.

## Ce qui est en place

`supabase/migrations/0001_socle.sql` — base Supabase (Postgres + PostGIS) :

- **Trajets et demandes avec fenêtre de départ** (« entre 9h et 12h ») au lieu d'une heure fixe.
- **Matching sans API payante** : le tracé est enregistré une fois par trajet, puis la
  correspondance se fait en base (montée et descente à moins de 1 km du tracé, même sens,
  fenêtres qui se chevauchent, place disponible).
- **Deux sens de recherche** : `find_trips_for_request` (passager) et
  `find_requests_for_trip` (propositions automatiques au conducteur).
- **Cycle de vie** : `propose_match` → `respond_match` → `confirm_match` (les deux personnes
  confirment) ; `cancel_match`, `cancel_trip`, `cancel_request`.
- **Points et badges** : 15 points conducteur, 10 passager par trajet confirmé, plafonné à
  4 trajets récompensés par jour ; badges à 1, 10 et 50 trajets.
- **Sécurité** : RLS partout, aucune écriture directe sur les tables, adresses et horaires
  visibles uniquement après mise en relation.

## Tester

```bash
./supabase/tests/run.sh   # Postgres 16 + PostGIS en local, base jetable
```

## Briques retenues

| Besoin | Brique | Coût |
|---|---|---|
| Base, auth, temps réel | Supabase + PostGIS | 0 € puis 25 $/mois |
| Adresses (autocomplétion, géocodage) | API Géoplateforme IGN (`data.geopf.fr/geocodage`) | gratuit, 50 req/s par IP |
| Itinéraire (tracé du trajet) | API Géoplateforme IGN — calcul d'itinéraire | gratuit (limites à vérifier) |
| Carte | MapLibre (`maplibre-gl` web, `@maplibre/maplibre-react-native` mobile) | gratuit hors tuiles |
| Référence métier | Mobicoop Platform (AGPLv3) — à lire, pas à copier | — |
| Plus tard : financement employeur | Registre de preuve de covoiturage (`betagouv/preuve-covoiturage`) | — |

## Suite

1. Écran publier / chercher + carte, branchés sur les RPC.
2. Edge Function « tracé » : appelle l'itinéraire IGN à la publication.
3. Défis de groupe (entreprise / zone) et récompenses partenaires.
4. Habitudes apprises à partir de l'historique des trajets.
