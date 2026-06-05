# Suivi des chantiers

Outil personnel et **autonome** (rien à voir avec l'entrepôt) pour piloter
plusieurs chantiers : Kanban, avancement par checklist, points bloquants, et
surtout suivi de **ce que tu attends des autres** (livrables).

## Lancer

Double-clic sur **`Suivi.bat`**.
- Au tout premier lancement, il crée l'environnement Python et installe la
  dépendance (`openpyxl`) — ça prend quelques secondes, une seule fois.
- Ensuite, il démarre le serveur en silence et ouvre la page dans le navigateur
  (`http://127.0.0.1:8765`).

Pour arrêter : ferme l'onglet et, si besoin, le processus `pythonw` (Gestionnaire
des tâches). En ligne de commande : `.venv\Scripts\python app.py`.

## Données

Tout est stocké dans **`data/store.json`** (sauvegarde après chaque
modification). Sauvegarde/copie ce fichier pour archiver. Au premier lancement
il contient des exemples fictifs — supprime-les depuis l'interface.

## Partage en lecture

Bouton **Exporter Excel** → classeur `suivi_chantiers.xlsx` avec deux onglets :
**Chantiers** (statut, avancement, priorité, échéance, blocage) et **Attentes**
(tout ce que tu attends, regroupé par personne). À envoyer tel quel.

## Fichiers

| Fichier | Rôle |
|---|---|
| `app.py` | Serveur local (statique + API JSON) |
| `store.py` | Lecture/écriture `store.json` + application des opérations |
| `export_xlsx.py` | Génération de l'Excel |
| `static/` | Interface (Kanban, drawer d'édition) |
| `data/store.json` | Tes données |
