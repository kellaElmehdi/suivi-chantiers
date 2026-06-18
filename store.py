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
CDC_STATUTS = {"brouillon", "en_validation", "valide", "obsolete"}   # cycle de vie d'un cahier des charges
RAPPEL_FREQS = {"jour", "semaine", "mois", "ponctuel"}              # recurrence d'une routine/rappel


def _uid(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:8]


def _clamp15(v, default=3) -> int:
    """Ramene proba/gravite sur l'echelle 1..5 (cotation 5x5)."""
    try:
        return min(5, max(1, int(v)))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Personnes : l'annuaire (store["contacts"]) est l'unique source de verite.
# Livrables et parties prenantes referencent un contact par `contact_id` ;
# `personne`/`nom` ne sont qu'un cache synchronise (pour l'export, le Gantt,
# les relances qui lisent encore la chaine).
# --------------------------------------------------------------------------- #
# Alias connus -> (nom canonique, role par defaut, est-ce "moi"). Clefs minuscules.
_PERSON_ALIASES = {
    "moi": ("Elmehdi KELLA", "Chef de projet", True),
    "toi": ("Elmehdi KELLA", "Chef de projet", True),
    "kella": ("Elmehdi KELLA", "Chef de projet", True),
    "elmehdi": ("Elmehdi KELLA", "Chef de projet", True),
    "elmehdi kella": ("Elmehdi KELLA", "Chef de projet", True),
    "rebuns": ("Rubens", "", False),
}


def _canon_person(nom):
    """Renvoie (nom_canonique, role_defaut, est_moi, clef). clef = identite normalisee."""
    base = " ".join((nom or "").strip().split())
    key = base.lower()
    if key in _PERSON_ALIASES:
        n, r, moi = _PERSON_ALIASES[key]
        return n, r, moi, n.lower()
    return base, None, False, key


def _find_or_create_contact(store, nom, role=""):
    """Trouve le contact correspondant a `nom` (par identite normalisee) ou le cree."""
    nom2, role2, moi2, key = _canon_person(nom)
    if not key:
        return None
    for ct in store.setdefault("contacts", []):
        if _canon_person(ct.get("nom", ""))[3] == key:
            if moi2 and not ct.get("moi"):
                ct["moi"] = True
            if role2:                          # role d'alias connu = fait autorite
                ct["role"] = role2
            elif not ct.get("role"):
                ct["role"] = role or ""
            return ct
    ct = {"id": _uid("c_"), "nom": nom2, "role": role2 or role or "", "moi": moi2}
    store["contacts"].append(ct)
    return ct


def _sync_contact_caches(store, ct):
    """Repercute l'identite d'un contact sur les caches (personne/nom) qui le referencent."""
    cid = ct["id"]
    for c in store.get("chantiers", []):
        for l in c.get("livrables", []):
            if l.get("contact_id") == cid:
                l["personne"] = ct["nom"]
        for p in c.get("parties", []):
            if p.get("contact_id") == cid:
                p["nom"] = ct["nom"]


def _migrate_people(store):
    """Migration idempotente : replie les doublons/alias et relie tout par contact_id."""
    contacts = store.setdefault("contacts", [])
    for ct in contacts:
        ct.setdefault("id", _uid("c_"))
        ct.setdefault("nom", "")
        ct.setdefault("role", "")
        ct.setdefault("moi", False)
    # 1) fusion des contacts en doublon / alias -> on retient le remappage des ids
    remap, survivors, seen = {}, [], {}
    for ct in contacts:
        nom2, role2, moi2, key = _canon_person(ct["nom"])
        if not key:                       # contact sans nom : on le garde tel quel
            survivors.append(ct)
            continue
        if key in seen:
            keep = seen[key]
            remap[ct["id"]] = keep["id"]
            if moi2 or ct.get("moi"):
                keep["moi"] = True
            if role2:
                keep["role"] = role2
            elif not keep.get("role"):
                keep["role"] = ct.get("role") or ""
        else:
            ct["nom"] = nom2
            if moi2:
                ct["moi"] = True
            if role2:
                ct["role"] = role2
            seen[key] = ct
            remap[ct["id"]] = ct["id"]
            survivors.append(ct)
    store["contacts"] = survivors
    by_id = {c["id"]: c for c in survivors}
    # 2) relier livrables + parties (par id remappe, sinon par nom -> trouve/cree)
    for c in store.get("chantiers", []):
        for l in c.get("livrables", []):
            ct = by_id.get(remap.get(l.get("contact_id"), l.get("contact_id")))
            if ct is None and (l.get("personne") or "").strip():
                ct = _find_or_create_contact(store, l["personne"], l.get("role", ""))
                by_id[ct["id"]] = ct
            if ct:
                l["contact_id"] = ct["id"]
                l["personne"] = ct["nom"]
                if not (l.get("role") or "").strip():
                    l["role"] = ct.get("role", "")
            else:
                l.setdefault("contact_id", None)
        for p in c.get("parties", []):
            ct = by_id.get(remap.get(p.get("contact_id"), p.get("contact_id")))
            if ct is None and (p.get("nom") or "").strip():
                ct = _find_or_create_contact(store, p["nom"], "")
                by_id[ct["id"]] = ct
            if ct:
                p["contact_id"] = ct["id"]
                p["nom"] = ct["nom"]      # le role d'une partie reste contextuel
            else:
                p.setdefault("contact_id", None)


def today() -> str:
    return date.today().isoformat()


def _hm(dt: datetime | None = None) -> str:
    return (dt or datetime.now()).strftime("%H:%M")


# --------------------------------------------------------------------------- #
# Suivi du temps (chrono unifié) : une session = une plage de travail horodatée
# sur une tâche, une routine, ou libre. Un seul chrono actif (fin=None) à la fois.
# --------------------------------------------------------------------------- #
def _clock_active(store: dict) -> list:
    return [s for s in store.get("timelog", []) if s.get("fin") is None]


