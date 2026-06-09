"""Stockage JSON du suivi des chantiers + application des operations.

Une seule fonction `apply_op` mute le store ; elle est utilisee par l'edition
de l'interface (UI -> /api/mutate), ce qui centralise la validation.

Modele :
- chantier : titre, statut, prio, echeance, date_debut (debut planning), objectif,
  blocage, tags[], parties[], taches[], livrables[], histo[].
- tache : id, label, done, done_date, duree (jours), preds[] (ids de taches du
  meme chantier), is_milestone (jalon = duree 0). Le planning (dates, chemin
  critique, marges) est CALCULE cote interface a partir de duree+preds (CPM).
- livrable : ce que l'utilisateur attend d'une personne (statut, date, relances...).
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import date, datetime

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STORE_PATH = os.path.join(DATA_DIR, "store.json")

STATUTS = {"todo", "doing", "block", "recette", "done"}
PRIOS = {"h", "m", "b"}
LIV_STATUTS = {"attente", "recu", "partiel", "annule"}
RETOUR_STATUTS = {"a_traiter", "en_cours", "fait", "rejete"}
RISQUE_STATUTS = {"ouvert", "maitrise", "avere", "clos"}   # cote / maitrise / avere / clos


def _uid(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:8]


def _clamp15(v, default=3) -> int:
    """Ramene proba/gravite sur l'echelle 1..5 (cotation 5x5)."""
    try:
        return min(5, max(1, int(v)))
    except (TypeError, ValueError):
        return default


def today() -> str:
    return date.today().isoformat()


# --------------------------------------------------------------------------- #
# Journal d'actions (suivi de progression hebdo). Chaque mutation y dépose une
# ligne horodatée — le message lisible est déjà produit par _apply_op.
# --------------------------------------------------------------------------- #
JOURNAL_SKIP = {"set_settings"}   # simples réglages : pas une "action" à tracer
JOURNAL_MAX = 3000                # garde les N dernières lignes


