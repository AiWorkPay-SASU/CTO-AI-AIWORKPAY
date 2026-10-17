# APP FLOW — Parcours utilisateurs
**Responsable :** Product + UX · **Validation :** CTO

## Acteurs
| Rôle | Objectif | Permissions |
|---|---|---|
| [rôle] | [objectif] | [permissions] |

## Parcours général
```mermaid
flowchart TD
 A[Entrée] --> B{Authentifié ?}
 B -->|Non| C[Connexion]
 B -->|Oui| D[Tableau de bord]
 C --> D
 D --> E[Action principale]
 E --> F{Succès ?}
 F -->|Oui| G[Confirmation]
 F -->|Non| H[Erreur et reprise]
```

## Fiche FLOW-001
- Déclencheur : [action]
- Préconditions : [état]
- Étapes : [liste]
- Variantes : [cas]
- Erreurs et reprise : [cas]
- Résultat attendu : [sortie]
- Exigences PRD : [IDs]

## Écrans
| ID | Écran | Rôle | Actions | États |
|---|---|---|---|---|
| SCR-001 | [nom] | [rôle] | [actions] | vide/chargement/erreur/succès |

## Validation
- [ ] Parcours P0 couverts
- [ ] Erreurs et retours arrière documentés
- [ ] Session expirée, hors ligne, droits insuffisants traités
- [ ] CTO valide