def _day_end(store: dict, date_iso: str) -> str:
    # fin de journée de travail selon le jour : vendredi (weekday 4) plus court.
    st = store.get("settings", {})
    try:
        wd = date.fromisoformat(date_iso).weekday()
    except (ValueError, TypeError):
        wd = -1
    return st.get("vendredi_fin", "13:30") if wd == 4 else st.get("jour_fin", "17:51")


def _close_session(store: dict, s: dict) -> None:
    # ferme la session ; on borne à la fin de journée de travail (chrono oublié) :
    # jour antérieur -> fin de journée ; aujourd'hui -> min(maintenant, fin de journée).
    jf = _day_end(store, s.get("date") or today())
    now = _hm()
    s["fin"] = jf if (s.get("date") != today() or now > jf) else now


def _clock_close_all(store: dict) -> None:
    for s in _clock_active(store):
        _close_session(store, s)


def _clock_close_tache(store: dict, tache_id: str) -> None:
    for s in _clock_active(store):
        if s.get("tache_id") == tache_id:
            _close_session(store, s)


def _clock_close_chantier(store: dict, chantier_id: str) -> None:
    for s in _clock_active(store):
        if s.get("chantier_id") == chantier_id:
            _close_session(store, s)


def _clock_start(store: dict, kind: str, label: str, **refs) -> dict:
    _clock_close_all(store)                 # un seul chrono à la fois → la journée est continue
    now = datetime.now()
    sess = {"id": _uid("tl_"), "date": now.date().isoformat(),
            "debut": now.strftime("%H:%M"), "fin": None, "kind": kind, "label": label,
            "chantier_id": refs.get("chantier_id"), "tache_id": refs.get("tache_id"),
            "rappel_id": refs.get("rappel_id")}
    log = store.setdefault("timelog", [])
    log.append(sess)
    if len(log) > 5000:
        del log[:len(log) - 5000]
    return sess


# --------------------------------------------------------------------------- #
# Cahier des charges — document libre (sections) + suivi de modification
# (table d'indices A/B/C avec snapshot) + validation par statut posé.
# --------------------------------------------------------------------------- #
CDC_TEMPLATE = [
    ("Objet", "But de ce cahier des charges et du besoin couvert."),
    ("Contexte et enjeux", ""),
    ("Périmètre", "Ce qui est inclus — et ce qui est explicitement exclu."),
    ("Besoins et exigences", ""),
    ("Contraintes (techniques, délais, budget)", ""),
    ("Livrables attendus", ""),
    ("Critères de recette / validation", ""),
]


def _next_indice(cur: str) -> str:
    """Indice suivant façon industrie : A→B, Z→AA, AZ→BA, ZZ→AAA."""
    chars = list((cur or "A").strip().upper() or "A")
    i = len(chars) - 1
    while i >= 0:
        if chars[i] == "Z":
            chars[i] = "A"
            i -= 1
        else:
            chars[i] = chr(ord(chars[i]) + 1)
            return "".join(chars)
    return "A" + "".join(chars)


def _new_cdc(ch: dict) -> dict:
    return {
        "reference": "", "titre": ch.get("titre", ""), "statut": "brouillon",
        "indice": "A", "redacteur": "", "lien": "",
        "date_creation": today(), "date_maj": today(),
        "parties_prenantes": [], "valide_par": "", "date_validation": None,
        "sections": [{"id": _uid("sec_"), "titre": t, "corps": b} for t, b in CDC_TEMPLATE],
        "revisions": [{"id": _uid("rev_"), "indice": "A", "date": today(),
                       "auteur": "", "objet": "Création du document", "snapshot": None}],
    }


# --------------------------------------------------------------------------- #
# Journal d'actions (suivi de progression hebdo). Chaque mutation y dépose une
# ligne horodatée — le message lisible est déjà produit par _apply_op.
# --------------------------------------------------------------------------- #
JOURNAL_SKIP = {"set_settings", "cdc_section_update", "cdc_section_move",
                "add_rappel", "update_rappel", "toggle_rappel", "remove_rappel",
                "clock_start", "clock_stop", "clock_edit", "clock_delete", "clock_add",
                "update_subtask", "apply_template"}   # bruit d'édition : pas une "action" à tracer
