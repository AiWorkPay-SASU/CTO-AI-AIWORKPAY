# TRD — Technical Requirements Document
**Responsable :** Architecte · **Revue :** CTO et Sécurité

## Références
PRD : [lien] · Dépôt : [lien] · Environnements : dev/staging/prod

## Architecture
- Frontend : [framework/version]
- Backend : [framework/version]
- Base de données : [technologie]
- Hébergement : [fournisseur]
- Authentification : [solution]
- Stockage, files, observabilité : [solutions]
- Diagramme et ADR : [liens]

## Exigences non fonctionnelles
| ID | Domaine | Critère mesurable | Test |
|---|---|---|---|
| NFR-001 | Performance | [p95 / charge] | [méthode] |
| NFR-002 | Disponibilité | [objectif] | [méthode] |
| NFR-003 | Sécurité | [contrôle] | [audit] |

## Contrats techniques
| Service | Route/événement | Auth | Entrée | Sortie | Erreurs |
|---|---|---|---|---|---|
| [service] | [endpoint] | [scope] | [schéma] | [schéma] | [codes] |

## Exploitation
- Isolation des environnements et permissions : [stratégie]
- Migrations, sauvegardes, RPO/RTO : [stratégie]
- Idempotence, retries et gestion des erreurs : [stratégie]
- CI/CD : lint, typage, tests, scans, PR, rollback
- Coûts et limites : [budget]

## Validation
- [ ] PRD couvert
- [ ] Contrats cohérents
- [ ] Sécurité et résilience revues
- [ ] CTO approuve
