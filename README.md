# CovoitGo — socle MVP

Appli de covoiturage du quotidien : fenêtres horaires souples, propositions automatiques
au conducteur, points et badges. Pas de paiement dans le MVP.

## Structure

- `supabase/migrations/0001_socle.sql` : base Supabase (Postgres + PostGIS), matching, RPC, RLS.
  À coller dans le SQL Editor de Supabase. Ne pas exécuter `supabase/tests/` sur un vrai projet.
- `supabase/tests/run.sh` : tests de la migration sur un Postgres 16 + PostGIS local jetable.
- `src/` : PWA React + TypeScript (Vite) :
  - `Auth.tsx` : inscription et connexion (le pseudo part dans les métadonnées, le profil est créé par trigger).
  - `Trips.tsx` : « Je conduis » (publier un trajet, proposer aux passagers compatibles) et « Je cherche » (publier une demande, demander une place).
  - `Matches.tsx` : mises en relation, acceptation, confirmation des deux côtés, annulation.
  - `Profile.tsx` : points et badges.
  - `geo.ts` : adresses et itinéraire via les services IGN (Géoplateforme).

## Lancer en local

```bash
npm install
cp .env.example .env.local   # puis renseigner VITE_SUPABASE_ANON_KEY
npm run dev
```

Build de production : `npm run build` (vérifie aussi les types), résultat dans `dist/`.

## Ce qui n'est pas encore testé

- Les appels réels aux services IGN (adresse et itinéraire) : à valider depuis un navigateur.
- Le parcours complet à deux comptes dans l'appli (le SQL, lui, est testé).

## Briques retenues

| Besoin | Brique | Coût |
|---|---|---|
| Base, auth, temps réel | Supabase + PostGIS (région Paris) | 0 € puis 25 $/mois |
| Adresses | Géoplateforme IGN, géocodage | gratuit, 50 req/s par IP |
| Itinéraire (tracé) | Géoplateforme IGN, calcul d'itinéraire | gratuit, limites à vérifier |
| Référence métier | Mobicoop Platform (AGPLv3) : à lire, pas à copier | — |
| Plus tard : financement employeur | `betagouv/preuve-covoiturage` | — |

## Suite

1. Carte MapLibre pour afficher les trajets.
2. Défis de groupe (entreprise, zone) et récompenses partenaires.
3. Habitudes apprises à partir de l'historique des trajets.
4. Déploiement de la PWA et test à deux comptes.