# (add/toggle/remove_subtask SONT journalisés : traçabilité des étapes voulue par l'utilisateur)
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
                "cdc": {
                    "reference": "CDC-PBI-2026-001",
                    "titre": "Cahier des charges — Migration Power BI v2",
                    "statut": "en_validation", "indice": "B", "redacteur": "Moi", "lien": "",
                    "date_creation": "2026-05-26", "date_maj": "2026-06-05",
                    "parties_prenantes": [
                        {"id": "pp_cg", "nom": "Controle de gestion", "role": "Approbateur (recette)"},
                        {"id": "pp_dir", "nom": "Direction", "role": "Destinataire"},
                        {"id": "pp_dsi", "nom": "Marc", "role": "Verificateur (DSI)"},
                    ],
                    "valide_par": "", "date_validation": None,
                    "sections": [
                        {"id": "sec_obj", "titre": "Objet",
                         "corps": "Refondre les rapports Power BI sur le nouveau modele gold et les republier aux directions."},
                        {"id": "sec_ctx", "titre": "Contexte et enjeux",
                         "corps": "L'ancien modele melangeait les sources ; les marges n'etaient pas fiables. Le modele gold consolide les 3 ERP."},
                        {"id": "sec_per", "titre": "Perimetre",
                         "corps": "Inclus : 6 pages de rapport (CA, marge, NC, charge). Exclu : la partie previsionnelle (phase 2)."},
                        {"id": "sec_exi", "titre": "Besoins et exigences",
                         "corps": "- Marge calculee au grain OF cloture\n- Filtre par secteur marche\n- Rafraichissement quotidien via passerelle"},
                        {"id": "sec_con", "titre": "Contraintes (techniques, delais, budget)",
                         "corps": "Publication avant le 20/06. Acces passerelle a ouvrir par la DSI."},
                        {"id": "sec_liv", "titre": "Livrables attendus",
                         "corps": "Rapport publie + jeu de donnees rafraichi + note de version."},
                        {"id": "sec_rec", "titre": "Criteres de recette / validation",
                         "corps": "Double calcul DAX vs warehouse a moins de 0,5% d'ecart sur le CA et la marge."},
                    ],
                    "revisions": [
                        {"id": "rev_a", "indice": "A", "date": "2026-05-26", "auteur": "Moi",
                         "objet": "Creation du document", "snapshot": None},
                        {"id": "rev_b", "indice": "B", "date": "2026-06-05", "auteur": "Moi",
                         "objet": "Ajout des criteres de recette chiffres (ecart < 0,5%) apres echange controle de gestion",
                         "snapshot": None},
                    ],
                },
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
    for ct in store.setdefault("contacts", []):
        ct.setdefault("id", _uid("c_"))
        ct.setdefault("nom", "")
        ct.setdefault("role", "")
        ct.setdefault("moi", False)            # marque l'utilisateur (une seule fiche "moi")
    store.setdefault("journal", [])
    s = store.setdefault("settings", {})
    s.setdefault("capacite_jour", 3)     # max taches actives par jour (global)
    s.setdefault("wip_max", 3)           # max chantiers "En cours" simultanes
    s.setdefault("jours_ouvres", True)   # planning en jours ouvres (exclut samedi/dimanche)
    s.setdefault("relance_jours", 7)     # relance suggeree apres N jours
    s.setdefault("rappel_stale_jours", 3)  # nudge si un chantier "en cours" n'a rien enregistre depuis N jours
    s.setdefault("taux_jour", 0)         # taux journalier (€/jour) pour le cout reel EVM (0 = non configure)
    s.setdefault("heures_jour", 7)       # heures facturables/jour : conversion temps chrono -> jours-personnes (AC)
    s.setdefault("jour_debut", "07:00")  # debut de journee de travail (borne le chrono)
    s.setdefault("jour_fin", "17:51")    # fin de journee : une session oubliee est fermee a cette heure
    s.setdefault("pause_debut", "12:00") # pause dejeuner : exclue du temps compte (le chrono continue)
    s.setdefault("pause_fin", "13:00")
    s.setdefault("vendredi_fin", "13:30") # vendredi : journee plus courte, sans pause, pas d'apres-midi
    jd, jf = s["jour_debut"], s["jour_fin"]
    for r in store.setdefault("rappels", []):   # routines/rappels (hors chantier) : checklist recurrente unifiee
        r.setdefault("id", _uid("rp_"))
        r.setdefault("label", "")
        r.setdefault("freq", "jour")        # jour | semaine | mois | ponctuel
        r.setdefault("jours", [])           # hebdo : jours de semaine 0=lundi..6=dimanche (vide = 1x/semaine glissante)
        r.setdefault("jour_mois", None)     # mensuel : jour du mois 1..28
        r.setdefault("date", None)          # ponctuel : echeance ISO
        r.setdefault("heure", None)         # "HH:MM" pour declencher la notif bureau
        r.setdefault("actif", True)
        r.setdefault("ticks", [])           # dates cochees (recurrent) ; ponctuel : non-vide => fait
        r.setdefault("note", "")
    for s in store.setdefault("timelog", []):   # sessions de suivi du temps (chrono)
        s.setdefault("id", _uid("tl_"))
        s.setdefault("date", today())
        s.setdefault("debut", "00:00")
        s.setdefault("fin", None)
        s.setdefault("kind", "libre")           # tache | rappel | libre
        s.setdefault("label", "")
        s.setdefault("chantier_id", None)
        s.setdefault("tache_id", None)
        s.setdefault("rappel_id", None)
        de = _day_end(store, s["date"])   # fin de journée selon le jour (vendredi plus court)
        # auto-réparation : un chrono oublié un jour passé est fermé à la fin de journée
        if s["fin"] is None and s["date"] < today():
            s["fin"] = de
        # borne la plage à la journée de travail (comparaison lexicale d'heures "HH:MM" zéro-paddées)
        if s["debut"] and s["debut"] < jd:
            s["debut"] = jd
        if s["fin"] is not None:
            if s["fin"] > de:
                s["fin"] = de
            if s["fin"] < s["debut"]:
                s["fin"] = s["debut"]
    for c in store.get("chantiers", []):
        if c.get("statut") == "block":   # "Bloqué" est desormais calcule, plus un statut manuel
            c["statut"] = "doing"
        c.setdefault("date_debut", None)
        c.setdefault("objectif", "")
        c.setdefault("budget", None)         # BAC (budget a l'achevement, €) pour l'EVM ; None = non defini
        c.setdefault("blocage", "")
        c.setdefault("tags", [])
        c.setdefault("parties", [])
        c.setdefault("livrables", [])
        c.setdefault("histo", [])
        c.setdefault("baseline", None)
        c.setdefault("baseline_edits", 0)
        c.setdefault("hold", False)          # mise en pause volontaire (sort des compteurs)
        c.setdefault("hold_until", None)     # date de reprise prévue (optionnelle, déclenche un rappel)
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
        cdc = c.setdefault("cdc", None)                # cahier des charges (0..1 par chantier)
        if cdc is not None:
            cdc.setdefault("reference", "")
            cdc.setdefault("titre", c.get("titre", ""))
            cdc.setdefault("statut", "brouillon")
            cdc.setdefault("indice", "A")
            cdc.setdefault("redacteur", "")
            cdc.setdefault("lien", "")
            cdc.setdefault("date_creation", today())
            cdc.setdefault("date_maj", cdc.get("date_creation") or today())
            cdc.setdefault("valide_par", "")
            cdc.setdefault("date_validation", None)
            for pp in cdc.setdefault("parties_prenantes", []):
                pp.setdefault("id", _uid("pp_"))
                pp.setdefault("nom", "")
                pp.setdefault("role", "")
            for sec in cdc.setdefault("sections", []):
                sec.setdefault("id", _uid("sec_"))
                sec.setdefault("titre", "")
                sec.setdefault("corps", "")
            for rev in cdc.setdefault("revisions", []):
                rev.setdefault("id", _uid("rev_"))
                rev.setdefault("indice", "A")
                rev.setdefault("date", today())
                rev.setdefault("auteur", "")
                rev.setdefault("objet", "")
                rev.setdefault("snapshot", None)
        for t in c.setdefault("taches", []):
            t.setdefault("done", False)
            t.setdefault("done_date", None)
            t.setdefault("desc", "")           # description / notes libres de la tache
            t.setdefault("start_date", None)   # debut REEL (None tant que pas demarree)
            t.setdefault("is_milestone", False)
            t.setdefault("duree", 0 if t.get("is_milestone") else 1)
            t.setdefault("preds", [])
            t.setdefault("start_fix", None)
            for st in t.setdefault("subtasks", []):   # checklist d'étapes (sans planning propre)
                st.setdefault("id", _uid("st_"))
                st.setdefault("label", "")
                st.setdefault("done", False)
                st.setdefault("done_at", None)        # horodatage de complétion (ISO date+heure)
        for l in c["livrables"]:
            l.setdefault("tache_id", None)
            l.setdefault("contact_id", None)
        for p in c["parties"]:
            p.setdefault("id", _uid("p_"))
            p.setdefault("contact_id", None)
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
    _migrate_people(store)     # relie livrables/parties a l'annuaire (idempotent)
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


