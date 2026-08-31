# Suivi des chantiers

Outil local de pilotage de projets, pensé pour une personne qui mène **plusieurs
chantiers en parallèle** et doit rendre des comptes régulièrement.

Pas de compte à créer, pas de serveur distant, pas de base de données : un
script Python, un dossier `static/`, et toutes les données dans un unique
fichier JSON sur votre machine.

```
Double-clic sur Suivi.bat  →  http://127.0.0.1:8765
```

> **Côté technique** — cet outil est le seul du parc à ne dépendre d'aucune machine,
> d'aucun partage et d'aucun compte. Le détail : [`_liens/VM.md`](_liens/VM.md).
> Le parc complet : [`c:\projets\_commun\vm\`](../_commun/vm/).

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
  d'en-cours (WIP) configurable. La colonne suit le travail sans qu'on ait à la
  poser : une recette ouverte met le chantier **en recette**, 100 % des tâches
  faites le mettent **terminé**, et rouvrir une tâche ou un point le fait
  repartir **en cours** (« bloqué » reste, lui, entièrement calculé)
- Planning calculé automatiquement (CPM) : dates au plus tôt, chemin critique,
  marges, jours ouvrés, jours fériés et absences
- Diagramme de Gantt planifié contre réalisé, avec référence figée (baseline)
- Charge et capacité, avec suggestions de lissage

**Organiser**
- **Thèmes** : une liste **fermée de 10 au maximum**, choisie dans un menu et
  jamais en saisie libre. C'est la maille transverse : chantiers, actions, notes
  et temps passé se rangent dans les mêmes cases, donc « combien de temps sur ce
  sujet, tous chantiers confondus » devient une question à laquelle l'outil
  répond. La limite est volontaire — c'est elle qui empêche la liste de redevenir
  un nuage d'étiquettes inutilisable.
- **Actions** : les tâches libres et les routines vivent dans **une seule liste**,
  parce qu'une routine n'est qu'une action avec une règle de répétition. Capture
  en une ligne (`Relancer Karim #ERP !h vendredi 15m`), regroupement par horizon
  (en retard / aujourd'hui / cette semaine / plus tard / sans échéance),
  chronomètre sur chaque action.
- **Routines à occurrences** : une occurrence ratée ne disparaît pas. Elle reste
  à acter — *rattrapée*, *sautée volontairement* ou *ratée* — et alimente un taux
  de tenue réel. Sauter n'est pas rater, et la distinction est conservée.
- **Bloc-notes** : un journal horodaté à la saisie (date **et** heure), classé par
  thème, rattachable à un chantier — où il devient son historique. Une note se
  transforme en action en un clic : c'est le flux compte-rendu → décisions.

**Suivre**
- Livrables attendus des autres : qui doit quoi, pour quand, avec relances
- Registre de risques coté 5×5 (probabilité × gravité), catalogue de risques
  types inclus
- Cahier des charges par chantier : document rédigeable, indices de révision,
  cycle de validation
  - **Aller-retour Word** : le bouton `Word` télécharge le cahier des charges en
    `.docx`, on le retouche dans Word, `Réimporter Word` le relit. Le document
    porte l'identifiant du chantier et ceux de ses sections dans ses propriétés,
    invisibles à l'écran : le texte retombe donc au bon endroit même si un titre
    a bougé. Une section ajoutée dans Word est créée, une section supprimée
    disparaît.
  - Le bouton `Imprimer / PDF` produit la **même charte** que le Word : cartouche
    d'en-tête répété sur chaque page, page Pilotage,
    sections formatées. Dans la boîte d'impression, laisser les marges par
    défaut et décocher « En-têtes et pieds de page » du navigateur.
  - Le `.docx` applique **le design system NSN Industrie**
    ([`c:\projets\ID visuel`](../ID%20visuel/DESIGN-nsn.md)) : bandeau encre
    RFF répété sur chaque page (marque, N° CDC, indice, `Page X / Y`),
    titrage Bahnschrift
    condensé en capitales, corps Segoe UI `#33555F`, données en Consolas,
    tableaux `IDENTIFICATION` / `LISTE DES RÉVISIONS` à en-tête sur fond
    `#E5EBEC`, filets horizontaux `#CFD8DB`, angles à 0, aucune ombre, table des
    matières Word native. Les capitales sont posées par la propriété Word
    `w:caps`, jamais par transformation du texte — c'est ce qui garde
    l'aller-retour fidèle au caractère près. Si la charte évolue, la référence
    est `ID visuel/DESIGN-nsn.md` + `maquette-rapport.html`.
  - **Un import qui change quelque chose EST une révision** : l'indice courant
    est figé en instantané, l'indice passe au suivant, la validation retombe, et
    la ligne de révision dit ce qui a bougé (« Import Word — 2 modifiée(s)… »).
    Un document réimporté sans modification ne crée rien et le dit.
  - Si Word est en suivi de modifications, c'est **l'état final** qui est relu :
    le texte supprimé mais non accepté n'est pas repris.
- **Recette** : la liste des points à vérifier avant de dire « c'est livré ».
  Délibérément pauvre — **trois états** (à vérifier, vérifié, problème) et rien
  d'autre à tenir à jour. Un point qui coince porte son constat, qui corrige et
  pour quand ; il n'y a pas de registre d'anomalies séparé à maintenir en double.
  - Les points se choisissent dans une **liste type** par domaine (données,
    reporting, interfaces, compta, application métier, atelier, accès, mise en
    service) : on coche, on n'écrit pas. Une checklist qu'il faut rédiger ne se
    rédige jamais.
  - **Un point se pilote exactement comme une tâche** : `▶ Démarrer` lance le
    chrono sur *ce* point, `⏹ Terminer` l'arrête et le marque vérifié, et le
    temps s'affiche sur la ligne. Même contrôle, même geste, même code couleur
    que le plan de tâches et que les actions — il n'y a qu'une chose à
    apprendre. On sait donc ce que chaque vérification a coûté, et ce que la
    recette a coûté en tout.
  - Le chrono s'arrête seul quand tout est vérifié.
  - Quand tout est vérifié, l'appli le dit et propose de passer le chantier en
    « Terminé ». C'est la seule cérémonie de clôture.
  - Vue **Recette** transverse : l'avancement de chaque chantier, ce qui coince
    (avec qui corrige et pour quand), et le temps passé.
- Chronomètre intégré et récapitulatif « Ma journée ». Le temps hors chantier se
  ventile par thème au lieu de tomber dans un unique bloc « divers ».

**Raccourcis clavier** — la capture doit coûter moins qu'un post-it :
`a` nouvelle action · `n` nouvelle note · `c` nouveau chantier · `t` tableau ·
`p` planning · `d` tableau de bord · `s` arrêter le chrono · `/` ou `Ctrl+K`
rechercher (chantiers, personnes, risques, points de recette, actions et notes).

**Rendre compte**
- Tableau de bord : indicateurs, valeur acquise (EVM : SPI, CPI, EAC, VAC)
- Journal d'activité alimenté automatiquement à chaque action
- **Rapport hebdomadaire** : le bilan de la semaine est construit tout seul à
  partir des données déjà saisies (tâches terminées, jalons franchis, notes,
  temps passé, relances, points de recette), ainsi que le programme à venir.
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
