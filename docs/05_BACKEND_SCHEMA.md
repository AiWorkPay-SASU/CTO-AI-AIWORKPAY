# BACKEND SCHEMA — Données, API et événements
**Responsable :** Backend/Architecte · **Revue :** Sécurité et CTO

## Périmètre
PRD/TRD : [liens] · SGBD : [nom/version] · Isolation clients : [stratégie]

## Entités
| Table | Clé | Colonnes | Index | Rétention |
|---|---|---|---|---|
| users | uuid | id, email, created_at | unique(email) | [durée] |
| [table] | [clé] | [colonnes/types] | [index] | [durée] |

## Relations et contraintes
- Cardinalités : [liste]
- UNIQUE, CHECK, FK : [liste]
- Suppressions et audit : [politique]
- RLS / autorisations serveur : [règles]
- Tests négatifs inter-clients : [scénarios]

## API-001
- Méthode/route : [endpoint]
- Authentification et scopes : [règle]
- Schémas entrée/sortie : [OpenAPI/JSON Schema]
- Erreurs : [codes]
- Idempotence, pagination, limites : [règles]

## Événements
| Événement | Producteur | Consommateur | Retry | Déduplication |
|---|---|---|---|---|
| [event] | [service] | [service] | [politique] | [clé] |

## Migrations et restauration
- Migrations : [procédure]
- Backfill et rollback : [procédure]
- Sauvegardes et tests de restauration : [preuves]

## Validation
- [ ] Relations et contraintes testées
- [ ] Permissions contrôlées
- [ ] API documentées
- [ ] Revue Sécurité + CTO