def _cdc(store: dict, cid: str):
    ch = _chantier(store, cid)
    cdc = ch.get("cdc")
    if not cdc:
        raise ValueError("Ce chantier n'a pas de cahier des charges.")
    return ch, cdc


# --------------------------------------------------------------------------- #
# Application d'une operation
# --------------------------------------------------------------------------- #
# Une op fait DÉRIVER la référence figée seulement si elle change la STRUCTURE ou les
# DATES PRÉVUES du planning — PAS si elle enregistre l'exécution (démarrer/terminer une
# tâche, corriger une date réelle, marquer un livrable reçu...). Sinon le compteur gonfle
# avec le travail quotidien alors qu'on n'a pas replanifié.
_REPLAN_OPS = {"add_tache", "remove_tache", "apply_template", "add_livrable", "remove_livrable"}


def _is_replanning(name: str, op: dict) -> bool:
    if name in _REPLAN_OPS:
        return True
    if name == "update_tache":   # seules durée, dépendances, début imposé, type jalon = du planning
        return any(k in op for k in ("duree", "preds", "start_fix", "is_milestone"))
    if name == "update_livrable":  # seule la date attendue / le rattachement à une tâche pèse sur le planning
        return ("date" in op) or ("tache_id" in op)
    if name == "update_chantier":  # seules la date de début ou l'échéance dérivent le planning
        return ("date_debut" in op) or ("echeance" in op)
    return False


