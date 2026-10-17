# TASKS.md — Registre des missions

Le registre persistant de l'orchestrateur fera autorité ; ce fichier est une vue lisible ou un mode manuel provisoire. Éviter les modifications simultanées.

| ID | Projet | Mission | Agent | Statut | Dépendances | Branche/PR | Validation | Mise à jour |
|---|---|---|---|---|---|---|---|---|
| TASK-001 | CTO-AI-AIWORKPAY- | MVP v0.2: orchestrateur, 4 agents réels (architect, backend, QA, sécurité), file durable, MissionControl, tests | claude (session) | REVIEW | — | feat/cto-mvp-v1 / PR #1 | Fondateur | 2026-10-17 |
| TASK-002 | CTO-AI-AIWORKPAY- | Projet Supabase de dev dédié + application/test de la migration (RLS) | — | BLOCKED | TASK-001 | — | Fondateur (coût) | 2026-10-17 |
| TASK-003 | CTO-AI-AIWORKPAY- | Authentification par utilisateur + TLS avant tout hébergement | — | BACKLOG | TASK-001 | — | Fondateur | 2026-10-17 |

## États
BACKLOG, READY, ASSIGNED, IN_PROGRESS, BLOCKED, REVIEW, DONE, FAILED, CANCELLED.

## Fiche mission
- ID / Projet / Dépôt : [valeurs]
- Créateur / Agent responsable : [valeurs]
- Priorité : P0/P1/P2
- Objectif et périmètre autorisé : [description]
- Hors périmètre et dépendances : [description]
- Critères d'acceptation : [tests]
- Budget temps/tokens/coût : [limites]
- Branche / PR / Preuves : [liens]
- Dernier rapport / Blocages : [état]
- Approbation requise : [CTO/fondateur/aucune]

## Règles
Responsable unique par tâche ; remontée immédiate des blocages ; DONE uniquement après revue et critères vérifiés ; preuves conservées.

## Rapport quotidien CTO
Réalisations vérifiées ; tâches en cours ; blocages ; décisions demandées ; budget consommé ; priorités des prochaines 24 heures.
