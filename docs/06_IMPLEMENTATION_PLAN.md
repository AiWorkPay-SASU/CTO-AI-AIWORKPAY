# IMPLEMENTATION PLAN — Exécution multiagents
**Responsable :** CTO IA · **Arbitrages sensibles :** fondateur

## Entrées
PRD, TRD, App Flow, UI/UX, Backend Schema approuvés ; plafond de budget défini.

## Jalons
| Jalon | Livrable | Dépendances | Agent | Preuve |
|---|---|---|---|---|
| M0 | Spécifications | — | CTO | validations |
| M1 | Fondations et CI | M0 | DevOps | pipeline vert |
| M2 | MVP | M1 | Frontend/Backend | tests P0 |
| M3 | Qualité et sécurité | M2 | QA/Sec | rapports |
| M4 | Livraison | M3 + accord humain | DevOps | preuve et rollback |

## Contrat de mission
Chaque tâche comporte task_id, project_id, parent_task_id, agent, objectif, périmètre, dépendances, critères d'acceptation, budget, échéance, preuves, interdictions et validations.

## Concurrence
- Branche ou worktree dédié par tâche.
- Pas d'écriture concurrente non coordonnée sur un même fichier.
- Intégration par PR, revue et CI.
- Le CTO arbitre les conflits et dépendances.

## Cycle
BACKLOG → READY → ASSIGNED → IN_PROGRESS → REVIEW → DONE. Exceptions : BLOCKED, FAILED, CANCELLED.

## Rapport agent
```json
{"task_id":"TASK-001","status":"IN_PROGRESS","progress_note":"API créée, tests en cours","artifacts":["PR #12"],"tests":{"passed":12,"failed":0},"blockers":[],"next_action":"Tests d'intégration","requires_human_approval":false}
```

## Definition of Done
- [ ] Critères d'acceptation vérifiés
- [ ] Tests et scans réalisés
- [ ] Revue indépendante
- [ ] Documentation mise à jour
- [ ] CTO a consolidé les preuves
- [ ] Approbation humaine si nécessaire

## Escalade
Budget dépassé : arrêt et arbitrage. Incident sécurité : containment. Production : approbation explicite du fondateur.
