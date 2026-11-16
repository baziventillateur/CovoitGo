# CovoitGo — socle MVP

Appli de covoiturage du quotidien : fenêtres horaires souples, propositions automatiques
au conducteur, points et badges. Pas de paiement dans le MVP.

## Structure

- `supabase/migrations/0001_socle.sql` : base Supabase (Postgres + PostGIS), matching, RPC, RLS.
  À coller dans le SQL Editor de Supabase. Ne pas exécuter `supabase/tests/` sur un vrai projet.
- `supabase/tests/run.sh` : tests de la migration sur un Postgres 16 + PostGIS local jetable.
- `supabase/migrations/0002_experience.sql` : notifications, étapes de trajet, téléphone privé, anti-doublons.
- `src/` : PWA React + TypeScript (Vite), en deux modes Conducteur / Passager :
  - `App.tsx` : session, choix du mode, cloche de notifications (temps réel + relève toutes les 20 s).
  - `Home.tsx` : accueil du mode (réponses à donner, trajets confirmés, annonces et personnes compatibles).
  - `MatchCard.tsx` : trajet confirmé avec étapes en direct et coordonnées de l'autre personne.
  - `PublishForm.tsx` : publier un trajet ou une recherche (heure + marge de flexibilité).
  - `Profile.tsx` : niveau, points, badges, téléphone.
  - `geo.ts` : adresses et itinéraire via les services IGN (Géoplateforme).

Parcours : proposer → accepter (trajet confirmé, coordonnées visibles) → le conducteur part → arrive →
le passager confirme qu'il est à bord → le conducteur termine (points crédités).

## Lancer en local

```bash
npm install
cp .env.example .env.local   # puis renseigner VITE_SUPABASE_ANON_KEY
npm run dev
```

Build de production : `npm run build` (vérifie aussi les types), résultat dans `dist/`.

## Ce qui n'est pas encore testé

- L'interface v2 (deux modes, cloche, étapes) : compilée, à valider sur téléphone à deux comptes.
- L'appel à l'itinéraire IGN : en cas d'échec, le tracé retombe sur la ligne droite.

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
