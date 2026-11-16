# CovoitGo — socle MVP

Appli de covoiturage du quotidien : fenêtres horaires souples, propositions automatiques
au conducteur, points et badges. Pas de paiement dans le MVP.

## Structure

- `supabase/migrations/0001_socle.sql` : base Supabase (Postgres + PostGIS), matching, RPC, RLS.
  À coller dans le SQL Editor de Supabase. Ne pas exécuter `supabase/tests/` sur un vrai projet.
- `supabase/migrations/0006_assistance_trajet_en_cours.sql`, `0007_emails.sql` : assistance limitée aux trajets en cours ; e-mails (préférences, déclencheur).
- `supabase/functions/send-email/` : fonction Edge qui envoie les e-mails via Resend (trajet confirmé, trajet terminé) et gère le désabonnement.
- `supabase/templates/` : modèles des e-mails de compte, à coller dans Supabase Auth (`confirmation.html`, `magic_link.html`, `recovery.html`, `email_change.html`). Ils affichent tous le code `{{ .Token }}`, saisi dans l'appli.
- `supabase/tests/run.sh` : tests de la migration sur un Postgres 16 + PostGIS local jetable.
- `supabase/migrations/0002_experience.sql` : notifications, étapes de trajet, téléphone privé, anti-doublons.
- `supabase/migrations/0003_avis.sql` : avis (étoiles + commentaire), note moyenne, parcours mené par le conducteur seul.
- `supabase/migrations/0004_places_vehicule.sql` : nombre de places et commentaire sur une demande, véhicule du conducteur.
- `supabase/migrations/0005_depart_assistance.sql` : trajet parti masqué, trajet terminé clos, réclamations (assistance).
- `src/` : PWA React + TypeScript (Vite), en deux modes Conducteur / Passager :
  - `App.tsx` : session, choix du mode, cloche de notifications (temps réel + relève toutes les 20 s).
  - `Home.tsx` : accueil du mode (réponses à donner, trajets confirmés, annonces et personnes compatibles).
  - `MatchCard.tsx` : trajet confirmé avec étapes en direct et coordonnées de l'autre personne.
  - `PublishForm.tsx` : publier un trajet ou une recherche (heure + marge de flexibilité).
  - `Profile.tsx` : niveau, points, badges, téléphone.
  - `geo.ts` : adresses et itinéraire via les services IGN (Géoplateforme).

Parcours : proposer → accepter (trajet confirmé, coordonnées visibles) → le conducteur part → arrive →
termine le trajet (points crédités) → chacun note l'autre (1 à 5 étoiles, commentaire facultatif).

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

## E-mails

- Expéditeur : `CovoitGo <covoitgo@paceapp.fr>`, réponses vers `contact@paceapp.fr` (domaine vérifié dans Resend).
- La fonction `send-email` a besoin du secret `RESEND_API_KEY` (Supabase → Edge Functions → Secrets).
- L'adresse de la fonction est lue dans la table `app_settings`, clé `email_function_url` ; sans cette ligne, aucun e-mail ne part.
- Chaque e-mail porte un lien de désabonnement et les en-têtes `List-Unsubscribe` (désabonnement en un clic).
