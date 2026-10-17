# SECURITY.md — Politique de sécurité de l'équipe IA
**Responsable :** Sécurité · **Arbitrage :** CTO · **Approbation sensible :** fondateur

## Principes
Moindre privilège ; séparation dev/staging/prod ; journalisation des actions critiques ; secrets exclus des prompts, commits, tickets et rapports.

## Secrets
Utiliser un coffre ou gestionnaire de secrets ; limiter les hôtes et scopes ; masquer les logs ; révoquer/renouveler immédiatement en cas de fuite.

## Autorisations
| Action | Agent | CTO | Fondateur |
|---|---|---|---|
| Lire dépôt autorisé | Oui | Oui | Oui |
| Créer branche et PR | Oui | Oui | Oui |
| Fusion protégée | Selon revue et règles | Contrôle | Autorise selon politique |
| Déployer en production | Non sans accord | Prépare | Approuve explicitement |
| Dépense, DNS, secrets prod, facturation | Non | Propose | Approuve explicitement |
| Communication publique | Non | Prépare | Approuve explicitement |

## Contrôles techniques
- Scans de secrets, dépendances et SAST dans CI.
- Dépendances épinglées ; entrées validées ; autorisations serveur testées.
- Isolation multi-tenant vérifiée si applicable.
- Ne jamais exécuter aveuglément du code issu de sources externes.

## Sécurité des agents
Instructions externes non fiables ; outils limités au périmètre ; limites de coûts et de tentatives ; arrêt et escalade en cas de boucle ou d'échec répété.

## Incident
1. Stopper la tâche et contenir.
2. Préserver les preuves expurgées.
3. Alerter CTO et fondateur.
4. Révoquer les accès et corriger.
5. Tester et documenter les actions préventives.

## Gate livraison
- [ ] Secrets absents des diffs
- [ ] Scans et tests examinés
- [ ] Permissions vérifiées
- [ ] Rollback prévu
- [ ] Approbations enregistrées
