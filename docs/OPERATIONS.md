# Installation et exploitation

## Prérequis
Node ≥ 20, git ; Linux + `bubblewrap` pour exécuter les tests des agents (obligatoire, échec fermé sinon). Aucune dépendance npm à l'exécution.

## Démarrage
`npm start` (voir README). Variables : `CTO_OWNER_TOKEN`, `CTO_VIEWER_TOKEN`, magasin (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` ou fichier), `CTO_REPOS` (JSON projet→clone local, liste blanche stricte), `CTO_GITHUB_TOKEN` + `CTO_ALLOWED_REPOS` (optionnels).

## Base de données
Appliquer `supabase/migrations/001`, `002`, `003` dans l'ordre, **uniquement** sur un projet Supabase de développement dédié au CTO, jamais sur ZEEROO ni une base métier. Les migrations sont idempotentes. Ne pas exposer la clé service role à un navigateur ni à un agent.

## Cycle d'une mission
Création → approbation « mission » → analyse (architecte) → approbation « architecture » → exécution (backend) → relectures indépendantes (QA, sécurité) → approbation « completion ». Le CTO relance lui-même les tests ; l'avis d'un agent ne vaut jamais preuve. Après escalade (`blocked`), le propriétaire peut `POST /resume` (nouvelle tentative) ou relever le budget.

## GitHub
`POST /api/missions/:id/pr` pousse la branche `cto/…` (fast-forward, jamais forcé) et ouvre une PR **brouillon**. `POST /ci` lit les checks ; un échec renvoie le travail en correction (borné), jamais de fusion automatique. La fusion et le déploiement restent des décisions du fondateur.

## Tests
`npm run check`. Variables d'exigence CI : `CTO_REQUIRE_SANDBOX_TESTS`, `CTO_REQUIRE_BROWSER_TESTS`, `CTO_REQUIRE_PG_TESTS` (sans elles, les tests indisponibles sont ignorés avec raison explicite). Navigateur : playwright via `NODE_PATH`.

## Limites connues
Voir README (« Limitations ») et `docs/AUDIT_2026-10-26.md` : authentification par jetons statiques, pas de TLS intégré, agents Frontend/DevOps absents, intégrations live (Supabase, GitHub, CI, bubblewrap) non validées dans cet environnement.
