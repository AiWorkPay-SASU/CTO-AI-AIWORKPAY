# Recette reproductible — 12 scénarios

Commande : `NODE_PATH=<dossier avec playwright> npm run check`. Chaque ligne indique si le test est **réel** (processus, git, navigateur, PostgreSQL réels) ou **simulé** (double d'API). Les agents Claude sont toujours des doubles scriptés dans les tests (aucune dépense), sauf la démonstration historique `docs/DEMO_EVIDENCE.md`.

| # | Scénario | Test | Nature |
|---|---|---|---|
| 1 | Succès complet | `test/cto.test.js` (« full loop… »), `test/migrations.test.js` (rejeu) | git réel, agents scriptés |
| 2 | Plusieurs corrections | `test/cto.test.js` (« review keeps failing: rework is bounded… »), `test/github.test.js` (CI en échec → rework → même PR) | git réel, agents scriptés |
| 3 | Échec d'agent | `test/migrations.test.js` (crash → blocage → reprise), `test/reliability.test.js` D6 | agents scriptés |
| 4 | Dépassement de budget empêché | `test/cto.test.js` (« budget: the CTO stops… »), `test/hardening.test.js` (réservations), `test/reliability.test.js` D2 | réel (logique) |
| 5 | Redémarrage du CTO | `test/recette.test.js` (SIGKILL d'un processus worker, reprise par un nouveau processus) | **processus réel tué** |
| 6 | Deux workers concurrents | `test/recette.test.js`, `test/reliability.test.js` D2 | réel (store fichier + PostgREST simulé) |
| 7 | Annulation | `test/cto.test.js` (« cancellation aborts… »), `test/migrations.test.js` | réel (logique) |
| 8 | Rejet d'approbation | `test/cto.test.js` (« approval rules… »), `test/e2e.test.js` | réel |
| 9 | Détection de secret | `test/cto.test.js` (« forbidden paths and secrets in the diff are rejected »), `test/workspace.test.js` | git réel |
| 10 | Modification de fichier interdit | `test/cto.test.js` (même test que ci-dessus), `test/workspace.test.js` (« forbidden paths are detected ») | git réel |
| 11 | CI en échec | `test/github.test.js` | **API GitHub simulée**, remote git réel |
| 12 | Récupération après expiration de lease | `test/reliability.test.js` D1, `test/recette.test.js` | réel |

Navigateur : `test/e2e.test.js` (Chromium headless réel, 5 tests). Base : `test/migrations.test.js` (PostgreSQL 16 local réel, pas Supabase).

## Non exécuté ici (ignoré et signalé)
- Isolation bubblewrap positive : `bwrap` indisponible dans cet environnement ; échec fermé vérifié séparément, mais l'isolation réelle reste à prouver sur un hôte avec bubblewrap (CI l'exige).
- Supabase live (`test/supabase-live.test.js`) : pas d'identifiants.
- GitHub réel et CI réelle : non exécutés.
