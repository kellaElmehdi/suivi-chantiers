# Suivi des chantiers

Outil local de pilotage de projets, pensé pour une personne qui mène **plusieurs
chantiers en parallèle** et doit rendre des comptes régulièrement.

Pas de compte à créer, pas de serveur distant, pas de base de données : un
script Python, un dossier `static/`, et toutes les données dans un unique
fichier JSON sur votre machine.

```
Double-clic sur Suivi.bat  →  http://127.0.0.1:8765
```

## Pourquoi

Les outils de gestion de projet demandent en général plus de saisie qu'ils ne
rendent de service, et les données partent chez un tiers. Ici, la contrainte de
départ était l'inverse : **saisir le strict minimum, et en tirer le maximum**.

Une tâche cochée alimente à la fois l'avancement, le planning, le Gantt, la
charge, le tableau de bord, la valeur acquise et le rapport hebdomadaire — sans
aucune ressaisie.

## Fonctionnalités

**Piloter**
- Tableau Kanban (à faire, en cours, bloqué, en recette, terminé) avec limite
  d'en-cours (WIP) configurable
- Planning calculé automatiquement (CPM) : dates au plus tôt, chemin critique,
  marges, jours ouvrés, jours fériés et absences
- Diagramme de Gantt planifié contre réalisé, avec référence figée (baseline)
- Charge et capacité, avec suggestions de lissage

**Suivre**
- Livrables attendus des autres : qui doit quoi, pour quand, avec relances
- Registre de risques coté 5×5 (probabilité × gravité), catalogue de risques
  types inclus
- Recette par itérations : retours, priorités, statuts
- Cahier des charges par chantier : document rédigeable, indices de révision,
  cycle de validation
- Chronomètre intégré et récapitulatif « Ma journée »

**Rendre compte**
- Tableau de bord : indicateurs, valeur acquise (EVM : SPI, CPI, EAC, VAC)
- Journal d'activité alimenté automatiquement à chaque action
- **Rapport hebdomadaire** : le bilan de la semaine est construit tout seul à
  partir des données déjà saisies (tâches terminées, jalons franchis, notes,
  temps passé, relances, retours de recette), ainsi que le programme à venir.
  Il ne reste qu'à rédiger l'analyse : synthèse, avancement par chantier, retour
  d'expérience et priorités. Export PDF sobre avec Gantt du portefeuille,
  répartition du temps et bloc de visa.
- Import et export Excel

## Installation

**Prérequis :** Python 3.10 ou plus récent. Sur Windows, `Suivi.bat` s'occupe du
reste (création de l'environnement virtuel et installation de la dépendance au
premier lancement).

```bash
git clone <url-du-depot> suivi
cd suivi
python -m venv .venv
.venv/bin/pip install -r requirements.txt   # Windows : .venv\Scripts\pip
.venv/bin/python app.py                     # ouvre http://127.0.0.1:8765
```

Au premier lancement, l'application crée un jeu de données **fictif** (migration
Power BI, dédoublonnage clients…) pour que l'interface soit immédiatement
parlante. Supprimez-le depuis l'interface quand vous voulez commencer pour de
bon.

## Vos données

Tout est stocké dans **`data/store.json`**, sauvegardé de façon atomique après
chaque modification. Ce dossier est exclu du dépôt Git : vos données ne partent
jamais nulle part. Pour archiver ou déménager, copiez simplement ce fichier.

Le serveur n'écoute que sur `127.0.0.1` et refuse les requêtes de modification
venant d'une autre origine.

## Architecture

Aucun framework, aucune étape de compilation, une seule dépendance externe
(`openpyxl`, uniquement pour Excel).

| Fichier | Rôle |
|---|---|
| `app.py` | Serveur HTTP local (fichiers statiques + API JSON) |
| `store.py` | Modèle de données, validation, application des opérations |
| `export_xlsx.py` | Import et export Excel |
| `rapport_mail.py` | Rapport en PDF (Edge headless) et envoi par e-mail |
| `static/app.js` | Interface complète (JavaScript natif) |
| `data/store.json` | Vos données (hors dépôt) |

Le serveur expose une API volontairement minimale : toute modification passe par
une opération nommée envoyée à `POST /api/mutate`, et une seule fonction
(`store.apply_op`) les applique. La validation est donc centralisée. Le planning
— dates, chemin critique, marges — est recalculé côté interface à partir des
durées et des dépendances.

## Contribuer

Les propositions sont bienvenues. Le projet suit deux principes :

1. **Aucune saisie redondante.** Si une information peut être déduite de données
   déjà présentes, elle doit l'être.
2. **Rien à installer.** Pas de dépendance qui imposerait un `npm install` ou un
   moteur de base de données.

## Licence

Apache 2.0 — voir le fichier [LICENSE](LICENSE).
