# Intégration avec Open Cortex Code

Le CTO reste indépendant ; Open Cortex Code (`cortexAI-2025/open-cortex-code`, vue « Équipe IA ») l'appelle en HTTP serveur à serveur avec `CTO_ADMIN_TOKEN`
(jamais dans un navigateur). Contrat ajouté pour cette intégration :

- `POST /api/missions` accepte `external_ref` (clé d'idempotence, 8-128 car.) : un rejeu renvoie la mission existante (HTTP 200, `idempotent_replay:true`) et ne crée ni ne relance rien.
  `GET /api/missions?external_ref=…` permet de retrouver une mission acceptée dont la réponse a été perdue.
- `scope` (1-20 préfixes de chemins relatifs) : tout fichier modifié hors périmètre est rejeté par le CTO (arbre final inclus) et renvoyé en correction.
- `GET /api/runtime` : vérifications réelles (Linux, Node ≥ 20, CLI `claude`, test effectif de bubblewrap). Si elles échouent, les missions `approved`/`running` passent en `blocked` avec `BLOCKED: …` : aucun agent n'est lancé, rien n'est simulé. Désactivable par `CTO_PREFLIGHT=0` (Open Cortex refuse alors d'exécuter : isolation non vérifiée).
- `POST /api/missions/:id/resume` : libère une mission bloquée si le runtime est de nouveau valide et si aucune tâche n'a échoué définitivement (409 `BLOCKED` sinon). Sans effet sur une mission non bloquée.
- Le rapport expose `git` (branche, commit, base, fichiers, diffstat, `pushed:false`, `merged:false`), `cost_by_role`, `acceptance_tests`.
- Correctif : un fichier ajouté puis supprimé par l'agent lors d'une correction ne reste plus signalé comme modifié.

Preuve d'une exécution réelle : `docs/mission-pilote-cto.md` dans le dépôt Open Cortex Code.

## Démarrage et prérequis
`npm run setup:linux` installe bubblewrap (idempotent) et lance `npm run doctor` (Linux, Node ≥ 20, CLI `claude`, test réel de l'isolation ; code de sortie 1 = BLOCKED).
`.env.example` liste la configuration. Open Cortex fournit `scripts/team-up.sh` pour lancer les deux services. Certification complète : `docs/certification-equipe-ia.md` côté Open Cortex Code.