def apply_op(store: dict, op: dict) -> str:
    """Applique l'operation puis incremente le compteur de modifs post-reference
    UNIQUEMENT pour une op qui REPLANIFIE un chantier possedant une reference figee."""
    msg = _apply_op(store, op)
    name = op.get("op")
    if _is_replanning(name, op):
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
                               "desc": "", "start_date": None, "duree": 1, "preds": [],
                               "is_milestone": False, "start_fix": None, "subtasks": []})
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

    if name == "apply_template":
        # Applique un modele standardise : cree un chantier (create) ou peuple un existant
        # (chantier_id), avec taches (preds par INDICE dans le lot), livrables, parties, risques.
        if op.get("create"):
            cc = op["create"]
            titre = (cc.get("titre") or "").strip()
            if not titre:
                raise ValueError("Titre requis pour creer un chantier.")
            prio = cc.get("prio") or "m"
            if prio not in PRIOS:
                raise ValueError(f"Priorite invalide: {prio}")
            ch = {
                "id": _uid("ch_"), "titre": titre, "statut": cc.get("statut") or "todo", "prio": prio,
                "echeance": cc.get("echeance") or None, "date_debut": cc.get("date_debut") or today(),
                "objectif": (cc.get("objectif") or "").strip(), "blocage": "", "tags": [], "parties": [],
                "taches": [], "livrables": [], "histo": [], "iterations": [], "risques": [], "cdc": None,
                "ordre": len(store["chantiers"]),
            }
            store["chantiers"].append(ch)
        else:
            ch = _chantier(store, op["chantier_id"])

        src = op.get("taches") or []
        new_tasks = []
        for t in src:
            label = (t.get("label") or "").strip()
            if not label:
                new_tasks.append(None); continue
            is_ms = bool(t.get("is_milestone"))
            new_tasks.append({"id": _uid("t_"), "label": label, "done": False, "done_date": None,
                              "desc": (t.get("desc") or "").strip(), "start_date": None,
                              "duree": 0 if is_ms else max(0, int(t.get("duree") or 1)),
                              "preds": [], "is_milestone": is_ms, "start_fix": None, "subtasks": []})
        for i, t in enumerate(src):                       # resout les preds par indice du lot
            if new_tasks[i] is None:
                continue
            for pidx in (t.get("preds") or []):
                if isinstance(pidx, int) and 0 <= pidx < len(new_tasks) and pidx != i and new_tasks[pidx]:
                    new_tasks[i]["preds"].append(new_tasks[pidx]["id"])
        added_t = [t for t in new_tasks if t]
        ch.setdefault("taches", []).extend(added_t)

        added_l = 0
        for l in (op.get("livrables") or []):
            quoi = (l.get("quoi") or "").strip()
            if not quoi:
                continue
            ch.setdefault("livrables", []).append({
                "id": _uid("l_"), "contact_id": None, "personne": (l.get("personne") or "").strip(),
                "role": l.get("role") or "", "quoi": quoi, "date": l.get("date") or None,
                "statut": "attente", "relances": 0, "derniere": None, "impact": l.get("impact") or "",
                "tache_id": None})
            added_l += 1

        added_p = 0
        for p in (op.get("parties") or []):
            nom = (p.get("nom") or "").strip()
            if not nom:
                continue
            ch.setdefault("parties", []).append({"id": _uid("p_"), "nom": nom, "role": p.get("role") or ""})
            added_p += 1

        added_r = 0
        for r in (op.get("risques") or []):
            lib = (r.get("libelle") or "").strip()
            if not lib:
                continue
            ch.setdefault("risques", []).append({
                "id": _uid("rk_"), "libelle": lib, "categorie": (r.get("categorie") or "Autre").strip() or "Autre",
                "probabilite": _clamp15(r.get("probabilite"), 3), "gravite": _clamp15(r.get("gravite"), 3),
                "parade": (r.get("parade") or "").strip(), "responsable": (r.get("responsable") or "").strip(),
                "echeance_revue": None, "statut": "ouvert", "tache_id": None})
            added_r += 1

        parts = []
        if added_t: parts.append(f"{len(added_t)} tâche(s)")
        if added_l: parts.append(f"{added_l} livrable(s)")
        if added_p: parts.append(f"{added_p} partie(s)")
        if added_r: parts.append(f"{added_r} risque(s)")
        verb = "Chantier créé depuis un modèle" if op.get("create") else "Modèle appliqué"
        return f"{verb} — « {ch['titre']} » : {', '.join(parts) or 'rien à ajouter'}"

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
        if "budget" in op:
            b = op["budget"]
            ch["budget"] = None if b in (None, "") else float(b); changed.append("budget")
        return f"Chantier « {ch['titre']} » mis a jour ({', '.join(changed) or 'aucun champ'})"

    if name == "delete_chantier":
        ch = _chantier(store, op["id"])
        _clock_close_chantier(store, ch["id"])    # solde un éventuel chrono actif du chantier
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

    if name == "set_hold":   # met en pause / reprend un chantier entier
        ch = _chantier(store, op["chantier_id"])
        ch["hold"] = bool(op.get("hold"))
        ch["hold_until"] = (op.get("until") or None) if ch["hold"] else None
        if ch["hold"]:
            _clock_close_chantier(store, ch["id"])   # parquer le chantier arrête son chrono
            return f"« {ch['titre']} » mis en pause" + (f" jusqu'au {ch['hold_until']}" if ch["hold_until"] else "")
        return f"« {ch['titre']} » repris"

    if name == "add_tache":
        ch = _chantier(store, op["chantier_id"])
        label = (op.get("label") or "").strip()
        if not label:
            raise ValueError("Label de tache requis.")
        is_ms = bool(op.get("is_milestone"))
        duree = 0 if is_ms else max(0, int(op.get("duree") or 1))
        t = {"id": _uid("t_"), "label": label, "done": False, "done_date": None,
             "desc": (op.get("desc") or "").strip(), "start_date": None, "duree": duree,
             "preds": [], "is_milestone": is_ms, "start_fix": op.get("start_fix") or None,
             "subtasks": []}
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
            if not t.get("is_milestone") and not t.get("start_date"):   # flux imposé : démarrer avant de terminer
                raise ValueError(f"Démarre d'abord « {t['label']} » avant de la terminer (ou marque-la comme jalon).")
        was_done = t["done"]
        t["done"] = new_done
        if new_done and not was_done:             # transition -> fait : on fixe la date réelle
            t["done_date"] = op.get("done_date") or today()
            _clock_close_tache(store, t["id"])    # terminer arrête le chrono de la tâche
        elif not new_done:
            t["done_date"] = None                 # ré-ouverte : plus de date de fin
        # déjà fait et on re-confirme "fait" : on NE réécrit PAS done_date (préserve l'historique)
        return f"Tache « {t['label']} » -> {'faite' if t['done'] else 'a faire'}"

    if name == "start_tache":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        if t["done"]:
            raise ValueError("Cette tache est deja terminee.")
        if "date" in op and not op.get("date"):       # date null explicite -> annule le demarrage
            t["start_date"] = None
            _clock_close_tache(store, t["id"])
            return f"Tache « {t['label']} » remise a faire"
        t["start_date"] = op.get("date") or today()
        _clock_start(store, "tache", t["label"], chantier_id=ch["id"], tache_id=t["id"])   # ouvre le chrono
        return f"Tache « {t['label']} » demarree le {t['start_date']}"

    if name == "update_tache":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        if op.get("label"):
            t["label"] = op["label"]
        if "desc" in op and op["desc"] is not None:
            t["desc"] = op["desc"]
        if "is_milestone" in op:
            t["is_milestone"] = bool(op["is_milestone"])
            if t["is_milestone"]:
                t["duree"] = 0
                if not t["done"]:                  # devient un jalon : pas de "en cours" → on solde le chrono/début réel
                    _clock_close_tache(store, t["id"])
                    t["start_date"] = None
        if "duree" in op and not t["is_milestone"]:
            t["duree"] = max(0, int(op["duree"] or 0))
        if "start_fix" in op:
            t["start_fix"] = op["start_fix"] or None
        if "start_date" in op:                 # correction du debut REEL
            t["start_date"] = op["start_date"] or None
        if "preds" in op:
            t["preds"] = _clean_preds(ch, op["preds"], t["id"])
        if "done" in op:
            new_done = bool(op["done"])
            if new_done and not t["done"]:
                miss = _unfinished_preds(ch, t)
                if miss:
                    raise ValueError(f"Impossible de terminer « {t['label']} » : "
                                     f"prédécesseur(s) non terminé(s) : {', '.join(miss)}.")
                if not t.get("is_milestone") and not t.get("start_date"):
                    raise ValueError(f"Démarre d'abord « {t['label']} » avant de la terminer (ou marque-la comme jalon).")
            was_done = t["done"]
            t["done"] = new_done
            if new_done and not was_done:
                t["done_date"] = op.get("done_date") or today()
                _clock_close_tache(store, t["id"])
            elif not new_done:
                t["done_date"] = None
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

    # ---- Sous-taches (checklist d'etapes, sans planning propre) ---------- #
    if name == "add_subtask":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        label = (op.get("label") or "").strip()
        if not label:
            raise ValueError("Libellé de l'étape requis.")
        t.setdefault("subtasks", []).append({"id": _uid("st_"), "label": label, "done": False, "done_at": None})
        return f"Étape ajoutée à « {t['label']} » : {label}"

    if name == "toggle_subtask":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        st = _sub(t.setdefault("subtasks", []), op["subtask_id"], "Étape")
        st["done"] = bool(op.get("done", not st["done"]))
        st["done_at"] = datetime.now().isoformat(timespec="minutes") if st["done"] else None
        return f"Étape « {st['label']} » de « {t['label']} » → {'faite' if st['done'] else 'à refaire'}"

    if name == "update_subtask":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        st = _sub(t.setdefault("subtasks", []), op["subtask_id"], "Étape")
        if op.get("label"):
            st["label"] = op["label"].strip()
        if "done" in op:
            st["done"] = bool(op["done"])
            st["done_at"] = datetime.now().isoformat(timespec="minutes") if st["done"] else None
        return "Étape mise à jour"

    if name == "remove_subtask":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        st = _sub(t.setdefault("subtasks", []), op["subtask_id"], "Étape")
        t["subtasks"] = [x for x in t["subtasks"] if x["id"] != op["subtask_id"]]
        return f"Étape supprimée : {st['label']}"

    if name == "add_livrable":
        ch = _chantier(store, op["chantier_id"])
        quoi = (op.get("quoi") or "").strip()
        personne = (op.get("personne") or "").strip()
        if not quoi or not (personne or op.get("contact_id")):
            raise ValueError("Livrable : une personne (annuaire ou nom) et 'quoi' sont requis.")
        statut = op.get("statut") or "attente"
        if statut not in LIV_STATUTS:
            raise ValueError(f"Statut livrable invalide: {statut}")
        role = op.get("role") or ""
        cid = op.get("contact_id")
        if cid:
            ct = _sub(store["contacts"], cid, "Contact")
        else:                                 # nom libre -> on trouve/cree la fiche annuaire
            ct = _find_or_create_contact(store, personne, role)
        if ct:
            cid, personne = ct["id"], ct["nom"]
            if not role:
                role = ct.get("role", "")
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
                lv["personne"] = ct["nom"]
                if not (lv.get("role") or "").strip():
                    lv["role"] = ct.get("role", "")
        if "personne" in op and op["personne"] is not None:   # nom libre -> trouve/cree la fiche
            ct = _find_or_create_contact(store, op["personne"], op.get("role") or "")
            if ct:
                lv["contact_id"], lv["personne"] = ct["id"], ct["nom"]
            else:
                lv["contact_id"], lv["personne"] = None, op["personne"]
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
        cid = op.get("contact_id")
        if cid:
            ct = _sub(store["contacts"], cid, "Contact")
        else:
            if not nom:
                raise ValueError("Nom de partie prenante requis.")
            ct = _find_or_create_contact(store, nom, "")
        if ct:
            cid, nom = ct["id"], ct["nom"]
        ch["parties"].append({"id": _uid("p_"), "contact_id": cid, "nom": nom, "role": op.get("role") or ""})
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
        ct = _find_or_create_contact(store, nom, op.get("role") or "")
        if op.get("role"):
            ct["role"] = op["role"]
        if op.get("moi"):
            for o in store["contacts"]:
                o["moi"] = (o["id"] == ct["id"])
        return f"Personne ajoutee : {ct['nom']}"

    if name == "update_contact":       # renomme / change role / marque "moi" — par id
        ct = _sub(store["contacts"], op["id"], "Contact")
        if op.get("nom") is not None:
            nm = op["nom"].strip()
            if not nm:
                raise ValueError("Nom requis.")
            ct["nom"] = nm
        if op.get("role") is not None:
            ct["role"] = op["role"]
        if "moi" in op:
            if op["moi"]:
                for o in store["contacts"]:
                    o["moi"] = (o["id"] == ct["id"])
            else:
                ct["moi"] = False
        _sync_contact_caches(store, ct)
        return f"Personne mise a jour : {ct['nom']}"

    if name == "merge_contact":        # replie une fiche en doublon dans une autre
        src = _sub(store["contacts"], op["from_id"], "Contact")
        dst = _sub(store["contacts"], op["into_id"], "Contact")
        if src["id"] == dst["id"]:
            raise ValueError("Fusion impossible : meme personne.")
        n = 0
        for c in store["chantiers"]:
            for l in c["livrables"]:
                if l.get("contact_id") == src["id"]:
                    l["contact_id"], l["personne"], n = dst["id"], dst["nom"], n + 1
            for p in c["parties"]:
                if p.get("contact_id") == src["id"]:
                    p["contact_id"], p["nom"] = dst["id"], dst["nom"]
        if src.get("moi"):
            dst["moi"] = True
        if not dst.get("role"):
            dst["role"] = src.get("role", "")
        store["contacts"] = [x for x in store["contacts"] if x["id"] != src["id"]]
        return f"« {src['nom']} » fusionne dans « {dst['nom']} » ({n} livrable(s))"

    if name == "remove_contact":       # supprime une fiche — par id
        ct = _sub(store["contacts"], op["id"], "Contact")
        to = op.get("reassign_to")     # id d'une autre fiche, ou None
        dst = _sub(store["contacts"], to, "Contact") if to else None
        n = 0
        for c in store["chantiers"]:
            for l in c["livrables"]:
                if l.get("contact_id") == ct["id"]:
                    l["contact_id"] = dst["id"] if dst else None
                    l["personne"] = dst["nom"] if dst else ""
                    n += 1
            for p in c["parties"]:
                if p.get("contact_id") == ct["id"]:
                    p["contact_id"] = dst["id"] if dst else None
                    if dst:
                        p["nom"] = dst["nom"]
        store["contacts"] = [x for x in store["contacts"] if x["id"] != ct["id"]]
        cible = f"reassigne(s) a {dst['nom']}" if dst else "desormais non assignes"
        return f"« {ct['nom']} » supprime ({n} livrable(s) {cible})"

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

    # ---- Cahier des charges ---------------------------------------------- #
    if name == "cdc_create":
        ch = _chantier(store, op["chantier_id"])
        if ch.get("cdc"):
            return "Cahier des charges déjà présent."
        ch["cdc"] = _new_cdc(ch)
        if op.get("reference"):
            ch["cdc"]["reference"] = str(op["reference"]).strip()
        if op.get("redacteur"):
            ch["cdc"]["redacteur"] = str(op["redacteur"]).strip()
        return f"Cahier des charges créé pour « {ch['titre']} »"

    if name == "cdc_delete":
        ch = _chantier(store, op["chantier_id"])
        ch["cdc"] = None
        return f"Cahier des charges supprimé de « {ch['titre']} »"

    if name == "cdc_update":
        ch, cdc = _cdc(store, op["chantier_id"])
        for f in ("reference", "titre", "redacteur", "lien", "valide_par"):
            if f in op and op[f] is not None:
                cdc[f] = str(op[f]).strip()
        if "statut" in op and op["statut"]:
            if op["statut"] not in CDC_STATUTS:
                raise ValueError(f"Statut CdC invalide: {op['statut']}")
            cdc["statut"] = op["statut"]
            if op["statut"] == "valide" and not cdc.get("date_validation"):
                cdc["date_validation"] = today()
            if op["statut"] == "brouillon":
                cdc["date_validation"] = None
                cdc["valide_par"] = ""
        if "date_validation" in op:
            cdc["date_validation"] = op["date_validation"] or None
        cdc["date_maj"] = today()
        return f"Cahier des charges mis à jour — « {ch['titre']} »"

    if name == "cdc_section_add":
        ch, cdc = _cdc(store, op["chantier_id"])
        titre = (op.get("titre") or "Nouvelle section").strip() or "Nouvelle section"
        cdc["sections"].append({"id": _uid("sec_"), "titre": titre, "corps": op.get("corps") or ""})
        cdc["date_maj"] = today()
        return f"Section « {titre} » ajoutée au cahier des charges"

    if name == "cdc_section_update":
        ch, cdc = _cdc(store, op["chantier_id"])
        sec = _sub(cdc["sections"], op["section_id"], "Section")
        if "titre" in op and op["titre"] is not None:
            sec["titre"] = str(op["titre"]).strip()
        if "corps" in op and op["corps"] is not None:
            sec["corps"] = op["corps"]
        cdc["date_maj"] = today()
        return "Section mise à jour"

    if name == "cdc_section_remove":
        ch, cdc = _cdc(store, op["chantier_id"])
        sec = _sub(cdc["sections"], op["section_id"], "Section")
        cdc["sections"] = [x for x in cdc["sections"] if x["id"] != op["section_id"]]
        cdc["date_maj"] = today()
        return f"Section « {sec['titre']} » supprimée"

    if name == "cdc_section_move":
        ch, cdc = _cdc(store, op["chantier_id"])
        secs = cdc["sections"]
        idx = next((i for i, x in enumerate(secs) if x["id"] == op["section_id"]), -1)
        if idx < 0:
            raise ValueError("Section introuvable")
        j = idx + (1 if (op.get("dir", 1) or 1) > 0 else -1)
        if 0 <= j < len(secs):
            secs[idx], secs[j] = secs[j], secs[idx]
        return "Section déplacée"

    if name == "cdc_partie_add":
        ch, cdc = _cdc(store, op["chantier_id"])
        nom = (op.get("nom") or "").strip()
        if not nom:
            raise ValueError("Nom de la partie prenante requis.")
        cdc["parties_prenantes"].append({"id": _uid("pp_"), "nom": nom, "role": (op.get("role") or "").strip()})
        return f"Partie prenante ajoutée : {nom}"

    if name == "cdc_partie_remove":
        ch, cdc = _cdc(store, op["chantier_id"])
        cdc["parties_prenantes"] = [x for x in cdc["parties_prenantes"] if x["id"] != op["partie_id"]]
        return "Partie prenante retirée"

    if name == "cdc_revise":
        ch, cdc = _cdc(store, op["chantier_id"])
        objet = (op.get("objet") or "").strip()
        if not objet:
            raise ValueError("Décris l'objet de la révision.")
        auteur = (op.get("auteur") or cdc.get("redacteur") or "").strip()
        cur = cdc["indice"]
        rec = next((r for r in cdc["revisions"] if r["indice"] == cur), None)
        if rec is not None and rec.get("snapshot") is None:
            # fige le contenu de l'indice courant avant de passer au suivant
            rec["snapshot"] = {
                "titre": cdc.get("titre", ""), "reference": cdc.get("reference", ""),
                "statut": cdc.get("statut"), "valide_par": cdc.get("valide_par", ""),
                "date_validation": cdc.get("date_validation"),
                "sections": [dict(s) for s in cdc.get("sections", [])],
            }
        nxt = _next_indice(cur)
        cdc["indice"] = nxt
        cdc["statut"] = "brouillon"          # nouvel indice -> validation réinitialisée
        cdc["valide_par"] = ""
        cdc["date_validation"] = None
        cdc["date_maj"] = today()
        cdc["revisions"].append({"id": _uid("rev_"), "indice": nxt, "date": today(),
                                 "auteur": auteur, "objet": objet, "snapshot": None})
        return f"Révision {nxt} émise — « {ch['titre']} » (validation réinitialisée)"

    # ---- Routines / rappels (hors chantier) ------------------------------ #
    if name == "add_rappel":
        label = (op.get("label") or "").strip()
        if not label:
            raise ValueError("Libellé de la routine requis.")
        freq = op.get("freq") or "jour"
        if freq not in RAPPEL_FREQS:
            raise ValueError(f"Fréquence invalide: {freq}")
        if freq == "ponctuel" and not op.get("date"):
            raise ValueError("Un rappel ponctuel nécessite une date.")
        jours = [int(x) for x in (op.get("jours") or []) if str(x).isdigit() and 0 <= int(x) <= 6]
        jm = op.get("jour_mois")
        store.setdefault("rappels", []).append({
            "id": _uid("rp_"), "label": label, "freq": freq, "jours": jours,
            "jour_mois": (min(28, max(1, int(jm))) if jm else None),
            "date": op.get("date") or None, "heure": op.get("heure") or None,
            "actif": True, "ticks": [], "note": (op.get("note") or "").strip(),
        })
        return f"Routine ajoutée : {label}"

    if name == "update_rappel":
        r = _sub(store.setdefault("rappels", []), op["id"], "Rappel")
        if "label" in op and op["label"] is not None:
            r["label"] = str(op["label"]).strip() or r["label"]
        if op.get("freq"):
            if op["freq"] not in RAPPEL_FREQS:
                raise ValueError(f"Fréquence invalide: {op['freq']}")
            r["freq"] = op["freq"]
        if "jours" in op:
            r["jours"] = [int(x) for x in (op.get("jours") or []) if str(x).isdigit() and 0 <= int(x) <= 6]
        if "jour_mois" in op:
            jm = op.get("jour_mois")
            r["jour_mois"] = (min(28, max(1, int(jm))) if jm else None)
        if "date" in op:
            r["date"] = op["date"] or None
        if "heure" in op:
            r["heure"] = op["heure"] or None
        if "actif" in op:
            r["actif"] = bool(op["actif"])
        if "note" in op and op["note"] is not None:
            r["note"] = str(op["note"]).strip()
        if r["freq"] == "ponctuel" and not r.get("date"):   # un ponctuel sans date serait "dû" en permanence
            raise ValueError("Un rappel ponctuel nécessite une date d'échéance.")
        return f"Routine mise à jour : {r['label']}"

    if name == "toggle_rappel":
        r = _sub(store.setdefault("rappels", []), op["id"], "Rappel")
        d = op.get("date") or today()
        ticks = r.setdefault("ticks", [])
        if d in ticks:
            ticks.remove(d)
            return f"Routine décochée : {r['label']}"
        ticks.append(d)
        if len(ticks) > 400:           # borne l'historique des cases cochées
            del ticks[:len(ticks) - 400]
        return f"Routine faite : {r['label']}"

    if name == "remove_rappel":
        r = _sub(store.setdefault("rappels", []), op["id"], "Rappel")
        store["rappels"] = [x for x in store["rappels"] if x["id"] != op["id"]]
        return f"Routine supprimée : {r['label']}"

    # ---- Suivi du temps (chrono) ----------------------------------------- #
    if name == "clock_start":
        kind = op.get("kind") or "libre"
        label = (op.get("label") or "").strip()
        refs = {k: op.get(k) for k in ("chantier_id", "tache_id", "rappel_id") if op.get(k)}
        if not label and kind == "tache" and refs.get("chantier_id") and refs.get("tache_id"):
            ch = _chantier(store, refs["chantier_id"])
            label = _sub(ch["taches"], refs["tache_id"], "Tache")["label"]
        if not label and kind == "rappel" and refs.get("rappel_id"):
            label = _sub(store.setdefault("rappels", []), refs["rappel_id"], "Rappel")["label"]
        if not label:
            raise ValueError("Libellé requis pour démarrer le chrono.")
        _clock_start(store, kind, label, **refs)
        return f"Chrono démarré : {label}"

    if name == "clock_stop":
        if op.get("id"):
            s = _sub(store.setdefault("timelog", []), op["id"], "Session")
            if s.get("fin") is None:
                s["fin"] = _hm()
            return "Chrono arrêté"
        act = _clock_active(store)
        if not act:
            return "Aucun chrono en cours"
        _clock_close_all(store)
        return f"Chrono arrêté : {act[-1].get('label', '')}"

    if name == "clock_edit":
        s = _sub(store.setdefault("timelog", []), op["id"], "Session")
        if "label" in op and op["label"] is not None:
            s["label"] = str(op["label"]).strip() or s["label"]
        if "debut" in op and op["debut"]:
            s["debut"] = str(op["debut"]).strip()
        if "fin" in op:
            s["fin"] = (str(op["fin"]).strip() or None) if op["fin"] else None
        if "date" in op and op["date"]:
            s["date"] = op["date"]
        return "Session modifiée"

    if name == "clock_delete":
        _sub(store.setdefault("timelog", []), op["id"], "Session")
        store["timelog"] = [x for x in store["timelog"] if x["id"] != op["id"]]
        return "Session supprimée"

    if name == "clock_add":   # saisie manuelle d'une plage TERMINÉE (chose faite hors de l'appli)
        label = (op.get("label") or "").strip()
        if not label:
            raise ValueError("Libellé requis.")
        if not op.get("debut"):
            raise ValueError("Heure de début requise (HH:MM).")
        if not op.get("fin"):   # une plage manuelle est terminée -> sinon elle créerait un 2e chrono actif
            raise ValueError("Heure de fin requise pour une plage manuelle.")
        store.setdefault("timelog", []).append({
            "id": _uid("tl_"), "date": op.get("date") or today(),
            "debut": str(op["debut"]).strip(), "fin": str(op["fin"]).strip(),
            "kind": op.get("kind") or "libre", "label": label,
            "chantier_id": op.get("chantier_id"), "tache_id": op.get("tache_id"), "rappel_id": op.get("rappel_id"),
        })
        return f"Plage ajoutée : {label}"

    if name == "set_settings":
        store.setdefault("settings", {}).update(op.get("settings") or {})
        return "Réglages mis à jour"

    raise ValueError(f"Operation inconnue: {name}")