def _iso_week(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _journal(store: dict, op: dict, msg: str) -> None:
    name = op.get("op")
    if name in JOURNAL_SKIP:
        return
    now = datetime.now()
    cid = op.get("chantier_id") or op.get("id") or ""
    titre = ""
    if cid:
        ch = next((c for c in store.get("chantiers", []) if c.get("id") == cid), None)
        if ch:
            titre = ch.get("titre", "")
    j = store.setdefault("journal", [])
    j.append({"ts": now.isoformat(timespec="seconds"), "date": now.date().isoformat(),
              "week": _iso_week(now.date()), "op": name,
              "chantier_id": cid, "chantier": titre, "msg": msg})
    if len(j) > JOURNAL_MAX:
        del j[:len(j) - JOURNAL_MAX]


# --------------------------------------------------------------------------- #
# Donnees de demarrage (fictives) — a vider via l'UI quand tu veux.
# --------------------------------------------------------------------------- #
def _seed() -> dict:
    return {
        "version": 2,
        "contacts": [
            {"id": "c_marc", "nom": "Marc", "role": "DSI"},
            {"id": "c_sophie", "nom": "Sophie", "role": "Achats"},
            {"id": "c_karim", "nom": "Karim", "role": "IT SILOG"},
            {"id": "c_dircom", "nom": "Direction commerciale", "role": "Commerce"},
        ],
        "chantiers": [
            {
                "id": "ch_pbi", "titre": "Migration Power BI v2", "statut": "doing",
                "prio": "h", "echeance": "2026-06-20", "date_debut": "2026-05-26",
                "objectif": "Refondre les rapports Power BI sur le nouveau modele gold et republier aux directions.",
                "blocage": "Acces passerelle Power BI non ouvert (Marc, DSI).",
                "tags": ["Power BI", "Gold"],
                "parties": [
                    {"id": "p1", "nom": "Controle de gestion", "role": "Recette"},
                    {"id": "p2", "nom": "Direction", "role": "Destinataire"},
                ],
                "taches": [
                    {"id": "t1", "label": "Recabler le modele gold", "done": True,
                     "done_date": "2026-05-29", "duree": 3, "preds": [], "is_milestone": False},
                    {"id": "t2", "label": "Mesures DAX marge", "done": True,
                     "done_date": "2026-06-02", "duree": 2, "preds": ["t1"], "is_milestone": False},
                    {"id": "t3", "label": "Refaire les 6 pages de rapport", "done": True,
                     "done_date": "2026-06-04", "duree": 5, "preds": ["t1"], "is_milestone": False},
                    {"id": "t4", "label": "Recette avec le controle de gestion", "done": False,
                     "done_date": None, "duree": 2, "preds": ["t2", "t3"], "is_milestone": False},
                    {"id": "t5", "label": "Publication passerelle", "done": False,
                     "done_date": None, "duree": 0, "preds": ["t4"], "is_milestone": True},
                ],
                "livrables": [
                    {"id": "l1", "contact_id": "c_marc", "personne": "Marc", "role": "DSI",
                     "quoi": "Ouvrir l'acces passerelle Power BI", "date": "2026-06-02",
                     "statut": "attente", "relances": 2, "derniere": "2026-06-03",
                     "impact": "Bloque la publication des rapports."},
                    {"id": "l2", "contact_id": "c_sophie", "personne": "Sophie", "role": "Achats",
                     "quoi": "Valider le mapping fournisseurs", "date": "2026-06-15",
                     "statut": "attente", "relances": 0, "derniere": None, "impact": ""},
                ],
                "histo": [
                    {"d": "2026-05-28", "t": "Modele gold valide, refonte lancee."},
                    {"d": "2026-06-01", "t": "Acces passerelle demande a Marc."},
                    {"d": "2026-06-03", "t": "Relance Marc, sans reponse."},
                ],
                "risques": [
                    {"id": "rk_pbi1", "libelle": "Acces passerelle non ouvert a temps",
                     "categorie": "Dependance/IT", "probabilite": 4, "gravite": 5,
                     "parade": "Escalade DSI + plan B : publication manuelle temporaire.",
                     "responsable": "Marc", "echeance_revue": "2026-06-15",
                     "statut": "ouvert", "tache_id": "t5"},
                    {"id": "rk_pbi2", "libelle": "Ecarts de marge detectes en recette",
                     "categorie": "Qualite", "probabilite": 2, "gravite": 4,
                     "parade": "Double calcul DAX vs warehouse avant publication.",
                     "responsable": "Controle de gestion", "echeance_revue": "2026-06-10",
                     "statut": "ouvert", "tache_id": None},
                ],
                "ordre": 0,
            },
            {
                "id": "ch_silver", "titre": "Audit couche Silver", "statut": "block",
                "prio": "h", "echeance": "2026-06-12", "date_debut": "2026-05-20",
                "objectif": "Verifier la completude des factures d'achat SILOG manquantes avant fiabilisation des marges.",
                "blocage": "Export SILOG FAFE/FAFC non livre par l'IT.",
                "tags": ["Silver", "SILOG"],
                "parties": [{"id": "p1", "nom": "IT SILOG", "role": "Fournit l'export"}],
                "taches": [
                    {"id": "t1", "label": "Cartographier les tables FAFE/FAFC", "done": True,
                     "done_date": "2026-05-22", "duree": 2, "preds": [], "is_milestone": False},
                    {"id": "t2", "label": "Obtenir l'export IT", "done": False,
                     "done_date": None, "duree": 3, "preds": ["t1"], "is_milestone": False},
                    {"id": "t3", "label": "Recharger en bronze", "done": False,
                     "done_date": None, "duree": 1, "preds": ["t2"], "is_milestone": False},
                    {"id": "t4", "label": "Controler la parite", "done": False,
                     "done_date": None, "duree": 2, "preds": ["t3"], "is_milestone": False},
                    {"id": "t5", "label": "Rapport d'ecart livre", "done": False,
                     "done_date": None, "duree": 0, "preds": ["t4"], "is_milestone": True},
                ],
                "livrables": [
                    {"id": "l1", "contact_id": "c_karim", "personne": "Karim", "role": "IT SILOG",
                     "quoi": "Fournir l'export des tables FAFE / FAFC", "date": "2026-05-30",
                     "statut": "attente", "relances": 3, "derniere": "2026-06-02",
                     "impact": "Bloque tout l'audit."},
                ],
                "histo": [
                    {"d": "2026-05-20", "t": "Demande d'export envoyee a Karim."},
                    {"d": "2026-06-02", "t": "3e relance. Karim invoque une priorite serveur."},
                ],
                "risques": [
                    {"id": "rk_slv1", "libelle": "Export SILOG FAFE/FAFC jamais livre par l'IT",
                     "categorie": "Dependance/IT", "probabilite": 4, "gravite": 4,
                     "parade": "Reconstruire les factures d'achat depuis BDRE (recption) en plan B.",
                     "responsable": "Karim", "echeance_revue": "2026-06-10",
                     "statut": "avere", "tache_id": "t2"},
                ],
                "ordre": 1,
            },
            {
                "id": "ch_secteur", "titre": "Refonte mapping secteur client", "statut": "doing",
                "prio": "m", "echeance": "2026-06-18", "date_debut": "2026-06-01",
                "objectif": "Reclasser les clients par marche final (defense, nucleaire, ferroviaire, energie).",
                "blocage": "", "tags": ["Gold", "Commerce"],
                "parties": [{"id": "p1", "nom": "Direction commerciale", "role": "Arbitrage"}],
                "taches": [
                    {"id": "t1", "label": "Regles de nom", "done": True, "done_date": "2026-06-02",
                     "duree": 2, "preds": [], "is_milestone": False},
                    {"id": "t2", "label": "Croisement NAF + categorie SILOG", "done": True,
                     "done_date": "2026-06-03", "duree": 2, "preds": ["t1"], "is_milestone": False},
                    {"id": "t3", "label": "Arbitrage des indetermines", "done": False,
                     "done_date": None, "duree": 3, "preds": ["t2"], "is_milestone": False},
                    {"id": "t4", "label": "Propagation sur les faits", "done": True,
                     "done_date": "2026-06-04", "duree": 1, "preds": ["t2"], "is_milestone": False},
                ],
                "livrables": [
                    {"id": "l1", "contact_id": "c_dircom", "personne": "Direction commerciale",
                     "role": "Commerce", "quoi": "Arbitrer les 25 clients marche indetermine",
                     "date": "2026-06-16", "statut": "attente", "relances": 1,
                     "derniere": "2026-06-03", "impact": ""},
                ],
                "histo": [{"d": "2026-06-03", "t": "Auto-classif : 92% du CA actif en confiance haute."}],
                "ordre": 2,
            },
            {
                "id": "ch_doc", "titre": "Documentation utilisateur Power BI", "statut": "todo",
                "prio": "b", "echeance": "2026-07-01", "date_debut": "2026-06-20",
                "objectif": "Rediger un guide d'utilisation des rapports pour les utilisateurs metier.",
                "blocage": "", "tags": ["Power BI", "Doc"], "parties": [],
                "taches": [
                    {"id": "t1", "label": "Plan du guide", "done": False, "done_date": None,
                     "duree": 1, "preds": [], "is_milestone": False},
                    {"id": "t2", "label": "Captures par page", "done": False, "done_date": None,
                     "duree": 2, "preds": ["t1"], "is_milestone": False},
                    {"id": "t3", "label": "Relecture metier", "done": False, "done_date": None,
                     "duree": 2, "preds": ["t2"], "is_milestone": False},
                ],
                "livrables": [], "histo": [], "ordre": 3,
            },
            {
                "id": "ch_dedup", "titre": "Dedoublonnage clients cross-entite", "statut": "done",
                "prio": "m", "echeance": "2026-05-30", "date_debut": "2026-05-23",
                "objectif": "Fusionner les doublons clients confirmes par le commerce.",
                "blocage": "", "tags": ["Clients"], "parties": [],
                "taches": [
                    {"id": "t1", "label": "Fichier de revue", "done": True, "done_date": "2026-05-25",
                     "duree": 2, "preds": [], "is_milestone": False},
                    {"id": "t2", "label": "Validation commerce", "done": True, "done_date": "2026-05-28",
                     "duree": 2, "preds": ["t1"], "is_milestone": False},
                    {"id": "t3", "label": "Override applique", "done": True, "done_date": "2026-05-30",
                     "duree": 1, "preds": ["t2"], "is_milestone": False},
                ],
                "livrables": [],
                "histo": [{"d": "2026-05-30", "t": "Override applique, 0 SIRET eclate. Termine."}],
                "ordre": 4,
            },
        ],
    }


# --------------------------------------------------------------------------- #
# Normalisation (compat ascendante : remplit les champs manquants)
# --------------------------------------------------------------------------- #
def _normalize(store: dict) -> dict:
    store.setdefault("contacts", [])
    store.setdefault("journal", [])
    s = store.setdefault("settings", {})
    s.setdefault("capacite_jour", 3)     # max taches actives par jour (global)
    s.setdefault("wip_max", 3)           # max chantiers "En cours" simultanes
    s.setdefault("jours_ouvres", True)   # planning en jours ouvres (exclut samedi/dimanche)
    s.setdefault("relance_jours", 7)     # relance suggeree apres N jours
    for c in store.get("chantiers", []):
        if c.get("statut") == "block":   # "Bloqué" est desormais calcule, plus un statut manuel
            c["statut"] = "doing"
        c.setdefault("date_debut", None)
        c.setdefault("objectif", "")
        c.setdefault("blocage", "")
        c.setdefault("tags", [])
        c.setdefault("parties", [])
        c.setdefault("livrables", [])
        c.setdefault("histo", [])
        c.setdefault("baseline", None)
        c.setdefault("baseline_edits", 0)
        for rk in c.setdefault("risques", []):       # registre de risques (proba x gravite 5x5)
            rk.setdefault("id", _uid("rk_"))
            rk.setdefault("libelle", "")
            rk.setdefault("categorie", "Autre")
            rk.setdefault("probabilite", 3)
            rk.setdefault("gravite", 3)
            rk.setdefault("parade", "")
            rk.setdefault("responsable", "")
            rk.setdefault("echeance_revue", None)
            rk.setdefault("statut", "ouvert")
            rk.setdefault("tache_id", None)
        for t in c.setdefault("taches", []):
            t.setdefault("done", False)
            t.setdefault("done_date", None)
            t.setdefault("is_milestone", False)
            t.setdefault("duree", 0 if t.get("is_milestone") else 1)
            t.setdefault("preds", [])
            t.setdefault("start_fix", None)
        for l in c["livrables"]:
            l.setdefault("tache_id", None)
        for p in c["parties"]:
            p.setdefault("id", _uid("p_"))
        for it in c.setdefault("iterations", []):
            it.setdefault("id", _uid("it_"))
            it.setdefault("num", 1)
            it.setdefault("ouverte", True)
            it.setdefault("date", None)
            it.setdefault("note", "")
            for r in it.setdefault("retours", []):
                r.setdefault("id", _uid("r_"))
                r.setdefault("de", "")
                r.setdefault("quoi", "")
                r.setdefault("statut", "a_traiter")
                r.setdefault("priorite", "m")
                r.setdefault("date", None)
                r.setdefault("echeance", None)
    return store


def load() -> dict:
    if not os.path.exists(STORE_PATH):
        os.makedirs(DATA_DIR, exist_ok=True)
        save(_seed())
    with open(STORE_PATH, "r", encoding="utf-8") as f:
        return _normalize(json.load(f))


def save(store: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STORE_PATH)


# --------------------------------------------------------------------------- #
# Helpers d'acces
# --------------------------------------------------------------------------- #
def _chantier(store: dict, cid: str) -> dict:
    for c in store["chantiers"]:
        if c["id"] == cid:
            return c
    raise ValueError(f"Chantier introuvable: {cid}")


def _sub(parent_list: list, sid: str, label: str) -> dict:
    for x in parent_list:
        if x["id"] == sid:
            return x
    raise ValueError(f"{label} introuvable: {sid}")


def _clean_preds(ch: dict, preds, self_id=None) -> list:
    """Garde uniquement des ids de taches existantes du chantier, != soi-meme."""
    ids = {t["id"] for t in ch["taches"]}
    out = []
    for p in (preds or []):
        if p in ids and p != self_id and p not in out:
            out.append(p)
    return out


def _unfinished_preds(ch: dict, t: dict) -> list:
    """Libelles des predecesseurs encore non termines (pour bloquer la cloture)."""
    by = {x["id"]: x for x in ch["taches"]}
    return [by[p]["label"] for p in t.get("preds", []) if p in by and not by[p]["done"]]


def _iteration(ch: dict, iid: str) -> dict:
    return _sub(ch.setdefault("iterations", []), iid, "Iteration")


# --------------------------------------------------------------------------- #
# Application d'une operation
# --------------------------------------------------------------------------- #
def apply_op(store: dict, op: dict) -> str:
    """Applique l'operation puis incremente le compteur de modifs post-reference
    si le chantier vise possede une reference figee."""
    msg = _apply_op(store, op)
    name = op.get("op")
    NON_EDIT = {"set_baseline", "clear_baseline", "set_settings", "add_contact",
                "rename_person", "remove_person", "set_person_role", "create_chantier",
                "delete_chantier", "add_risque", "update_risque", "remove_risque"}
    if name not in NON_EDIT:
        cid = op.get("chantier_id") or op.get("id")
        if cid:
            ch = next((c for c in store["chantiers"] if c["id"] == cid), None)
            if ch and ch.get("baseline"):
                ch["baseline_edits"] = ch.get("baseline_edits", 0) + 1
    _journal(store, op, msg)
    return msg


def _apply_op(store: dict, op: dict) -> str:
    name = op.get("op")

    if name == "create_chantier":
        titre = (op.get("titre") or "").strip()
        if not titre:
            raise ValueError("Titre requis pour creer un chantier.")
        statut = op.get("statut") or "todo"
        prio = op.get("prio") or "m"
        if statut not in STATUTS:
            raise ValueError(f"Statut invalide: {statut}")
        if prio not in PRIOS:
            raise ValueError(f"Priorite invalide: {prio}")
        taches = []
        for lbl in (op.get("taches") or []):
            lbl = (lbl or "").strip()
            if lbl:
                taches.append({"id": _uid("t_"), "label": lbl, "done": False, "done_date": None,
                               "duree": 1, "preds": [], "is_milestone": False, "start_fix": None})
        ch = {
            "id": _uid("ch_"), "titre": titre, "statut": statut, "prio": prio,
            "echeance": op.get("echeance") or None,
            "date_debut": op.get("date_debut") or today(),
            "objectif": (op.get("objectif") or "").strip(),
            "blocage": "", "tags": [], "parties": [], "taches": taches,
            "livrables": [], "histo": [], "iterations": [], "ordre": len(store["chantiers"]),
        }
        store["chantiers"].append(ch)
        return f"Chantier cree : « {titre} »"

    if name == "update_chantier":
        ch = _chantier(store, op["id"])
        changed = []
        for field in ("titre", "objectif", "blocage"):
            if field in op and op[field] is not None:
                ch[field] = op[field]; changed.append(field)
        if op.get("statut"):
            if op["statut"] not in STATUTS:
                raise ValueError(f"Statut invalide: {op['statut']}")
            ch["statut"] = op["statut"]; changed.append("statut")
        if op.get("prio"):
            if op["prio"] not in PRIOS:
                raise ValueError(f"Priorite invalide: {op['prio']}")
            ch["prio"] = op["prio"]; changed.append("priorite")
        if "echeance" in op:
            ch["echeance"] = op["echeance"] or None; changed.append("echeance")
        if "date_debut" in op:
            ch["date_debut"] = op["date_debut"] or None; changed.append("date_debut")
        return f"Chantier « {ch['titre']} » mis a jour ({', '.join(changed) or 'aucun champ'})"

    if name == "delete_chantier":
        ch = _chantier(store, op["id"])
        store["chantiers"] = [c for c in store["chantiers"] if c["id"] != op["id"]]
        return f"Chantier supprime : « {ch['titre']} »"

    if name == "move_chantier":
        ch = _chantier(store, op["id"])
        if op["statut"] not in STATUTS:
            raise ValueError(f"Statut invalide: {op['statut']}")
        ch["statut"] = op["statut"]
        if op["statut"] == "recette" and not ch["iterations"]:   # demarre l'iteration 1
            ch["iterations"].append({"id": _uid("it_"), "num": 1, "ouverte": True,
                                     "date": today(), "note": "", "retours": []})
        return f"« {ch['titre']} » deplace vers {op['statut']}"

    if name == "add_tache":
        ch = _chantier(store, op["chantier_id"])
        label = (op.get("label") or "").strip()
        if not label:
            raise ValueError("Label de tache requis.")
        is_ms = bool(op.get("is_milestone"))
        duree = 0 if is_ms else max(0, int(op.get("duree") or 1))
        t = {"id": _uid("t_"), "label": label, "done": False, "done_date": None,
             "duree": duree, "preds": [], "is_milestone": is_ms,
             "start_fix": op.get("start_fix") or None}
        t["preds"] = _clean_preds(ch, op.get("preds"), t["id"])
        ch["taches"].append(t)
        return f"Tache ajoutee a « {ch['titre']} » : {label}"

    if name == "toggle_tache":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        new_done = bool(op.get("done", not t["done"]))
        if new_done and not t["done"]:
            miss = _unfinished_preds(ch, t)
            if miss:
                raise ValueError(f"Impossible de terminer « {t['label']} » : "
                                 f"prédécesseur(s) non terminé(s) : {', '.join(miss)}.")
        t["done"] = new_done
        t["done_date"] = (op.get("done_date") or today()) if t["done"] else None
        return f"Tache « {t['label']} » -> {'faite' if t['done'] else 'a faire'}"

    if name == "update_tache":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        if op.get("label"):
            t["label"] = op["label"]
        if "is_milestone" in op:
            t["is_milestone"] = bool(op["is_milestone"])
            if t["is_milestone"]:
                t["duree"] = 0
        if "duree" in op and not t["is_milestone"]:
            t["duree"] = max(0, int(op["duree"] or 0))
        if "start_fix" in op:
            t["start_fix"] = op["start_fix"] or None
        if "preds" in op:
            t["preds"] = _clean_preds(ch, op["preds"], t["id"])
        if "done" in op:
            new_done = bool(op["done"])
            if new_done and not t["done"]:
                miss = _unfinished_preds(ch, t)
                if miss:
                    raise ValueError(f"Impossible de terminer « {t['label']} » : "
                                     f"prédécesseur(s) non terminé(s) : {', '.join(miss)}.")
            t["done"] = new_done
            t["done_date"] = (op.get("done_date") or today()) if t["done"] else None
        return f"Tache mise a jour dans « {ch['titre']} »"

    if name == "remove_tache":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        ch["taches"] = [x for x in ch["taches"] if x["id"] != op["tache_id"]]
        for o in ch["taches"]:  # nettoie les references
            o["preds"] = [p for p in o.get("preds", []) if p != op["tache_id"]]
        for l in ch["livrables"]:  # delie les livrables qui pointaient cette tache
            if l.get("tache_id") == op["tache_id"]:
                l["tache_id"] = None
        return f"Tache supprimee : {t['label']}"

    if name == "add_livrable":
        ch = _chantier(store, op["chantier_id"])
        quoi = (op.get("quoi") or "").strip()
        personne = (op.get("personne") or "").strip()
        if not quoi or not personne:
            raise ValueError("Livrable : 'personne' et 'quoi' requis.")
        statut = op.get("statut") or "attente"
        if statut not in LIV_STATUTS:
            raise ValueError(f"Statut livrable invalide: {statut}")
        role = op.get("role") or ""
        cid = op.get("contact_id")
        if cid:
            ct = _sub(store["contacts"], cid, "Contact")
            personne, role = ct["nom"], ct.get("role", role)
        ch["livrables"].append({
            "id": _uid("l_"), "contact_id": cid, "personne": personne, "role": role,
            "quoi": quoi, "date": op.get("date") or None, "statut": statut,
            "relances": 0, "derniere": None, "impact": op.get("impact") or "",
            "tache_id": op.get("tache_id") or None,
        })
        return f"Livrable attendu de {personne} ajoute a « {ch['titre']} »"

    if name == "update_livrable":
        ch = _chantier(store, op["chantier_id"])
        lv = _sub(ch["livrables"], op["livrable_id"], "Livrable")
        if op.get("statut"):
            if op["statut"] not in LIV_STATUTS:
                raise ValueError(f"Statut livrable invalide: {op['statut']}")
            lv["statut"] = op["statut"]
        for field in ("quoi", "impact"):
            if field in op and op[field] is not None:
                lv[field] = op[field]
        if "date" in op:
            lv["date"] = op["date"] or None
        if "tache_id" in op:
            lv["tache_id"] = op["tache_id"] or None
        if "contact_id" in op:           # choisir un contact remplit nom + role
            lv["contact_id"] = op["contact_id"] or None
            if lv["contact_id"]:
                ct = _sub(store["contacts"], lv["contact_id"], "Contact")
                lv["personne"], lv["role"] = ct["nom"], ct.get("role", "")
        if "personne" in op and op["personne"] is not None:
            lv["personne"] = op["personne"]
        if "role" in op and op["role"] is not None:
            lv["role"] = op["role"]
        if op.get("relance"):
            lv["relances"] = lv.get("relances", 0) + 1
            lv["derniere"] = today()
        return f"Livrable « {lv['quoi']} » mis a jour (de {lv['personne']})"

    if name == "remove_livrable":
        ch = _chantier(store, op["chantier_id"])
        lv = _sub(ch["livrables"], op["livrable_id"], "Livrable")
        ch["livrables"] = [x for x in ch["livrables"] if x["id"] != op["livrable_id"]]
        return f"Livrable supprime : {lv['quoi']}"

    if name == "add_note":
        ch = _chantier(store, op["chantier_id"])
        texte = (op.get("texte") or "").strip()
        if not texte:
            raise ValueError("Texte de note requis.")
        ch["histo"].insert(0, {"d": op.get("date") or today(), "t": texte})
        return f"Note ajoutee a « {ch['titre']} »"

    if name == "add_partie":
        ch = _chantier(store, op["chantier_id"])
        nom = (op.get("nom") or "").strip()
        if not nom:
            raise ValueError("Nom de partie prenante requis.")
        ch["parties"].append({"id": _uid("p_"), "nom": nom, "role": op.get("role") or ""})
        return f"Partie prenante ajoutee a « {ch['titre']} » : {nom}"

    if name == "remove_partie":
        ch = _chantier(store, op["chantier_id"])
        ch["parties"] = [p for p in ch["parties"] if p["id"] != op["partie_id"]]
        return "Partie prenante retiree"

    if name == "add_tag":
        ch = _chantier(store, op["chantier_id"])
        tag = (op.get("tag") or "").strip()
        if tag and tag not in ch["tags"]:
            ch["tags"].append(tag)
        return f"Tag ajoute : {tag}"

    if name == "remove_tag":
        ch = _chantier(store, op["chantier_id"])
        ch["tags"] = [t for t in ch["tags"] if t != op.get("tag")]
        return "Tag retire"

    if name == "add_contact":
        nom = (op.get("nom") or "").strip()
        if not nom:
            raise ValueError("Nom de contact requis.")
        store["contacts"].append({"id": _uid("c_"), "nom": nom, "role": op.get("role") or ""})
        return f"Contact ajoute : {nom}"

    if name == "rename_person":   # renomme une personne partout (contacts + livrables)
        old = (op.get("old") or "").strip()
        new = (op.get("new") or "").strip()
        if not new:
            raise ValueError("Nouveau nom requis.")
        for ct in store["contacts"]:
            if ct["nom"] == old:
                ct["nom"] = new
        for c in store["chantiers"]:
            for l in c["livrables"]:
                if (l.get("personne") or "") == old:
                    l["personne"] = new
        return f"« {old} » renommé en « {new} »"

    if name == "set_person_role":   # change le rôle d'une personne partout
        nom = (op.get("nom") or "").strip()
        role = op.get("role") or ""
        for ct in store["contacts"]:
            if ct["nom"] == nom:
                ct["role"] = role
        for c in store["chantiers"]:
            for l in c["livrables"]:
                if (l.get("personne") or "") == nom:
                    l["role"] = role
        return f"Rôle de « {nom} » mis à jour"

    if name == "remove_person":   # supprime une personne ; ses livrables sont réassignés ou non assignés
        nom = (op.get("nom") or "").strip()
        to = (op.get("reassign_to") or "").strip()
        store["contacts"] = [ct for ct in store["contacts"] if ct["nom"] != nom]
        n = 0
        for c in store["chantiers"]:
            for l in c["livrables"]:
                if (l.get("personne") or "") == nom:
                    l["personne"] = to
                    n += 1
        return f"« {nom} » supprimé ({n} livrable(s) {'réassigné(s) à ' + to if to else 'désormais non assignés'})"

    if name == "set_baseline":
        ch = _chantier(store, op["chantier_id"])
        ch["baseline"] = op.get("baseline")
        ch["baseline_edits"] = 0          # nouvelle reference -> compteur remis a zero
        return f"Reference figee pour « {ch['titre']} »"

    if name == "clear_baseline":
        ch = _chantier(store, op["chantier_id"])
        ch["baseline"] = None
        ch["baseline_edits"] = 0
        return "Reference effacee"

    # ---- Recette / iterations -------------------------------------------- #
    if name == "add_iteration":
        ch = _chantier(store, op["chantier_id"])
        for it in ch.setdefault("iterations", []):   # une seule ouverte a la fois
            it["ouverte"] = False
        num = max([it["num"] for it in ch["iterations"]], default=0) + 1
        ch["iterations"].append({"id": _uid("it_"), "num": num, "ouverte": True,
                                 "date": today(), "note": "", "retours": []})
        return f"Itération {num} ouverte"

    if name == "close_iteration":
        ch = _chantier(store, op["chantier_id"])
        it = _iteration(ch, op["iteration_id"])
        it["ouverte"] = False
        return f"Itération {it['num']} clôturée"

    if name == "add_retour":
        ch = _chantier(store, op["chantier_id"])
        it = _iteration(ch, op["iteration_id"])
        quoi = (op.get("quoi") or "").strip()
        if not quoi:
            raise ValueError("Description du retour requise.")
        statut = op.get("statut") or "a_traiter"
        if statut not in RETOUR_STATUTS:
            raise ValueError(f"Statut retour invalide: {statut}")
        prio = op.get("priorite") or "m"
        if prio not in PRIOS:
            raise ValueError(f"Priorite invalide: {prio}")
        it["retours"].append({"id": _uid("r_"), "de": op.get("de") or "", "quoi": quoi,
                              "statut": statut, "priorite": prio,
                              "date": op.get("date") or today(), "echeance": op.get("echeance") or None})
        return f"Retour ajouté (itération {it['num']})"

    if name == "update_retour":
        ch = _chantier(store, op["chantier_id"])
        it = _iteration(ch, op["iteration_id"])
        r = _sub(it["retours"], op["retour_id"], "Retour")
        if op.get("statut"):
            if op["statut"] not in RETOUR_STATUTS:
                raise ValueError(f"Statut retour invalide: {op['statut']}")
            r["statut"] = op["statut"]
        if op.get("priorite"):
            if op["priorite"] not in PRIOS:
                raise ValueError(f"Priorite invalide: {op['priorite']}")
            r["priorite"] = op["priorite"]
        for f in ("de", "quoi"):
            if f in op and op[f] is not None:
                r[f] = op[f]
        if "echeance" in op:
            r["echeance"] = op["echeance"] or None
        return "Retour mis à jour"

    if name == "remove_retour":
        ch = _chantier(store, op["chantier_id"])
        it = _iteration(ch, op["iteration_id"])
        it["retours"] = [x for x in it["retours"] if x["id"] != op["retour_id"]]
        return "Retour supprimé"

    # ---- Risques --------------------------------------------------------- #
    if name == "add_risque":
        ch = _chantier(store, op["chantier_id"])
        libelle = (op.get("libelle") or "").strip()
        if not libelle:
            raise ValueError("Libellé du risque requis.")
        statut = op.get("statut") or "ouvert"
        if statut not in RISQUE_STATUTS:
            raise ValueError(f"Statut risque invalide: {statut}")
        ch.setdefault("risques", []).append({
            "id": _uid("rk_"), "libelle": libelle,
            "categorie": (op.get("categorie") or "Autre").strip() or "Autre",
            "probabilite": _clamp15(op.get("probabilite"), 3),
            "gravite": _clamp15(op.get("gravite"), 3),
            "parade": (op.get("parade") or "").strip(),
            "responsable": (op.get("responsable") or "").strip(),
            "echeance_revue": op.get("echeance_revue") or None,
            "statut": statut, "tache_id": op.get("tache_id") or None,
        })
        return f"Risque ajouté à « {ch['titre']} » : {libelle}"

    if name == "update_risque":
        ch = _chantier(store, op["chantier_id"])
        rk = _sub(ch.setdefault("risques", []), op["risque_id"], "Risque")
        for field in ("libelle", "categorie", "parade", "responsable"):
            if field in op and op[field] is not None:
                rk[field] = op[field]
        for field in ("probabilite", "gravite"):
            if field in op and op[field] is not None:
                rk[field] = _clamp15(op[field], rk.get(field, 3))
        if op.get("statut"):
            if op["statut"] not in RISQUE_STATUTS:
                raise ValueError(f"Statut risque invalide: {op['statut']}")
            rk["statut"] = op["statut"]
        if "echeance_revue" in op:
            rk["echeance_revue"] = op["echeance_revue"] or None
        if "tache_id" in op:
            rk["tache_id"] = op["tache_id"] or None
        return f"Risque mis à jour dans « {ch['titre']} »"

    if name == "remove_risque":
        ch = _chantier(store, op["chantier_id"])
        rk = _sub(ch.setdefault("risques", []), op["risque_id"], "Risque")
        ch["risques"] = [x for x in ch["risques"] if x["id"] != op["risque_id"]]
        return f"Risque supprimé : {rk['libelle']}"

    if name == "set_settings":
        store.setdefault("settings", {}).update(op.get("settings") or {})
        return "Réglages mis à jour"

    raise ValueError(f"Operation inconnue: {name}")
