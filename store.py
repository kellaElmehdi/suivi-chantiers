"""Stockage JSON du suivi des chantiers + application des operations.

Une seule fonction `apply_op` mute le store ; elle est utilisee par l'edition
de l'interface (UI -> /api/mutate), ce qui centralise la validation.

Modele :
- theme : maille TRANSVERSE, liste FERMEE de 10 au maximum. Un theme classe tout
  ce qui n'est pas un chantier (actions, notes, temps libre) et se choisit dans
  une liste : pas de saisie libre, donc pas de doublons ni de fautes de frappe.
- chantier : titre, statut, prio, echeance, date_debut (debut planning), objectif,
  blocage, theme_id, parties[], taches[], livrables[].
- tache : id, label, done, done_date, duree (jours), preds[] (ids de taches du
  meme chantier), is_milestone (jalon = duree 0). Le planning (dates, chemin
  critique, marges) est CALCULE cote interface a partir de duree+preds (CPM).
- livrable : ce que l'utilisateur attend d'une personne (statut, date, relances...).
- action : TOUT ce qui est "a faire" hors planning de chantier. Une routine est
  une action avec une `recurrence` ; une tache libre est une action sans. Les
  deux vivent dans la meme liste, donc un seul endroit ou regarder.
  L'historique est fait d'OCCURRENCES statuees (fait / saute / rate) et non de
  simples cases cochees : une occurrence ratee laisse une trace et alimente le
  taux de tenue, au lieu de disparaitre silencieusement.
- note : journal horodate (date + heure de saisie). Remplace `histo` : une note
  rattachee a un chantier EST son entree d'historique.
"""

from __future__ import annotations

import base64
import json
import os
import re
import unicodedata
import uuid
from datetime import date, datetime, timedelta

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STORE_PATH = os.path.join(DATA_DIR, "store.json")
FICHIERS_DIR = os.path.join(DATA_DIR, "fichiers")   # binaires des pieces jointes (voir plus bas)

STATUTS = {"todo", "doing", "block", "recette", "done"}
PRIOS = {"h", "m", "b"}
LIV_STATUTS = {"attente", "recu", "partiel", "annule"}
RETOUR_STATUTS = {"a_traiter", "en_cours", "fait", "rejete"}   # legacy : retours d'iteration, migres en points

# --- Recette --------------------------------------------------------------- #
# Une recette = UNE LISTE DE POINTS A VERIFIER. Trois etats, pas un de plus :
# a verifier, verifie, probleme. Un probleme porte son constat, qui corrige et
# pour quand — il n'y a pas d'objet « anomalie » separe a maintenir en double.
# Ce qui compte a cote, c'est le TEMPS passe : il se chronometre tout seul des
# qu'on statue un point (voir `point_set`).
POINT_STATUTS = {"a_verifier", "ok", "probleme"}

RISQUE_STATUTS = {"ouvert", "maitrise", "avere", "clos"}   # cote / maitrise / avere / clos
CDC_STATUTS = {"brouillon", "en_validation", "valide", "obsolete"}   # cycle de vie d'un cahier des charges
RAPPEL_FREQS = {"jour", "semaine", "mois", "ponctuel"}              # legacy : recurrence des anciennes routines
ACTION_FREQS = {"jour", "semaine", "mois"}          # une action recurrente = routine ("ponctuel" = action sans recurrence)
OCC_STATUTS = {"fait", "saute", "rate"}             # occurrence d'une routine : tenue / sautee volontairement / ratee
NOTE_TYPES = {"note", "reunion", "decision", "idee"}
THEMES_MAX = 10                                     # liste FERMEE : la contrainte est la fonctionnalite

# Palette des themes : teintes distinctes, lisibles en clair comme en sombre.
THEME_COULEURS = ["#2563eb", "#0d9488", "#d97706", "#7c3aed", "#dc2626",
                  "#0891b2", "#65a30d", "#db2777", "#4f46e5", "#78716c"]

# Themes de depart, deduits du portefeuille reel. `motifs` sert UNE SEULE FOIS, a
# la migration : les anciens tags libres et les titres de chantiers y sont
# confrontes pour pre-affecter chaque chantier. Ensuite les tags disparaissent.
THEMES_DEFAUT = [
    ("Atelier & Production", "🏭", ["mes ", "komugi", "atelier", "of numerique", "outillage",
                                    "usinage", "maintenance", "mainsim", "production", "immersion"]),
    ("BI & Reporting",       "📊", ["power bi", "powerbi", "bi", "dashboard", "kpi", "indicateur",
                                    "analytique", "pilotage", "reporting", "power querry", "power query"]),
    ("Achats & Fournisseurs", "🛒", ["achat", "fournisseur", "appro", "commande", "bomcreator", "lancement"]),
    ("SI, Infra & Collaboration", "🛡", ["sharepoint", "portail", "zeendoc", "documentaire", "cyber",
                                         "infra", "securetech", "collaboration", "communication", "partage"]),
    ("Methodes & CAO",       "📐", ["cao", "methode", "nomenclature", "plan", "indice", "cad", "visiativ"]),
    ("ERP & Donnees",        "🗄", ["erp", "silog", "gp9000", "sage", "compta", "data", "donnee",
                                    "client", "dedoublonnage", "export"]),
    ("Qualite",              "✅", ["qualite", "non-conformite", "non conformite", "nc", "soudage", "audit"]),
    ("IA",                   "🤖", ["ia", "intelligence artificielle", "fabera"]),
    ("RH & Formation",       "🎓", ["rh", "formation", "factorial", "recrutement"]),
    ("Commerce & Client",    "🤝", ["crm", "commerce", "commercial", "devis", "vente"]),
]


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
    "moi": ("Elmehdi KELLA", "Chef de projet SI / IT", True),
    "toi": ("Elmehdi KELLA", "Chef de projet SI / IT", True),
    "kella": ("Elmehdi KELLA", "Chef de projet SI / IT", True),
    "elmehdi": ("Elmehdi KELLA", "Chef de projet SI / IT", True),
    "elmehdi kella": ("Elmehdi KELLA", "Chef de projet SI / IT", True),
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


def _shift_iso(iso: str | None, days: int) -> str | None:
    """Decale une date ISO de `days` jours calendaires (None reste None)."""
    if not iso or not days:
        return iso
    try:
        return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()
    except ValueError:
        return iso


def _replan_unfinished(ch: dict, days: int) -> None:
    """Décale de `days` jours le planning prévisionnel RESTANT d'un chantier.

    Utilisé à la reprise d'une pause (le gel fige le plan, la reprise le fait
    glisser) et par la replanification manuelle. On ne touche QU'aux cibles
    des travaux non finis :
      - échéance du chantier, débuts imposés des tâches non finies,
        dates attendues des livrables non reçus,
      - référence figée (baseline) des SEULES tâches non terminées.
    On NE bouge PAS `date_debut` (sinon les tâches déjà faites, ancrées sur
    leurs dates réelles passées, se replieraient sur le nouveau début), ni
    aucune date d'exécution réelle (start_date / done_date / réception) : ce
    sont des faits acquis qui restent à leur place dans l'historique.
    """
    if days <= 0:
        return
    done_ids = {t["id"] for t in ch.get("taches", []) if t.get("done")}
    ch["echeance"] = _shift_iso(ch.get("echeance"), days)
    for t in ch.get("taches", []):
        if not t.get("done"):
            t["start_fix"] = _shift_iso(t.get("start_fix"), days)
    for l in ch.get("livrables", []):
        if l.get("statut") != "recu":                 # livrable encore attendu : sa date attendue glisse
            l["date"] = _shift_iso(l.get("date"), days)
    bl = ch.get("baseline")
    if bl:
        bl["project_end"] = _shift_iso(bl.get("project_end"), days)
        bl["echeance"] = _shift_iso(bl.get("echeance"), days)
        for bt in bl.get("tasks", []):
            if bt.get("id") not in done_ids:          # la réf des tâches finies reste un fait historique
                bt["start"] = _shift_iso(bt.get("start"), days)
                bt["end"] = _shift_iso(bt.get("end"), days)


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
    """Ferme la session.

    Un arret EXPLICITE enregistre l'heure reelle, meme au-dela de la fin de
    journee reglee : on travaille parfois plus tard, et tronquer effacerait du
    travail fait. La fin de journee n'est un filet que pour un chrono OUBLIE un
    jour passe — et meme la, jamais avant l'heure de debut.
    """
    if s.get("date") != today():                    # chrono d'un jour passe : filet
        jf = _day_end(store, s.get("date") or today())
        s["fin"] = max(jf, s.get("debut") or jf)
    else:
        now = _hm()
        s["fin"] = max(now, s.get("debut") or now)


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
            "action_id": refs.get("action_id"), "iteration_id": refs.get("iteration_id"),
            "point_id": refs.get("point_id"), "theme_id": refs.get("theme_id")}
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
    ("Documents applicables et de référence",
     "Référence, indice et emplacement de chaque document cité ou opposable."),
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


def _cle_titre(titre: str) -> str:
    """Titre reduit a l'essentiel (minuscules, sans accent ni ponctuation), pour
    recoller une section revenue de Word meme si la casse ou un accent a bouge."""
    t = unicodedata.normalize("NFKD", titre or "").encode("ascii", "ignore").decode()
    return "".join(c for c in t.lower() if c.isalnum())


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
# Recette — la liste des points a verifier avant de considerer un chantier livre.
#
# Volontairement pauvre : pas de campagnes, pas d'anomalies separees, pas de
# proces-verbal. Un point porte tout ce qu'il faut savoir quand il coince
# (constat, qui corrige, pour quand), et rien de plus.
# --------------------------------------------------------------------------- #
def _new_recette() -> dict:
    return {"points": []}


def _new_point(titre: str) -> dict:
    return {"id": _uid("pt_"), "titre": titre, "statut": "a_verifier",
            "constat": "", "qui": "", "echeance": None,
            "cree_le": today(), "debut": None, "verifie_le": None}


def _recette_stats(ch: dict) -> dict:
    """Combien de points verifies, combien coincent."""
    pts = (ch.get("recette") or {}).get("points", [])
    par = {"a_verifier": 0, "ok": 0, "probleme": 0}
    for p in pts:
        par[p.get("statut", "a_verifier")] = par.get(p.get("statut", "a_verifier"), 0) + 1
    return {"total": len(pts), **par,
            "pct": round(par["ok"] / len(pts) * 100) if pts else 0,
            # « fini » = tout verifie, rien en probleme. C'est ce qui remplace le PV.
            "fini": bool(pts) and par["ok"] == len(pts)}


# --------------------------------------------------------------------------- #
# Absences — jours non travaillés (congés, RTT, jours fériés).
#
# Une absence est une PÉRIODE [debut, fin] inclusive. Le planning (CPM, plan de
# charge, Gantt) est calculé cote interface : store.py ne porte que la donnée,
# app.js en derive l'ensemble des dates a exclure (voir `offDays()` / `isOff()`).
#
# Une absence PÈSE sur le planning si elle me concerne (contact_id vide = moi)
# ou si c'est un jour férié (qui vaut pour tout le monde). Une absence rattachée
# à un autre contact est purement informative : sans affectation des taches aux
# personnes, on ne saurait pas quelles dates décaler.
# --------------------------------------------------------------------------- #
ABSENCE_TYPES = {"conge", "rtt", "ferie", "recup", "formation", "maladie", "autre"}
ABSENCE_LABELS = {"conge": "Congés", "rtt": "RTT", "ferie": "Férié", "recup": "Récupération",
                  "formation": "Formation", "maladie": "Arrêt maladie", "autre": "Absence"}


def _easter(year: int) -> date:
    """Dimanche de Pâques (algorithme grégorien anonyme)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mois = (h + l - 7 * m + 114) // 31
    jour = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, mois, jour)


def feries_fr(year: int) -> list[tuple[str, str]]:
    """Les 11 jours fériés français (métropole) d'une année : [(date ISO, nom)]."""
    p = _easter(year)
    jours = [
        (date(year, 1, 1), "Jour de l'An"),
        (p + timedelta(days=1), "Lundi de Pâques"),
        (date(year, 5, 1), "Fête du Travail"),
        (date(year, 5, 8), "Victoire 1945"),
        (p + timedelta(days=39), "Ascension"),
        (p + timedelta(days=50), "Lundi de Pentecôte"),
        (date(year, 7, 14), "Fête nationale"),
        (date(year, 8, 15), "Assomption"),
        (date(year, 11, 1), "Toussaint"),
        (date(year, 11, 11), "Armistice 1918"),
        (date(year, 12, 25), "Noël"),
    ]
    return [(d.isoformat(), nom) for d, nom in sorted(jours)]


def _absence_jours(a: dict) -> int:
    """Nombre de jours OUVRÉS (hors week-end) couverts par une absence."""
    try:
        d, f = date.fromisoformat(a["debut"]), date.fromisoformat(a["fin"])
    except (ValueError, TypeError, KeyError):
        return 0
    n = 0
    while d <= f:
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return n


def _absence_overlap(store: dict, debut: str, fin: str, typ: str, contact_id,
                     skip_id: str | None = None) -> dict | None:
    """Première absence existante qui fait DOUBLON avec la période.

    Deux absences ne se chevauchent que si elles décrivent la même chose :
    - même personne (deux personnes peuvent évidemment être absentes en même temps) ;
    - même couche : les jours fériés forment un calendrier à part, des congés
      posés autour du 14 juillet ne sont pas un doublon du férié qu'ils englobent.
    """
    for a in store.get("absences", []):
        if a.get("id") == skip_id:
            continue
        if (a.get("type") == "ferie") != (typ == "ferie"):
            continue
        if (a.get("contact_id") or None) != (contact_id or None):
            continue
        if a.get("debut", "") <= fin and debut <= a.get("fin", ""):
            return a
    return None


# --------------------------------------------------------------------------- #
# Journal d'actions (suivi de progression hebdo). Chaque mutation y dépose une
# ligne horodatée — le message lisible est déjà produit par _apply_op.
# --------------------------------------------------------------------------- #
JOURNAL_SKIP = {"set_settings", "cdc_section_update", "cdc_section_move",
                "action_update", "action_reorder", "note_update", "note_pin",
                "theme_update", "theme_move",
                "clock_start", "clock_stop", "clock_edit", "clock_delete", "clock_add",
                "update_subtask", "apply_template",
                "rapport_update", "rapport_point_update",       # rédaction du rapport hebdo :
                "rapport_point_add", "rapport_point_remove",    # bruit d'édition, pas une action
                "rapport_hc_remove", "rapport_hc_reset",
                "rapport_retard_update"}
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
# Rapport hebdomadaire — bilan de semaine, programme à venir, REX.
#
# Principe (base de l'automatisation) : tout ce qui est DÉDUCTIBLE des données
# est calculé ici (`_rapport_facts`) et rangé dans des champs `auto` / `stats` /
# `avenir`, recalculables à volonté tant que le rapport est en brouillon. La
# rédaction humaine (synthèse, avancement par point, REX par point, REX général,
# priorités) vit dans des champs séparés que le recalcul n'écrase JAMAIS.
# Automatiser plus tard = générer un brouillon de texte à partir de `auto`,
# sans changer ni le modèle ni l'UI.
# --------------------------------------------------------------------------- #
RAPPORT_STATUTS = {"brouillon", "finalise"}
RAPPORT_HORIZON = 14      # jours couverts par « à venir » au-delà de la semaine


def _week_bounds(semaine: str) -> tuple[str, str]:
    """'2026-W30' -> (lundi, dimanche) en ISO."""
    try:
        y, w = semaine.upper().split("-W")
        monday = date.fromisocalendar(int(y), int(w), 1)
    except Exception:
        raise ValueError("Semaine invalide (format attendu : AAAA-Wnn).")
    return monday.isoformat(), (monday + timedelta(days=6)).isoformat()


def _hm_min(h) -> int:
    try:
        a, b = (str(h or "0:0").split(":") + ["0"])[:2]
        return int(a) * 60 + int(b or 0)
    except (TypeError, ValueError):
        return 0


def _sess_min(store: dict, s: dict) -> int:
    """Durée d'une session en minutes — mêmes règles que l'UI (sessMin) :
    session active bornée à maintenant / fin de journée, pause déjeuner
    déduite (aucune le vendredi)."""
    d = s.get("date") or ""
    fin = s.get("fin")
    if not fin:
        # un chrono en cours AUJOURD'HUI court jusqu'a maintenant, sans plafond :
        # demarre a 18:24 et il est 18:30, cela fait 6 min, pas 23 h.
        if d < today():
            de = _day_end(store, d)                 # jour passe : filet, jamais avant le debut
            fin = max(de, s.get("debut") or de)
        else:
            fin = _hm()
    deb = s.get("debut") or "00:00"
    m = _hm_min(fin) - _hm_min(deb)
    if m < 0:
        m += 1440
    try:
        vendredi = bool(d) and date.fromisoformat(d).weekday() == 4
    except ValueError:
        vendredi = False
    if not vendredi:
        stg = store.get("settings", {})
        pd, pf = stg.get("pause_debut") or "", stg.get("pause_fin") or ""
        if pd and pf and pf > pd:
            m -= max(0, min(_hm_min(fin), _hm_min(pf)) - max(_hm_min(deb), _hm_min(pd)))
    return max(0, m)


def _moi_nom(store: dict) -> str:
    """Nom du contact marqué « moi » — sert de visa (traçabilité)."""
    ct = next((c for c in store.get("contacts", []) if c.get("moi")), None)
    return (ct or {}).get("nom", "")


def _ch_fin_date(c: dict) -> str:
    """Date de fin effective d'un chantier : dernière tâche complétée."""
    d = ""
    for t in c.get("taches", []):
        if t.get("done") and t.get("done_date") and t["done_date"] > d:
            d = t["done_date"]
    return d


def _ch_pct(c: dict) -> int:
    """Avancement d'un chantier : part des tâches complétées."""
    taches = c.get("taches", [])
    return round(100 * sum(1 for t in taches if t.get("done")) / len(taches)) if taches else 0


def _rapport_auto_ctx(c: dict) -> dict:
    """Photo du chantier au moment du calcul (affichée sur le point)."""
    taches = c.get("taches", [])
    return {"statut": c.get("statut", "todo"), "hold": bool(c.get("hold")),
            "pct": _ch_pct(c),
            "echeance": c.get("echeance"), "prio": c.get("prio", "m"),
            # tâches démarrées non finies : le « en ce moment » du chantier
            "en_cours": [{"label": t.get("label", ""), "depuis": t.get("start_date")}
                         for t in taches
                         if t.get("start_date") and not t.get("done") and not t.get("is_milestone")]}


def _rapport_auto_vide(c: dict | None) -> dict:
    base = {"taches": [], "notes": [], "recette": [], "relances": 0,
            "temps_min": 0, "actions": 0}
    if c:
        base.update(_rapport_auto_ctx(c))
    return base


def _rapport_facts(store: dict, debut: str, fin: str) -> dict:
    """Faits de la semaine [debut..fin] + programme à venir, déduits des données
    (tâches finies, notes, temps chronométré, journal, échéances, jalons…)."""
    by_id = {c.get("id"): c for c in store.get("chantiers", [])}
    pts: dict[str, dict] = {}

    def _pt(cid):
        if cid not in pts:
            pts[cid] = {"taches": [], "notes": [], "recette": [],
                        "relances": 0, "temps_min": 0, "actions": 0}
        return pts[cid]

    for c in store.get("chantiers", []):
        cid = c.get("id")
        for t in c.get("taches", []):
            dd = t.get("done_date")
            if t.get("done") and dd and debut <= dd <= fin:
                _pt(cid)["taches"].append({"label": t.get("label", ""), "date": dd,
                                           "jalon": bool(t.get("is_milestone"))})
        for n in _chantier_notes(store, cid):   # notes posées au fil de la semaine -> remontent seules
            if n.get("date") and debut <= n["date"] <= fin:
                # une note n'est PAS une tâche : elle garde son type, son titre et son
                # heure pour être restituée comme un compte rendu, pas comme une ligne faite.
                # `id` = la note d'origine, pour pouvoir la retirer durablement du rapport.
                _pt(cid)["notes"].append({"id": n.get("id"), "d": n["date"], "h": n.get("heure", ""),
                                          "type": n.get("type", "note"),
                                          "titre": n.get("titre", ""),
                                          "t": n.get("corps", "")})
        for l in c.get("livrables", []):
            if l.get("derniere") and debut <= l["derniere"] <= fin:
                _pt(cid)["relances"] += 1
        for pt in (c.get("recette") or {}).get("points", []):
            # points verifies dans la semaine, et problemes encore ouverts
            if pt.get("statut") == "ok" and pt.get("verifie_le")                and debut <= pt["verifie_le"] <= fin:
                _pt(cid)["recette"].append({"quoi": pt.get("titre", ""), "statut": "ok"})
            elif pt.get("statut") == "probleme" and pt.get("cree_le")                     and debut <= pt["cree_le"] <= fin:
                _pt(cid)["recette"].append({"quoi": pt.get("titre", ""), "statut": "probleme",
                                            "qui": pt.get("qui", "")})
    actions = 0
    for j in store.get("journal", []):
        jd = j.get("date")
        if jd and debut <= jd <= fin:
            actions += 1
            if j.get("chantier_id") in by_id:
                _pt(j["chantier_id"])["actions"] += 1
    temps_total = 0
    temps_kinds: dict[str, int] = {}   # tache / action / recette / libre (réunions, RDV…)
    temps_themes: dict[str, int] = {}  # ventilation transverse : où part le temps, chantier ou pas
    hors: dict[str, dict] = {}         # travail sans chantier : réunions, RDV, routines…
    ch_theme = {c.get("id"): c.get("theme_id") for c in store.get("chantiers", [])}
    act_theme = {a.get("id"): a.get("theme_id") for a in store.get("actions", [])}
    for s in store.get("timelog", []):
        sd = s.get("date")
        if sd and debut <= sd <= fin:
            m = _sess_min(store, s)
            temps_total += m
            k = s.get("kind") or "libre"
            temps_kinds[k] = temps_kinds.get(k, 0) + m
            # le thème de la plage : le sien, sinon celui de son chantier, sinon celui de son action
            th = s.get("theme_id") or ch_theme.get(s.get("chantier_id")) or act_theme.get(s.get("action_id"))
            temps_themes[th or "_sans"] = temps_themes.get(th or "_sans", 0) + m
            if s.get("chantier_id") in by_id:
                _pt(s["chantier_id"])["temps_min"] += m
            else:   # hors chantier : agrégé par libellé pour figurer au bilan
                lbl = (s.get("label") or "").strip() or ("Routine" if k == "action" else "Divers")
                hx = hors.setdefault(lbl, {"label": lbl, "kind": k, "temps_min": 0, "jours": []})
                hx["temps_min"] += m
                if sd not in hx["jours"]:
                    hx["jours"].append(sd)
    # Une plage a 0 min n'est pas du temps : elle encombrerait la carte « temps hors
    # chantier » (l'action, elle, figure de toute facon dans les actions/routines).
    hors_chantier = sorted((x for x in hors.values() if x["temps_min"] > 0),
                           key=lambda x: -x["temps_min"])[:12]
    # Actions hors chantier faites dans la semaine + tenue des routines : la part
    # du travail que le planning des chantiers ne voit pas.
    actions_faites, routines_tenue = [], []
    for a in store.get("actions", []):
        if a.get("recurrence"):
            dus = [o for o in a.get("occurrences", []) if debut <= (o.get("date") or "") <= fin]
            faits = [o for o in dus if o.get("statut") == "fait"]
            rates = [o for o in dus if o.get("statut") == "rate"]
            if dus:
                routines_tenue.append({"id": a.get("id"), "label": a.get("label", ""),
                                       "theme_id": a.get("theme_id"),
                                       "faits": len(faits), "rates": len(rates), "total": len(dus)})
        elif a.get("done") and a.get("done_date") and debut <= a["done_date"] <= fin:
            actions_faites.append({"id": a.get("id"), "label": a.get("label", ""),
                                   "date": a["done_date"],
                                   "theme_id": a.get("theme_id"), "chantier_id": a.get("chantier_id")})
    actions_faites.sort(key=lambda x: x["date"])
    routines_tenue.sort(key=lambda x: (x["faits"] / x["total"]) if x["total"] else 0)
    # Notes de la semaine sans chantier : matière brute pour la synthèse et le REX.
    notes_libres = [{"id": n.get("id"),
                     "date": n.get("date"), "heure": n.get("heure"), "type": n.get("type"),
                     "titre": n.get("titre", ""), "corps": n.get("corps", ""),
                     "theme_id": n.get("theme_id")}
                    for n in store.get("notes", [])
                    if not n.get("chantier_id") and debut <= (n.get("date") or "") <= fin]
    notes_libres.sort(key=lambda n: (n["date"] or "", n["heure"] or ""))
    # Un point n'existe que s'il a de la MATIÈRE (tâche finie, note, temps,
    # relance, retour). De simples éditions de fiche (journal seul) ne créent
    # pas de carte « aucun fait détecté » — l'ajout manuel reste possible.
    pts = {cid: p for cid, p in pts.items()
           if p["taches"] or p["notes"] or p["recette"]
           or p["relances"] or p["temps_min"]}
    for cid, p in pts.items():
        p.update(_rapport_auto_ctx(by_id[cid]))
        p["taches"].sort(key=lambda t: t["date"])
        p["notes"].sort(key=lambda n: n["d"])

    # Chantiers terminés pendant la semaine (fin = dernière tâche complétée).
    termines = []
    for c in store.get("chantiers", []):
        if c.get("statut") == "done":
            fd = _ch_fin_date(c)
            if fd and debut <= fd <= fin:
                termines.append({"chantier_id": c.get("id"), "chantier": c.get("titre", ""),
                                 "date": fd})
    termines.sort(key=lambda x: x["date"])

    # Retards à date : échéance dépassée sur un chantier PAS ENCORE LIVRÉ
    # (à faire / en cours). Un chantier en recette n'est pas en retard : le
    # travail est fait, on attend la validation — il est signalé dans la liste
    # « en attente de recette » (avec l'échéance dépassée à titre indicatif).
    # La justification est OBLIGATOIRE avant finalisation (saisie manuelle,
    # conservée d'un recalcul à l'autre).
    retards = []
    for c in store.get("chantiers", []):
        ech = c.get("echeance")
        if c.get("statut") in ("todo", "doing") and not c.get("hold") and ech and ech < today():
            try:
                jours = (date.today() - date.fromisoformat(ech)).days
            except ValueError:
                jours = 0
            retards.append({"chantier_id": c.get("id"), "chantier": c.get("titre", ""),
                            "echeance": ech, "jours": jours, "justification": ""})
    retards.sort(key=lambda x: x["echeance"])

    # Gantt global du portefeuille (photo au moment du calcul, figée avec le
    # rapport) : chantiers ouverts + ceux terminés cette semaine.
    gantt = []
    for c in store.get("chantiers", []):
        if c.get("hold"):
            continue
        fini = c.get("statut") == "done"
        fdate = _ch_fin_date(c) if fini else ""
        if fini and not (fdate and debut <= fdate <= fin):
            continue
        g_deb = c.get("date_debut") or debut
        g_fin = c.get("echeance") or (fdate if fini else _shift_iso(fin, RAPPORT_HORIZON))
        if g_fin < g_deb:
            g_fin = g_deb
        ctx = _rapport_auto_ctx(c)
        gantt.append({"chantier_id": c.get("id"), "chantier": c.get("titre", ""),
                      "debut": g_deb, "fin": g_fin, "statut": c.get("statut", "todo"),
                      "pct": ctx["pct"],
                      # même règle que les retards : livré (recette) = pas en retard
                      "late": c.get("statut") in ("todo", "doing")
                              and bool(c.get("echeance")) and c["echeance"] < today(),
                      "sans_echeance": not c.get("echeance") and not fini})
    gantt.sort(key=lambda g: (g["fin"], g["debut"]))

    encours_pcts = [_ch_pct(c) for c in store.get("chantiers", [])
                    if c.get("statut") == "doing" and not c.get("hold")]
    stats = {"chantiers": len(pts),
             "en_cours": len(encours_pcts),
             # avancement global du portefeuille en cours (moyenne des %)
             "avancement": round(sum(encours_pcts) / len(encours_pcts)) if encours_pcts else 0,
             "termines": len(termines), "retards": len(retards),
             "taches": sum(len(p["taches"]) for p in pts.values()),
             "jalons": sum(1 for p in pts.values() for t in p["taches"] if t["jalon"]),
             "notes": sum(len(p["notes"]) for p in pts.values()) + len(notes_libres),
             "notes_ch": sum(len(p["notes"]) for p in pts.values()),
             "notes_libres": len(notes_libres),
             "temps_min": temps_total, "temps_kinds": temps_kinds,
             # `journal` = mouvements journalises (editions de fiches). A ne pas
             # confondre avec `actions_faites` : les ACTIONS sont des objets du modele
             # (taches libres + routines) depuis la refonte, `actions` reste pour les
             # rapports d'avant cette refonte.
             "temps_themes": temps_themes, "journal": actions, "actions": actions,
             "actions_faites": len(actions_faites),
             "routines_ok": sum(x["faits"] for x in routines_tenue),
             "routines_dues": sum(x["total"] for x in routines_tenue)}

    # -- Programmé pour la suite : semaine suivante + horizon ---------------- #
    horizon = _shift_iso(fin, RAPPORT_HORIZON)
    av = {"echeances": [], "jalons": [], "livrables": [], "risques": [],
          "rappels": [], "recette": [], "prochaines": []}
    for c in store.get("chantiers", []):
        if c.get("statut") == "done" or c.get("hold"):
            continue
        cid, titre = c.get("id"), c.get("titre", "")
        ech = c.get("echeance")
        if ech and ech <= horizon:
            # même règle que les retards : seul un chantier PAS ENCORE LIVRÉ est
            # « en retard ». L'échéance passée d'un chantier en recette ne figure
            # pas ici (elle est annotée dans la liste « en attente de recette »).
            en_livraison = c.get("statut") in ("todo", "doing")
            if en_livraison or ech >= today():
                av["echeances"].append({"chantier_id": cid, "chantier": titre,
                                        "date": ech,
                                        "late": en_livraison and ech < today()})
        if c.get("statut") == "recette":
            dep = 0
            if ech and ech < today():
                try:
                    dep = (date.today() - date.fromisoformat(ech)).days
                except ValueError:
                    dep = 0
            st_rec = _recette_stats(c)
            av["recette"].append({"chantier_id": cid, "chantier": titre, "echeance": ech,
                                  "depasse_j": dep, "points": st_rec["total"],
                                  "verifies": st_rec["ok"], "problemes": st_rec["probleme"],
                                  "restants": st_rec["a_verifier"]})
        if c.get("statut") in ("doing", "recette"):
            done_ids = {t["id"] for t in c.get("taches", []) if t.get("done")}
            for t in c.get("taches", []):
                if not t.get("done") and t.get("is_milestone"):
                    av["jalons"].append({"chantier_id": cid, "chantier": titre,
                                         "label": t.get("label", "")})
            libres = [t.get("label", "") for t in c.get("taches", [])
                      if not t.get("done") and not t.get("is_milestone")
                      and all(p in done_ids for p in t.get("preds", []))]
            if libres:
                av["prochaines"].append({"chantier_id": cid, "chantier": titre,
                                         "taches": libres[:3]})
        for l in c.get("livrables", []):
            if l.get("statut") in ("attente", "partiel") and l.get("date") and l["date"] <= horizon:
                av["livrables"].append({"chantier_id": cid, "chantier": titre,
                                        "personne": l.get("personne", ""),
                                        "quoi": l.get("quoi", ""),
                                        "date": l["date"], "late": l["date"] < today()})
        for rk in c.get("risques", []):
            if rk.get("statut") in ("ouvert", "avere") and rk.get("echeance_revue") \
               and rk["echeance_revue"] <= horizon:
                av["risques"].append({"chantier_id": cid, "chantier": titre,
                                      "libelle": rk.get("libelle", ""),
                                      "date": rk["echeance_revue"]})
    for a in store.get("actions", []):   # actions ponctuelles à échéance dans l'horizon
        if a.get("actif") and not a.get("recurrence") and not a.get("done") \
           and a.get("echeance") and a["echeance"] <= horizon:
            av["rappels"].append({"label": a.get("label", ""), "date": a["echeance"],
                                  "theme_id": a.get("theme_id"),
                                  "late": a["echeance"] < today()})
    for k in ("echeances", "livrables", "risques", "rappels"):
        av[k].sort(key=lambda x: x.get("date") or "")
    return {"points": pts, "stats": stats, "avenir": av,
            "termines": termines, "retards": retards, "gantt": gantt,
            "hors_chantier": hors_chantier,
            "actions_faites": actions_faites, "routines_tenue": routines_tenue,
            "notes_libres": notes_libres,
            "themes": [{"id": t["id"], "nom": t["nom"], "couleur": t["couleur"],
                        "icone": t.get("icone", "•")} for t in _themes(store)],
            "titres": {cid: by_id[cid].get("titre", "") for cid in pts}}


def _hc_cles(famille: str, o: dict) -> list:
    """Cles sous lesquelles une ligne calculee peut avoir ete ecartee.

    Par identifiant (ce que le client envoie des qu'il en voit un) ET par contenu
    (les rapports etablis avant l'ajout des ids n'en portent pas). Les deux, sinon
    une exclusion posee sur d'anciennes donnees serait perdue au premier recalcul —
    justement celui qui ecrit les ids. Cote client : hcCle dans app.js.
    """
    cles = []
    if o.get("id"):
        cles.append(f"{famille}:{o['id']}")
    if famille == "note":
        cles.append(f"note#{o.get('d') or o.get('date') or ''}|{o.get('titre') or ''}")
    else:
        cles.append(f"{famille}#{o.get('label') or ''}")
    return cles


def _hc_total(r: dict) -> int:
    """Nombre de lignes calculees encore affichees (sert a verifier qu'un retrait retire.)"""
    return (len(r.get("notes_libres") or []) + len(r.get("actions_faites") or [])
            + len(r.get("routines_tenue") or []) + len(r.get("hors_chantier") or [])
            + sum(len((p.get("auto") or {}).get("notes") or []) for p in r.get("points", [])))


def _rapport_masque(r: dict) -> None:
    """Retire du rapport les elements ecartes a la main (`exclus_hc`).

    Les faits sont recalcules a chaque « Actualiser » : sans liste d'exclusion
    persistante, une ligne retiree reviendrait au recalcul suivant. Cle =
    "<famille>:<id>" — note / action / routine / temps (temps = le libelle agrege).
    Les compteurs affiches en KPI suivent le masquage, sinon le rapport se
    contredirait (« 3 actions » au-dessus d'une liste qui n'en montre que 2).
    """
    ex = set(r.get("exclus_hc") or [])
    if ex:
        garde = lambda fam, o: not any(c in ex for c in _hc_cles(fam, o))
        r["notes_libres"] = [n for n in r.get("notes_libres", []) if garde("note", n)]
        r["actions_faites"] = [a for a in r.get("actions_faites", []) if garde("action", a)]
        r["routines_tenue"] = [a for a in r.get("routines_tenue", []) if garde("routine", a)]
        r["hors_chantier"] = [x for x in r.get("hors_chantier", []) if garde("temps", x)]
        for p in r.get("points", []):
            auto = p.get("auto") or {}
            auto["notes"] = [n for n in auto.get("notes", []) if garde("note", n)]
    st = r.get("stats")
    if not isinstance(st, dict):
        return
    st["actions_faites"] = len(r.get("actions_faites", []))
    st["routines_ok"] = sum(x.get("faits", 0) for x in r.get("routines_tenue", []))
    st["routines_dues"] = sum(x.get("total", 0) for x in r.get("routines_tenue", []))
    st["notes_libres"] = len(r.get("notes_libres", []))
    st["notes_ch"] = sum(len((p.get("auto") or {}).get("notes", [])) for p in r.get("points", []))
    st["notes"] = st["notes_ch"] + st["notes_libres"]


def _rapport(store: dict, rid: str) -> dict:
    r = next((x for x in store.setdefault("rapports", []) if x.get("id") == rid), None)
    if r is None:
        raise ValueError(f"Rapport introuvable: {rid}")
    return r


# --------------------------------------------------------------------------- #
# Themes — liste fermee (10 max), maille transverse
# --------------------------------------------------------------------------- #
def _themes(store: dict) -> list:
    return store.setdefault("themes", [])


def _theme(store: dict, tid: str) -> dict:
    t = next((x for x in _themes(store) if x.get("id") == tid), None)
    if t is None:
        raise ValueError(f"Theme introuvable: {tid}")
    return t


def _theme_actifs(store: dict) -> list:
    return [t for t in _themes(store) if not t.get("archive")]


def _theme_id_valide(store: dict, tid):
    """Un theme_id inconnu (ou archive supprime) retombe sur None plutot que d'echouer."""
    if not tid:
        return None
    return tid if any(t.get("id") == tid for t in _themes(store)) else None


def _theme_libre(store: dict) -> str:
    """Prochaine couleur non utilisee, pour que deux themes ne se ressemblent pas."""
    pris = {t.get("couleur") for t in _themes(store)}
    for c in THEME_COULEURS:
        if c not in pris:
            return c
    return THEME_COULEURS[len(_themes(store)) % len(THEME_COULEURS)]


def _devine_theme(store: dict, textes: list) -> str | None:
    """Pre-affectation a la migration : confronte les anciens tags + le titre aux motifs."""
    blob = " ".join(str(t or "").lower() for t in textes)
    # sans accents, pour que "Qualite" attrape "Qualité" et "donnees" attrape "données"
    for a, b in (("é", "e"), ("è", "e"), ("ê", "e"), ("à", "a"), ("â", "a"),
                 ("î", "i"), ("ï", "i"), ("ô", "o"), ("û", "u"), ("ù", "u"), ("ç", "c")):
        blob = blob.replace(a, b)
    best, best_score = None, 0
    for th in _themes(store):
        score = sum(len(m) for m in th.get("motifs", []) if m in blob)
        if score > best_score:
            best, best_score = th.get("id"), score
    return best


def _migrate_themes(store: dict) -> None:
    """Cree la liste fermee, pre-affecte les chantiers depuis leurs tags, puis jette les tags.

    Les 36 tags libres d'origine (dont 30 uniques, et un « Power Querry ») ne servaient
    a rien comme axe de filtrage ; ils servent ici une derniere fois a deviner le theme.
    """
    if store.get("themes") is not None:
        return                                    # deja migre
    store["themes"] = [
        {"id": _uid("th_"), "nom": nom, "icone": icone,
         "couleur": THEME_COULEURS[i % len(THEME_COULEURS)],
         "ordre": i, "archive": False, "motifs": motifs}
        for i, (nom, icone, motifs) in enumerate(THEMES_DEFAUT)
    ]
    for c in store.get("chantiers", []):
        if not c.get("theme_id"):
            c["theme_id"] = _devine_theme(store, list(c.get("tags") or []) + [c.get("titre", "")])
        c.pop("tags", None)                       # le tag libre disparait du modele
    for th in store["themes"]:                    # les motifs n'ont servi qu'a la migration
        th.pop("motifs", None)


# --------------------------------------------------------------------------- #
# Actions — taches libres ET routines dans une seule liste
# --------------------------------------------------------------------------- #
def _actions(store: dict) -> list:
    return store.setdefault("actions", [])


def _action(store: dict, aid: str) -> dict:
    a = next((x for x in _actions(store) if x.get("id") == aid), None)
    if a is None:
        raise ValueError(f"Action introuvable: {aid}")
    return a


def _norm_recurrence(rec):
    """None = action ponctuelle. Sinon {freq, jours[], jour_mois} valide."""
    if not rec:
        return None
    freq = rec.get("freq") or "jour"
    if freq not in ACTION_FREQS:
        raise ValueError(f"Frequence invalide: {freq}")
    jours = sorted({int(x) for x in (rec.get("jours") or [])
                    if str(x).isdigit() and 0 <= int(x) <= 6})
    jm = rec.get("jour_mois")
    if jm == "fin":                               # dernier jour du mois : ce que "le 28" ne savait pas dire
        jour_mois = "fin"
    elif jm:
        jour_mois = min(31, max(1, int(jm)))
    else:
        jour_mois = None
    return {"freq": freq, "jours": jours if freq == "semaine" else [],
            "jour_mois": jour_mois if freq == "mois" else None}


def _occ(a: dict, d: str) -> dict | None:
    return next((o for o in a.get("occurrences", []) if o.get("date") == d), None)


def _occ_set(store: dict, a: dict, d: str, statut: str | None) -> None:
    """Pose (ou retire) le statut d'une occurrence. statut=None -> l'occurrence disparait."""
    occ = a.setdefault("occurrences", [])
    cur = _occ(a, d)
    if statut is None:
        if cur:
            occ.remove(cur)
        return
    if cur:
        cur["statut"] = statut
        cur["fait_le"] = _hm()
    else:
        occ.append({"date": d, "statut": statut, "fait_le": _hm()})
    occ.sort(key=lambda o: o.get("date") or "")
    if len(occ) > 500:                            # borne l'historique
        del occ[:len(occ) - 500]


def _migrate_actions(store: dict) -> None:
    """Les routines (`rappels`) deviennent des actions ; leurs `ticks` deviennent des occurrences.

    Un ancien rappel « ponctuel » n'etait pas une routine mais une tache a faire une
    fois : il devient une action SANS recurrence, avec son echeance.
    """
    if store.get("actions") is not None:
        return
    store["actions"] = []
    for r in store.get("rappels", []) or []:
        freq = r.get("freq") or "jour"
        ponctuel = freq == "ponctuel"
        ticks = sorted(set(r.get("ticks") or []))
        a = {
            # on GARDE l'id d'origine : les plages de chrono le referencent (rappel_id -> action_id)
            "id": r.get("id") or _uid("ac_"), "label": r.get("label") or "", "desc": r.get("note") or "",
            "theme_id": None, "chantier_id": r.get("chantier_id") or None,
            "tache_id": r.get("tache_id") or None, "contact_id": None,
            "prio": "m", "echeance": (r.get("date") or None) if ponctuel else None,
            "heure": r.get("heure") or None, "estimation_min": 0,
            "recurrence": None if ponctuel else _norm_recurrence(
                {"freq": freq, "jours": r.get("jours"), "jour_mois": r.get("jour_mois")}),
            "occurrences": [] if ponctuel else [
                {"date": d, "statut": "fait", "fait_le": None} for d in ticks],
            "done": bool(ponctuel and ticks), "done_date": (ticks[-1] if (ponctuel and ticks) else None),
            "actif": bool(r.get("actif", True)), "cree_le": ticks[0] if ticks else today(),
            "ordre": len(store["actions"]),
        }
        store["actions"].append(a)
    store.pop("rappels", None)                    # plus de silo separe


# --------------------------------------------------------------------------- #
# Notes — journal horodate (remplace `histo`)
# --------------------------------------------------------------------------- #
def _notes(store: dict) -> list:
    return store.setdefault("notes", [])


def _note(store: dict, nid: str) -> dict:
    n = next((x for x in _notes(store) if x.get("id") == nid), None)
    if n is None:
        raise ValueError(f"Note introuvable: {nid}")
    return n


# --------------------------------------------------------------------------- #
# Pieces jointes — fiche dans le store, BINAIRE SUR DISQUE.
#
# Le contenu du fichier n'entre PAS dans store.json : un scan de 3 Mio y
# ferait 4 Mio de base64, reecrits en entier a CHAQUE clic de l'appli. Le
# store ne garde donc qu'une fiche (nom d'origine, taille, type, note de
# rattachement) et le binaire vit dans data/fichiers/<id><ext>.
#
# Le nom d'origine ne sert JAMAIS a fabriquer un chemin : le fichier est
# nomme par son id, et le nom d'origine n'est que reaffiche et renvoye au
# telechargement. Un nom piege (« ..\..\truc », « C:\... ») est donc sans effet.
#
# `note_id = None` = piece deposee mais pas encore rattachee : c'est le
# brouillon de piece jointe, affiche dans le bloc de saisie tant que la note
# n'est pas enregistree. Le serveur fait foi — rien a garder cote navigateur.
# --------------------------------------------------------------------------- #
FICHIER_MAX = 10 * 1024 * 1024                  # 10 Mio par piece : au-dela ce n'est plus une note
FICHIER_EXT_MIME = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".bmp": "image/bmp", ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
    ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".msg": "application/vnd.ms-outlook", ".eml": "message/rfc822",
    ".zip": "application/zip", ".7z": "application/x-7z-compressed",
    ".dwg": "image/vnd.dwg", ".dxf": "image/vnd.dxf",
}
# Ouverts dans l'onglet (apercu direct). Tout le reste part en telechargement.
# Le .svg en est volontairement exclu : c'est du XML qui peut porter du script.
FICHIER_INLINE = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".txt", ".md", ".log"}


def _fichiers(store: dict) -> list:
    return store.setdefault("fichiers", [])


def _fichier(store: dict, fid: str) -> dict:
    f = next((x for x in _fichiers(store) if x.get("id") == fid), None)
    if f is None:
        raise ValueError(f"Document introuvable: {fid}")
    return f


def _ext_sure(nom: str) -> str:
    """Extension d'origine ramenee a [a-z0-9], 8 caracteres. Jamais un chemin."""
    ext = "." + re.sub(r"[^a-z0-9]", "", os.path.splitext(nom or "")[1].lower())[:8]
    return ext if len(ext) > 1 else ""


def _nom_sur(nom: str) -> str:
    """Nom AFFICHE : on retire toute composante de chemin et les caracteres de controle."""
    nom = re.sub(r"[\x00-\x1f]", "", (nom or "")).replace("\\", "/").split("/")[-1].strip()
    return nom[:180] or "document"


def fichier_path(f: dict) -> str:
    """Emplacement du binaire. Construit a partir de l'id, jamais du nom."""
    return os.path.join(FICHIERS_DIR, f["id"] + (f.get("ext") or ""))


def _fichier_unlink(f: dict) -> None:
    """Efface le binaire. Un echec (fichier ouvert ailleurs, droits) ne doit pas
    empecher de retirer la fiche : le registre fait foi."""
    try:
        os.remove(fichier_path(f))
    except OSError:
        pass


def _migrate_notes(store: dict) -> None:
    """Les entrees `histo` des chantiers deviennent des notes rattachees a leur chantier."""
    if store.get("notes") is not None:
        return
    store["notes"] = []
    for c in store.get("chantiers", []):
        for e in (c.get("histo") or []):
            store["notes"].append({
                "id": _uid("nt_"), "date": e.get("d") or today(), "heure": "",
                "type": "note", "titre": "", "corps": e.get("t") or "",
                "theme_id": c.get("theme_id"), "chantier_id": c.get("id"),
                "contact_ids": [], "epingle": False,
                "cree_le": e.get("d") or today(), "maj_le": None,
            })
        c.pop("histo", None)
    store["notes"].sort(key=lambda n: (n.get("date") or "", n.get("heure") or ""), reverse=True)


def _migrate_recette(store: dict) -> None:
    """Tout l'historique de recette devient une simple liste de POINTS A VERIFIER.

    Deux sources, idempotentes l'une comme l'autre :
    - les `retours` d'iteration (modele d'origine) : un retour non solde devient
      un point en probleme, un retour solde un point verifie ;
    - les `cas` / `anomalies` d'un cahier de recette detaille (modele intermediaire).
    Une fois converties, ces listes sont videes : le passage suivant ne fait rien.
    """
    for c in store.get("chantiers", []):
        rec = c.get("recette")
        vieux = [r for it in (c.get("iterations") or []) for r in (it.get("retours") or [])]
        cas = (rec or {}).get("cas") or []
        anos = (rec or {}).get("anomalies") or []
        if not (vieux or cas or anos):
            if rec is not None:              # cahier deja converti : on jette les coquilles vides
                for k in ("cas", "anomalies", "pv", "reference", "responsable",
                          "environnement", "perimetre", "date_creation", "date_maj"):
                    rec.pop(k, None)
            continue
        rec = rec or _new_recette()
        c["recette"] = rec
        pts = rec.setdefault("points", [])
        for r in vieux:                      # retour d'iteration -> point
            solde = r.get("statut") in ("fait", "rejete")
            pts.append({"id": r.get("id") or _uid("pt_"), "titre": r.get("quoi", ""),
                        "statut": "ok" if solde else "probleme", "constat": "",
                        "qui": "" if solde else r.get("de", ""),
                        # un point verifie n'a plus d'echeance : elle n'aurait plus de sens
                        "echeance": None if solde else r.get("echeance"),
                        "cree_le": r.get("date") or today(), "debut": None,
                        "verifie_le": r.get("date") if solde else None})
        for k in cas:                        # cas de test -> point a verifier
            pts.append({"id": k.get("id") or _uid("pt_"), "titre": k.get("titre", ""),
                        "statut": "a_verifier", "constat": "", "qui": "",
                        "echeance": None, "cree_le": today(), "debut": None,
                        "verifie_le": None})
        for a in anos:                       # anomalie -> point (en probleme si non soldee)
            ouverte = a.get("statut") in ("ouverte", "en_cours", "corrigee", "a_retester")
            pts.append({"id": a.get("id") or _uid("pt_"), "titre": a.get("titre", ""),
                        "statut": "probleme" if ouverte else "ok",
                        "constat": a.get("description", "") if ouverte else "",
                        "qui": a.get("assigne_a", "") if ouverte else "",
                        "echeance": a.get("echeance") if ouverte else None,
                        "cree_le": a.get("ouvert_le") or today(), "debut": None,
                        "verifie_le": a.get("verifie_le")})
        for k in ("cas", "anomalies", "pv", "reference", "responsable",
                  "environnement", "perimetre", "date_creation", "date_maj"):
            rec.pop(k, None)
        for it in c.get("iterations", []):
            it["retours"] = []


def _chantier_notes(store: dict, cid: str) -> list:
    """Historique d'un chantier = ses notes, les plus recentes d'abord."""
    ns = [n for n in _notes(store) if n.get("chantier_id") == cid]
    ns.sort(key=lambda n: (n.get("date") or "", n.get("heure") or ""), reverse=True)
    return ns


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
    s.setdefault("wip_max", 5)           # max chantiers "En cours" simultanes
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
    # --- migrations : themes (depuis les tags), actions (depuis les rappels), notes (depuis histo)
    _migrate_themes(store)
    _migrate_actions(store)
    _migrate_notes(store)
    _migrate_recette(store)
    for i, th in enumerate(store.setdefault("themes", [])):
        th.setdefault("id", _uid("th_"))
        th.setdefault("nom", "Theme")
        th.setdefault("icone", "•")
        th.setdefault("couleur", THEME_COULEURS[i % len(THEME_COULEURS)])
        th.setdefault("ordre", i)
        th.setdefault("archive", False)
    store["themes"].sort(key=lambda t: t.get("ordre", 0))
    for a in store.setdefault("actions", []):   # taches libres ET routines : une seule liste
        a.setdefault("id", _uid("ac_"))
        a.setdefault("label", "")
        a.setdefault("desc", "")
        a["theme_id"] = _theme_id_valide(store, a.get("theme_id"))
        a.setdefault("chantier_id", None)       # rattachement optionnel : le temps chrono y est compte
        a.setdefault("tache_id", None)
        a.setdefault("contact_id", None)
        a.setdefault("prio", "m")
        a.setdefault("echeance", None)          # ponctuelle : date d'echeance
        a.setdefault("heure", None)             # "HH:MM" pour la notif bureau
        a.setdefault("estimation_min", 0)       # minutes estimees (0 = non estimee) — sert la regle des 2 minutes
        a.setdefault("recurrence", None)        # None = tache libre ; sinon = routine
        a.setdefault("occurrences", [])         # [{date, statut: fait|saute|rate, fait_le}]
        a.setdefault("done", False)             # ponctuelle uniquement
        a.setdefault("done_date", None)
        a.setdefault("actif", True)             # routine en sommeil sans la supprimer
        a.setdefault("cree_le", today())
        a.setdefault("ordre", 0)
        if a["prio"] not in PRIOS:
            a["prio"] = "m"
        try:
            a["recurrence"] = _norm_recurrence(a.get("recurrence"))
        except ValueError:
            a["recurrence"] = None
        if a["recurrence"]:                     # une routine n'est jamais "done" : elle a des occurrences
            a["done"], a["done_date"] = False, None
        a["occurrences"] = [o for o in a["occurrences"]
                            if o.get("date") and o.get("statut") in OCC_STATUTS]
    for n in store.setdefault("notes", []):     # journal horodate
        n.setdefault("id", _uid("nt_"))
        n.setdefault("date", today())
        n.setdefault("heure", "")
        n.setdefault("type", "note")            # note | reunion | decision | idee
        n.setdefault("titre", "")
        n.setdefault("corps", "")
        n["theme_id"] = _theme_id_valide(store, n.get("theme_id"))
        n.setdefault("chantier_id", None)
        n.setdefault("contact_ids", [])
        n.setdefault("epingle", False)
        n.setdefault("cree_le", n["date"])
        n.setdefault("maj_le", None)
        if n["type"] not in NOTE_TYPES:
            n["type"] = "note"
    ids_notes = {n["id"] for n in store.get("notes", [])}
    for f in store.setdefault("fichiers", []):  # pieces jointes : fiche seule, binaire sur disque
        f.setdefault("id", _uid("fi_"))
        f.setdefault("nom", "document")
        f.setdefault("ext", _ext_sure(f["nom"]))
        f.setdefault("taille", 0)
        f.setdefault("mime", FICHIER_EXT_MIME.get(f.get("ext") or "", "application/octet-stream"))
        f.setdefault("cree_le", today())
        f.setdefault("heure", "")
        if f.setdefault("note_id", None) and f["note_id"] not in ids_notes:
            f["note_id"] = None                 # note disparue : la piece redevient a rattacher
    for s in store.setdefault("timelog", []):   # sessions de suivi du temps (chrono)
        s.setdefault("id", _uid("tl_"))
        s.setdefault("date", today())
        s.setdefault("debut", "00:00")
        s.setdefault("fin", None)
        s.setdefault("kind", "libre")           # tache | action | recette | libre
        s.setdefault("label", "")
        s.setdefault("chantier_id", None)
        s.setdefault("tache_id", None)
        s.setdefault("iteration_id", None)      # legacy : ancienne itération de recette
        s.setdefault("point_id", None)          # point de recette chronométré
        s.setdefault("action_id", None)         # plage chronometree sur une action (ex-rappel_id)
        s["theme_id"] = _theme_id_valide(store, s.get("theme_id"))   # ventile le temps "libre" par theme
        rid = s.pop("rappel_id", None)          # l'action a garde l'id du rappel : le lien tient
        if rid and not s["action_id"]:
            s["action_id"] = rid
        if s["action_id"] and not any(x.get("id") == s["action_id"] for x in store["actions"]):
            s["action_id"] = None               # action supprimee : la plage reste, sans rattachement
        if s["kind"] == "rappel":
            s["kind"] = "action" if s["action_id"] else "libre"
        # Auto-reparation : un chrono oublie un jour passe est ferme a la fin de
        # journee — mais jamais AVANT son debut (une seance de 18:24 ne peut pas
        # finir a 17:51). Une plage deja enregistree n'est en revanche jamais
        # tronquee : le travail reel prime sur l'heure de fin de journee reglee,
        # sinon travailler apres 17:51 effacerait la seance a la relecture.
        if s["fin"] is None and s["date"] < today():
            de = _day_end(store, s["date"])
            s["fin"] = max(de, s["debut"] or de)
        if s["fin"] is not None and s["debut"] and s["fin"] < s["debut"]:
            s["fin"] = s["debut"]                   # garde-fou : jamais de duree negative
    for a in store.setdefault("absences", []):  # jours non travailles : conges, RTT, feries
        a.setdefault("id", _uid("ab_"))
        a.setdefault("debut", today())
        a.setdefault("fin", a["debut"])         # absence d'un seul jour : fin = debut
        a.setdefault("type", "conge")           # conge | rtt | ferie | recup | formation | maladie | autre
        a.setdefault("label", ABSENCE_LABELS.get(a["type"], "Absence"))
        a.setdefault("contact_id", None)        # None = moi (seul cas qui pese sur MON planning)
        a.setdefault("note", "")
        if a["fin"] < a["debut"]:               # robustesse : periode inversee saisie a la main
            a["debut"], a["fin"] = a["fin"], a["debut"]
    store["absences"].sort(key=lambda a: a.get("debut", ""))
    for r in store.setdefault("rapports", []):   # rapports hebdomadaires (bilan + à venir + REX)
        r.setdefault("id", _uid("rh_"))
        r.setdefault("semaine", _iso_week(date.today()))
        if not r.get("debut") or not r.get("fin"):
            try:
                r["debut"], r["fin"] = _week_bounds(r["semaine"])
            except ValueError:
                r["debut"] = r["fin"] = today()
        if r.get("statut") not in RAPPORT_STATUTS:
            r["statut"] = "brouillon"
        r.setdefault("cree_le", "")
        r.setdefault("cree_par", "")             # visa de création
        r.setdefault("vise_par", "")             # visa de finalisation
        r.setdefault("maj_le", None)
        r.setdefault("finalise_le", None)
        r.setdefault("termines", [])             # chantiers finis pendant la semaine
        r.setdefault("gantt", [])                # photo Gantt du portefeuille
        r.setdefault("hors_chantier", [])        # réunions, RDV, routines de la semaine
        for x in r.setdefault("retards", []):    # retards : justification obligatoire
            x.setdefault("chantier_id", "")
            x.setdefault("chantier", "")
            x.setdefault("echeance", None)
            x.setdefault("jours", 0)
            x.setdefault("justification", "")
        r.setdefault("synthese", "")             # rédaction libre : jamais recalculée
        r.setdefault("priorites", "")
        rg = r.setdefault("rex_general", {})
        rg.setdefault("positif", "")
        rg.setdefault("negatif", "")
        rg.setdefault("actions", "")
        r.setdefault("exclus", [])               # chantiers retirés à la main (le recalcul les ignore)
        # lignes calculées retirées à la main ; on jette les clés d'un client qui
        # n'avait pas d'identifiant sous la main : elles ne masquaient rien.
        r["exclus_hc"] = [c for c in (r.get("exclus_hc") or [])
                          if isinstance(c, str) and not c.endswith((":undefined", ":None", ":null", ":"))]
        r.setdefault("stats", {})
        r.setdefault("avenir", {})
        for p in r.setdefault("points", []):
            p.setdefault("chantier_id", "")
            p.setdefault("chantier", "")         # titre dénormalisé : l'archive survit au chantier
            p.setdefault("manuel", False)
            p.setdefault("avancement", "")
            p.setdefault("rex", "")
            p.setdefault("auto", {})
    store["rapports"].sort(key=lambda r: r.get("semaine", ""))
    for c in store.get("chantiers", []):
        if c.get("statut") == "block":   # "Bloqué" est desormais calcule, plus un statut manuel
            c["statut"] = "doing"
        c.setdefault("id", _uid("ch_"))      # robustesse : un store partiel / edite a la main ne doit pas planter
        c.setdefault("titre", "")
        c.setdefault("statut", "todo")
        c.setdefault("prio", "m")
        c.setdefault("echeance", None)
        c.setdefault("date_debut", None)
        c.setdefault("objectif", "")
        c.setdefault("budget", None)         # BAC (budget a l'achevement, €) pour l'EVM ; None = non defini
        c.setdefault("blocage", "")
        c["theme_id"] = _theme_id_valide(store, c.get("theme_id"))   # mono-theme (remplace les tags libres)
        c.pop("tags", None)
        c.pop("histo", None)                 # l'historique du chantier = ses notes (store["notes"])
        c.setdefault("parties", [])
        c.setdefault("livrables", [])
        c.setdefault("baseline", None)
        c.setdefault("baseline_edits", 0)
        c.setdefault("hold", False)          # mise en pause volontaire (sort des compteurs)
        c.setdefault("hold_until", None)     # date de reprise prévue (optionnelle, déclenche un rappel)
        c.setdefault("hold_started", None)   # date de mise en pause : sert à décaler le planning à la reprise
        if c.get("hold") and not c.get("hold_started"):   # pause héritée (avant ce suivi) : on cale le repère à aujourd'hui
            c["hold_started"] = today()
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
        rec = c.setdefault("recette", None)             # recette (0..1 par chantier)
        if rec is not None:
            for p in rec.setdefault("points", []):
                p.setdefault("id", _uid("pt_"))
                p.setdefault("titre", "")
                p.setdefault("statut", "a_verifier")     # a_verifier | ok | probleme
                p.setdefault("constat", "")              # rempli seulement quand ca coince
                p.setdefault("qui", "")                  # qui corrige
                p.setdefault("echeance", None)
                p.setdefault("cree_le", today())
                p.setdefault("debut", None)               # verification demarree (comme une tache)
                p.setdefault("verifie_le", None)
                if p["statut"] not in POINT_STATUTS:
                    p["statut"] = "a_verifier"
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
            l.setdefault("id", _uid("liv_"))     # robustesse : champs lus en acces direct (export, UI)
            l.setdefault("quoi", "")
            l.setdefault("personne", "")
            l.setdefault("role", "")
            l.setdefault("statut", "attente")
            l.setdefault("date", None)
            l.setdefault("relances", 0)
            l.setdefault("derniere", None)
            l.setdefault("impact", "")
            l.setdefault("tache_id", None)
            l.setdefault("contact_id", None)
        for p in c["parties"]:
            p.setdefault("id", _uid("p_"))
            p.setdefault("contact_id", None)
        for it in c.setdefault("iterations", []):        # legacy : anciennes iterations de recette,
            it.setdefault("id", _uid("it_"))             # conservees pour ne pas casser le temps
            it.setdefault("num", 1)                      # chronometre qui les reference
            it.setdefault("ouverte", False)
            it.setdefault("date", None)
            it.setdefault("note", "")
            it.setdefault("retours", [])
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


def _cdc(store: dict, cid: str):
    ch = _chantier(store, cid)
    cdc = ch.get("cdc")
    if not cdc:
        raise ValueError("Ce chantier n'a pas de cahier des charges.")
    return ch, cdc


def _rec(store: dict, cid: str):
    ch = _chantier(store, cid)
    rec = ch.get("recette")
    if not rec:
        raise ValueError("Ce chantier n'a pas de liste de recette.")
    return ch, rec



# --------------------------------------------------------------------------- #
# Le statut d'un chantier SUIT le travail : on ne le pose plus a la main.
# --------------------------------------------------------------------------- #
_AUTO_LBL = {"recette": "passe En recette", "done": "passe Termine",
             "doing": "repasse En cours"}


def _auto_statut(store: dict, ch: dict) -> str:
    """Recale le statut d'un chantier sur l'etat reel de son travail.

    Regle, dans cet ordre :
      1. recette ouverte (liste presente, pas entierement verifiee) -> « recette » ;
      2. sinon, toutes les taches faites -> « done » ;
      3. sinon, un chantier qui etait en recette ou termine repart « doing »
         (tache rouverte, point rouvert, tache ajoutee).
    Un chantier en pause n'est pas touche : la pause est une decision, pas un
    etat calcule. Un chantier sans tache ne retombe jamais de done/recette : il
    n'y a pas de travail a mesurer. Le plafond de WIP ne s'applique pas ici —
    c'est une consequence du geste de l'utilisateur, pas un choix a arbitrer.
    Retourne le suffixe a coller au message de l'op, ou "".
    """
    if ch.get("hold"):
        return ""
    prev = ch.get("statut", "todo")
    taches = ch.get("taches", [])
    # « ouverte » au sens de _recette_stats : une liste existe et n'est pas
    # entierement verifiee — liste vide comprise (c'est deja le sens de `fini`).
    if ch.get("recette") is not None and not _recette_stats(ch)["fini"]:
        new = "recette"
    elif taches and all(t.get("done") for t in taches):
        new = "done"
    elif taches and prev in ("recette", "done"):
        new = "doing"
    else:
        return ""
    if new == prev:
        return ""
    ch["statut"] = new
    if prev == "recette":       # on quitte la recette : solde un chrono de recette ouvert
        for s in _clock_active(store):
            if s.get("chantier_id") == ch["id"] and s.get("kind") == "recette":
                _close_session(store, s)
    return f" — « {ch['titre']} » {_AUTO_LBL[new]}"


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
            "blocage": "", "theme_id": _theme_id_valide(store, op.get("theme_id")),
            "parties": [], "taches": taches,
            "livrables": [], "iterations": [], "ordre": len(store["chantiers"]),
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
                "objectif": (cc.get("objectif") or "").strip(), "blocage": "", "theme_id": None, "parties": [],
                "taches": [], "livrables": [], "iterations": [], "risques": [], "cdc": None,
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
        prev = ch["statut"]
        if op["statut"] == "doing" and prev != "doing" and not ch.get("hold"):   # plafond WIP « En cours »
            wip_max = int(store.get("settings", {}).get("wip_max", 3))
            actifs = [c for c in store["chantiers"] if c.get("statut") == "doing" and not c.get("hold")]
            if wip_max and len(actifs) >= wip_max:   # wip_max = 0 -> aucune limite « En cours »
                raise ValueError(
                    f"Limite de {wip_max} chantiers « En cours » atteinte "
                    f"({', '.join('« ' + c['titre'] + ' »' for c in actifs)}).\n"
                    f"Terminez ou mettez en pause un chantier avant d'en passer un autre En cours.")
        ch["statut"] = op["statut"]
        if op["statut"] == "recette" and not ch.get("recette"):   # ouvre la liste a verifier
            ch["recette"] = _new_recette()
        elif prev == "recette" and op["statut"] != "recette":     # on quitte la recette : solde un chrono recette ouvert
            for s in _clock_active(store):
                if s.get("chantier_id") == ch["id"] and s.get("kind") == "recette":
                    _close_session(store, s)
        return f"« {ch['titre']} » deplace vers {op['statut']}"

    if name == "set_hold":   # met en pause / reprend un chantier entier
        ch = _chantier(store, op["chantier_id"])
        was_hold = bool(ch.get("hold"))
        ch["hold"] = bool(op.get("hold"))
        ch["hold_until"] = (op.get("until") or None) if ch["hold"] else None
        if ch["hold"]:
            ch.setdefault("hold_started", None)
            if not was_hold:                          # on mémorise le jour de mise en pause
                ch["hold_started"] = today()
            _clock_close_chantier(store, ch["id"])   # parquer le chantier arrête son chrono
            return f"« {ch['titre']} » mis en pause" + (f" jusqu'au {ch['hold_until']}" if ch["hold_until"] else "")
        # ---- REPRISE : le planning était figé pendant la pause -> on le décale en bloc
        # du nombre de jours passés en pause, pour ne subir AUCUN retard artificiel.
        days = 0
        started = ch.get("hold_started")
        if was_hold and started:
            try:
                days = (date.fromisoformat(today()) - date.fromisoformat(started)).days
            except ValueError:
                days = 0
        ch["hold_started"] = None
        if days > 0:
            _replan_unfinished(ch, days)
            return f"« {ch['titre']} » repris — planning décalé de {days} j (aucun retard imputé)"
        return f"« {ch['titre']} » repris"

    if name == "replan_now":   # replanifie le travail RESTANT pour repartir d'aujourd'hui
        ch = _chantier(store, op["chantier_id"])
        days = int(op.get("days") or 0)
        if days <= 0:
            return f"« {ch['titre']} » déjà à jour — aucune replanification"
        _replan_unfinished(ch, days)
        return f"« {ch['titre']} » replanifié — travail restant décalé de {days} j (aucun retard imputé)"

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
        return f"Tache ajoutee a « {ch['titre']} » : {label}" + _auto_statut(store, ch)

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
        return (f"Tache « {t['label']} » -> {'faite' if t['done'] else 'a faire'}"
                + _auto_statut(store, ch))

    if name == "start_tache":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        if t["done"]:
            raise ValueError("Cette tache est deja terminee.")
        if "date" in op and not op.get("date"):       # date null explicite -> annule le demarrage
            t["start_date"] = None
            _clock_close_tache(store, t["id"])
            return f"Tache « {t['label']} » remise a faire"
        # Démarrer une tâche fait passer le chantier « En cours » — sous plafond de WIP.
        promu = False
        if ch.get("statut") == "todo":
            wip_max = int(store.get("settings", {}).get("wip_max", 3))
            actifs = [c for c in store["chantiers"] if c.get("statut") == "doing" and not c.get("hold")]
            if wip_max and len(actifs) >= wip_max:   # wip_max = 0 -> aucune limite « En cours »
                raise ValueError(
                    f"Limite de {wip_max} chantiers « En cours » atteinte "
                    f"({', '.join('« ' + c['titre'] + ' »' for c in actifs)}).\n"
                    f"Terminez ou mettez en pause un chantier avant de démarrer une tâche ici.")
            ch["statut"] = "doing"
            promu = True
        t["start_date"] = op.get("date") or today()
        _clock_start(store, "tache", t["label"], chantier_id=ch["id"], tache_id=t["id"])   # ouvre le chrono
        msg = f"Tache « {t['label']} » demarree le {t['start_date']}"
        return msg + (f" — « {ch['titre']} » passe En cours" if promu else "")

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
        if "done_date" in op and t.get("done"):  # correction de la fin REELLE d'une tache deja terminee
            t["done_date"] = op["done_date"] or None
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
        return f"Tache mise a jour dans « {ch['titre']} »" + _auto_statut(store, ch)

    if name == "remove_tache":
        ch = _chantier(store, op["chantier_id"])
        t = _sub(ch["taches"], op["tache_id"], "Tache")
        ch["taches"] = [x for x in ch["taches"] if x["id"] != op["tache_id"]]
        for o in ch["taches"]:  # nettoie les references
            o["preds"] = [p for p in o.get("preds", []) if p != op["tache_id"]]
        for l in ch["livrables"]:  # delie les livrables qui pointaient cette tache
            if l.get("tache_id") == op["tache_id"]:
                l["tache_id"] = None
        return f"Tache supprimee : {t['label']}" + _auto_statut(store, ch)

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

    if name == "add_note":   # note d'historique d'un chantier = note rattachee a ce chantier
        ch = _chantier(store, op["chantier_id"])
        texte = (op.get("texte") or "").strip()
        if not texte:
            raise ValueError("Texte de note requis.")
        _notes(store).insert(0, {
            "id": _uid("nt_"), "date": op.get("date") or today(), "heure": _hm(),
            "type": "note", "titre": "", "corps": texte,
            "theme_id": ch.get("theme_id"), "chantier_id": ch["id"],
            "contact_ids": [], "epingle": False, "cree_le": today(), "maj_le": None,
        })
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

    # ---- Themes (liste fermee, 10 max) ------------------------------------ #
    if name == "set_theme":   # affecte le theme d'un chantier (mono-theme, remplace les tags)
        ch = _chantier(store, op["chantier_id"])
        tid = op.get("theme_id") or None
        if tid:
            _theme(store, tid)                    # valide l'existence
        ch["theme_id"] = tid
        return (f"Theme de « {ch['titre']} » : {_theme(store, tid)['nom']}" if tid
                else f"Theme retire de « {ch['titre']} »")

    if name == "theme_add":
        nom = (op.get("nom") or "").strip()
        if not nom:
            raise ValueError("Nom du theme requis.")
        actifs = _theme_actifs(store)
        if len(actifs) >= THEMES_MAX:
            raise ValueError(
                f"Limite de {THEMES_MAX} themes atteinte. Archive un theme existant avant "
                f"d'en creer un nouveau — c'est cette contrainte qui garde la liste utile.")
        if any(t["nom"].strip().lower() == nom.lower() for t in _themes(store)):
            raise ValueError(f"Le theme « {nom} » existe deja.")
        th = {"id": _uid("th_"), "nom": nom, "icone": (op.get("icone") or "•")[:4],
              "couleur": op.get("couleur") or _theme_libre(store),
              "ordre": len(_themes(store)), "archive": False}
        _themes(store).append(th)
        return f"Theme cree : {nom}"

    if name == "theme_update":
        th = _theme(store, op["id"])
        if "nom" in op and op["nom"] is not None:
            nom = str(op["nom"]).strip()
            if nom and any(t["nom"].strip().lower() == nom.lower() and t["id"] != th["id"]
                           for t in _themes(store)):
                raise ValueError(f"Le theme « {nom} » existe deja.")
            th["nom"] = nom or th["nom"]
        if "icone" in op and op["icone"] is not None:
            th["icone"] = str(op["icone"])[:4] or "•"
        if "couleur" in op and op["couleur"]:
            th["couleur"] = str(op["couleur"])
        if "archive" in op:
            if not op["archive"] and len(_theme_actifs(store)) >= THEMES_MAX and th.get("archive"):
                raise ValueError(f"Limite de {THEMES_MAX} themes actifs atteinte.")
            th["archive"] = bool(op["archive"])
        return f"Theme mis a jour : {th['nom']}"

    if name == "theme_move":   # reordonne (l'ordre pilote l'affichage partout)
        th = _themes(store)
        i = next((k for k, x in enumerate(th) if x["id"] == op["id"]), None)
        if i is None:
            raise ValueError(f"Theme introuvable: {op['id']}")
        j = max(0, min(len(th) - 1, i + (1 if op.get("sens") == "bas" else -1)))
        th[i], th[j] = th[j], th[i]
        for k, x in enumerate(th):
            x["ordre"] = k
        return "Themes reordonnes"

    if name == "theme_remove":
        th = _theme(store, op["id"])
        tid = th["id"]
        n_ch = sum(1 for c in store["chantiers"] if c.get("theme_id") == tid)
        n_ac = sum(1 for a in _actions(store) if a.get("theme_id") == tid)
        n_nt = sum(1 for n in _notes(store) if n.get("theme_id") == tid)
        # Rien n'est supprime en cascade : les elements repassent simplement "sans theme".
        for c in store["chantiers"]:
            if c.get("theme_id") == tid:
                c["theme_id"] = None
        for a in _actions(store):
            if a.get("theme_id") == tid:
                a["theme_id"] = None
        for n in _notes(store):
            if n.get("theme_id") == tid:
                n["theme_id"] = None
        for s in store.setdefault("timelog", []):
            if s.get("theme_id") == tid:
                s["theme_id"] = None
        store["themes"] = [x for x in _themes(store) if x["id"] != tid]
        for k, x in enumerate(store["themes"]):
            x["ordre"] = k
        detail = f" ({n_ch} chantiers, {n_ac} actions, {n_nt} notes sans theme)" if (n_ch or n_ac or n_nt) else ""
        return f"Theme supprime : {th['nom']}{detail}"

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

    # ---- Recette : une liste de points a verifier -------------------------- #
    if name == "recette_init":
        ch = _chantier(store, op["chantier_id"])
        if not ch.get("recette"):
            ch["recette"] = _new_recette()
        return f"Recette ouverte pour « {ch['titre']} »" + _auto_statut(store, ch)

    if name == "recette_delete":
        ch = _chantier(store, op["chantier_id"])
        ch["recette"] = None
        return f"Recette supprimée de « {ch['titre']} »" + _auto_statut(store, ch)

    if name == "point_add":
        ch, rec = _rec(store, op["chantier_id"])
        titre = (op.get("titre") or "").strip()
        if not titre:
            raise ValueError("Intitulé du point à vérifier requis.")
        rec["points"].append(_new_point(titre))
        return f"Point ajouté : {titre}" + _auto_statut(store, ch)

    if name == "point_add_lot":
        # Ajout par lot depuis la liste de points types : on choisit dans une liste
        # plutot que de rediger — une checklist qu'il faut ecrire ne s'ecrit jamais.
        ch = _chantier(store, op["chantier_id"])
        if not ch.get("recette"):
            ch["recette"] = _new_recette()
        titres = [str(t).strip() for t in (op.get("titres") or []) if str(t).strip()]
        if not titres:
            raise ValueError("Aucun point à ajouter.")
        deja = {p["titre"].lower() for p in ch["recette"]["points"]}
        n = 0
        for t in titres:
            if t.lower() in deja:          # pas de doublon : on re-coche sans y penser
                continue
            ch["recette"]["points"].append(_new_point(t))
            deja.add(t.lower())
            n += 1
        if not n:
            return "Ces points sont déjà dans la liste."
        return f"{n} point(s) ajouté(s) à « {ch['titre']} »" + _auto_statut(store, ch)

    if name == "point_start":
        # Meme geste qu'une tache : demarrer pose le debut reel ET lance le chrono
        # sur CE point. Le temps de recette se lit donc ligne par ligne.
        ch, rec = _rec(store, op["chantier_id"])
        pt = _sub(rec["points"], op["point_id"], "Point")
        pt["debut"] = pt.get("debut") or today()
        if pt["statut"] == "ok":
            pt["statut"], pt["verifie_le"] = "a_verifier", None
        _clock_start(store, "recette", f"Recette — {pt['titre']}",
                     chantier_id=ch["id"], point_id=pt["id"])
        return f"Vérification démarrée : {pt['titre'][:40]}" + _auto_statut(store, ch)

    if name == "point_set":
        # Statuer un point. Le reste suit tout seul : date de verification, arret
        # du chrono de CE point, et fin de recette quand tout est verifie.
        ch, rec = _rec(store, op["chantier_id"])
        pt = _sub(rec["points"], op["point_id"], "Point")
        statut = op.get("statut") or "a_verifier"
        if statut not in POINT_STATUTS:
            raise ValueError(f"Statut de point invalide: {statut}")
        pt["statut"] = statut
        pt["verifie_le"] = today() if statut == "ok" else None
        if statut == "ok":                 # resolu : le detail du probleme n'a plus d'objet
            pt["constat"], pt["qui"], pt["echeance"] = "", "", None
            pt["debut"] = pt.get("debut") or today()
        elif statut == "a_verifier":       # remise a zero complete : on repart de rien
            pt["debut"] = None
            pt["constat"], pt["qui"], pt["echeance"] = "", "", None
        for f in ("constat", "qui"):
            if f in op and op[f] is not None:
                pt[f] = str(op[f]).strip()
        if "echeance" in op:
            pt["echeance"] = op["echeance"] or None
        # un point statue n'est plus en cours de verification : on solde son chrono
        if statut in ("ok", "a_verifier"):
            for sx in _clock_active(store):
                if sx.get("point_id") == pt["id"]:
                    _close_session(store, sx)
        st = _recette_stats(ch)
        if st["fini"]:                     # tout est verifie : on arrete de compter la recette
            for sx in _clock_active(store):   # ...et SEULEMENT la recette : un chrono de
                if sx.get("kind") == "recette" and sx.get("chantier_id") == ch["id"]:
                    _close_session(store, sx)  # tache en cours sur ce chantier n'est pas coupe
            return (f"Recette terminée — {st['total']}/{st['total']} points vérifiés"
                    + _auto_statut(store, ch))
        lbl = {"ok": "vérifié", "probleme": "en problème", "a_verifier": "remis à vérifier"}[statut]
        return (f"« {pt['titre'][:40]} » {lbl} ({st['ok']}/{st['total']})"
                + _auto_statut(store, ch))

    if name == "point_update":
        ch, rec = _rec(store, op["chantier_id"])
        pt = _sub(rec["points"], op["point_id"], "Point")
        for f in ("titre", "constat", "qui"):
            if f in op and op[f] is not None:
                pt[f] = str(op[f]).strip()
        if "echeance" in op:
            pt["echeance"] = op["echeance"] or None
        return "Point mis à jour"

    if name == "point_remove":
        ch, rec = _rec(store, op["chantier_id"])
        pt = _sub(rec["points"], op["point_id"], "Point")
        rec["points"] = [x for x in rec["points"] if x["id"] != op["point_id"]]
        for sx in store.get("timelog", []):   # le temps passe reste, sans rattachement
            if sx.get("point_id") == op["point_id"]:
                if sx.get("fin") is None:
                    _close_session(store, sx)
                sx["point_id"] = None
        return f"Point supprimé : {pt['titre'][:40]}" + _auto_statut(store, ch)

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

    if name == "cdc_docx_import":
        # Retour du cahier des charges relu depuis Word. Un import qui change
        # quelque chose EST une revision : on fige l'indice courant et on passe
        # au suivant, sinon l'historique du document mentirait.
        ch, cdc = _cdc(store, op["chantier_id"])
        recues = op.get("sections")
        if not isinstance(recues, list) or not recues:
            raise ValueError("Aucune section lue dans le document Word.")

        avant = {s["id"]: s for s in cdc.get("sections", [])}
        par_titre = {}
        for s in cdc.get("sections", []):
            par_titre.setdefault(_cle_titre(s.get("titre")), s)

        nouvelles, modifiees, ajoutees = [], [], []
        for i, r in enumerate(recues):
            titre = (r.get("titre") or "Section").strip() or "Section"
            corps = r.get("corps") or ""
            ref = avant.get(r.get("id")) or par_titre.get(_cle_titre(titre))
            if ref is None and i < len(cdc.get("sections", [])):
                cand = cdc["sections"][i]           # dernier recours : la position
                ref = cand if _cle_titre(cand.get("titre")) == _cle_titre(titre) else None
            if ref is None:
                nouvelles.append({"id": _uid("sec_"), "titre": titre, "corps": corps})
                ajoutees.append(titre)
            else:
                if (ref.get("titre") or "") != titre or (ref.get("corps") or "") != corps:
                    modifiees.append(titre)
                nouvelles.append({"id": ref["id"], "titre": titre, "corps": corps})

        gardes = {s["id"] for s in nouvelles}
        supprimees = [s.get("titre") or "" for s in cdc.get("sections", [])
                      if s["id"] not in gardes]

        if not (modifiees or ajoutees or supprimees):
            return "Document identique : aucune modification à enregistrer."

        cur = cdc["indice"]
        rec = next((r for r in cdc["revisions"] if r["indice"] == cur), None)
        if rec is not None and rec.get("snapshot") is None:
            rec["snapshot"] = {
                "titre": cdc.get("titre", ""), "reference": cdc.get("reference", ""),
                "statut": cdc.get("statut"), "valide_par": cdc.get("valide_par", ""),
                "date_validation": cdc.get("date_validation"),
                "sections": [dict(s) for s in cdc.get("sections", [])],
            }

        detail = []
        if modifiees:
            detail.append(f"{len(modifiees)} modifiée(s) : " + ", ".join(modifiees[:4])
                          + ("…" if len(modifiees) > 4 else ""))
        if ajoutees:
            detail.append(f"{len(ajoutees)} ajoutée(s) : " + ", ".join(ajoutees[:3]))
        if supprimees:
            detail.append(f"{len(supprimees)} supprimée(s) : " + ", ".join(supprimees[:3]))
        objet = "Import Word — " + " ; ".join(detail)

        nxt = _next_indice(cur)
        cdc["sections"] = nouvelles
        cdc["indice"] = nxt
        cdc["statut"] = "brouillon"         # le contenu a bougé : la validation retombe
        cdc["valide_par"] = ""
        cdc["date_validation"] = None
        cdc["date_maj"] = today()
        cdc["revisions"].append({
            "id": _uid("rev_"), "indice": nxt, "date": today(),
            "auteur": (op.get("auteur") or cdc.get("redacteur") or "").strip(),
            "objet": objet, "snapshot": None})
        return (f"Cahier des charges réimporté — indice {nxt}. "
                + " ; ".join(detail) + ". La validation est réinitialisée.")

    # ---- Actions : taches libres ET routines dans une seule liste --------- #
    if name == "action_add":
        label = (op.get("label") or "").strip()
        if not label:
            raise ValueError("Libelle de l'action requis.")
        rec = _norm_recurrence(op.get("recurrence"))
        prio = op.get("prio") or "m"
        if prio not in PRIOS:
            raise ValueError(f"Priorite invalide: {prio}")
        cid = op.get("chantier_id") or None
        if cid:
            _chantier(store, cid)
        a = {
            "id": _uid("ac_"), "label": label, "desc": (op.get("desc") or "").strip(),
            "theme_id": _theme_id_valide(store, op.get("theme_id")),
            "chantier_id": cid, "tache_id": op.get("tache_id") or None,
            "contact_id": op.get("contact_id") or None,
            "prio": prio, "echeance": (op.get("echeance") or None) if not rec else None,
            "heure": op.get("heure") or None,
            "estimation_min": max(0, int(op.get("estimation_min") or 0)),
            "recurrence": rec, "occurrences": [],
            "done": False, "done_date": None, "actif": True,
            "cree_le": today(), "ordre": len(_actions(store)),
        }
        _actions(store).append(a)
        return ("Routine creee : " if rec else "Action creee : ") + label

    if name == "action_update":
        a = _action(store, op["id"])
        if "label" in op and op["label"] is not None:
            a["label"] = str(op["label"]).strip() or a["label"]
        if "desc" in op and op["desc"] is not None:
            a["desc"] = str(op["desc"]).strip()
        if "theme_id" in op:
            a["theme_id"] = _theme_id_valide(store, op["theme_id"])
        if "prio" in op and op["prio"]:
            if op["prio"] not in PRIOS:
                raise ValueError(f"Priorite invalide: {op['prio']}")
            a["prio"] = op["prio"]
        if "chantier_id" in op:
            a["chantier_id"] = op["chantier_id"] or None
            if a["chantier_id"]:
                _chantier(store, a["chantier_id"])
            else:
                a["tache_id"] = None          # sans chantier rattache, pas de tache
        if "tache_id" in op:
            a["tache_id"] = op["tache_id"] or None
        if "contact_id" in op:
            a["contact_id"] = op["contact_id"] or None
        if "heure" in op:
            a["heure"] = op["heure"] or None
        if "estimation_min" in op:
            a["estimation_min"] = max(0, int(op.get("estimation_min") or 0))
        if "actif" in op:
            a["actif"] = bool(op["actif"])
        if "recurrence" in op:
            a["recurrence"] = _norm_recurrence(op["recurrence"])
            if a["recurrence"]:               # devient une routine : plus d'echeance ni de "done"
                a["echeance"], a["done"], a["done_date"] = None, False, None
        if "echeance" in op and not a["recurrence"]:
            a["echeance"] = op["echeance"] or None
        return f"Action mise a jour : {a['label']}"

    if name == "action_done":
        # Routine -> pose l'occurrence du jour ; action ponctuelle -> bascule "fait".
        # Recliquer annule (l'occurrence disparait, le "fait" repasse a faire).
        a = _action(store, op["id"])
        d = op.get("date") or today()
        if a.get("recurrence"):
            cur = _occ(a, d)
            if cur and cur.get("statut") == "fait":
                _occ_set(store, a, d, None)
                return f"Routine decochee : {a['label']}"
            _occ_set(store, a, d, "fait")
            return f"Routine faite : {a['label']}"
        if a.get("done"):
            a["done"], a["done_date"] = False, None
            return f"Action rouverte : {a['label']}"
        a["done"], a["done_date"] = True, d
        return f"Action faite : {a['label']}"

    if name == "action_skip":
        # Sauter VOLONTAIREMENT une occurrence : ce n'est pas un oubli, et le
        # taux de tenue ne doit pas le compter comme un rate.
        a = _action(store, op["id"])
        if not a.get("recurrence"):
            raise ValueError("Seule une routine peut etre sautee.")
        d = op.get("date") or today()
        cur = _occ(a, d)
        if cur and cur.get("statut") == "saute":
            _occ_set(store, a, d, None)
            return f"Occurrence retablie : {a['label']}"
        _occ_set(store, a, d, "saute")
        return f"Occurrence sautee : {a['label']}"

    if name == "action_miss":
        # Acte le RATE d'une occurrence passee : elle cesse d'encombrer la liste
        # du jour mais reste dans l'historique et pese sur le taux de tenue.
        a = _action(store, op["id"])
        if not a.get("recurrence"):
            raise ValueError("Seule une routine peut etre ratee.")
        d = op.get("date") or today()
        if d >= today():
            raise ValueError("Une occurrence ne peut etre ratee qu'une fois la date passee.")
        _occ_set(store, a, d, "rate")
        return f"Occurrence ratee : {a['label']}"

    if name == "action_defer":   # reporter une action ponctuelle de N jours
        a = _action(store, op["id"])
        if a.get("recurrence"):
            raise ValueError("Une routine ne se reporte pas : saute l'occurrence.")
        jours = int(op.get("jours") or 1)
        base = a.get("echeance") or today()
        a["echeance"] = _shift_iso(base, jours)
        return f"Action reportee au {a['echeance']} : {a['label']}"

    if name == "action_reorder":
        acts = _actions(store)
        i = next((k for k, x in enumerate(acts) if x["id"] == op["id"]), None)
        if i is None:
            raise ValueError(f"Action introuvable: {op['id']}")
        j = max(0, min(len(acts) - 1, i + (1 if op.get("sens") == "bas" else -1)))
        acts[i], acts[j] = acts[j], acts[i]
        for k, x in enumerate(acts):
            x["ordre"] = k
        return "Actions reordonnees"

    if name == "action_remove":
        a = _action(store, op["id"])
        store["actions"] = [x for x in _actions(store) if x["id"] != op["id"]]
        for s in store.setdefault("timelog", []):   # les plages chronometrees restent, sans rattachement
            if s.get("action_id") == op["id"]:
                s["action_id"] = None
                s["kind"] = "libre"
        return ("Routine supprimee : " if a.get("recurrence") else "Action supprimee : ") + a["label"]

    # ---- Notes : journal horodate ---------------------------------------- #
    if name == "note_add":
        corps = (op.get("corps") or "").strip()
        titre = (op.get("titre") or "").strip()
        if not corps and not titre:
            raise ValueError("Une note vide n'a rien a tracer.")
        typ = op.get("type") or "note"
        if typ not in NOTE_TYPES:
            raise ValueError(f"Type de note invalide: {typ}")
        cid = op.get("chantier_id") or None
        if cid:
            _chantier(store, cid)
        n = {
            "id": _uid("nt_"), "date": op.get("date") or today(),
            "heure": op.get("heure") or _hm(),      # l'heure est posee d'office : c'est tout l'interet
            "type": typ, "titre": titre, "corps": corps,
            "theme_id": _theme_id_valide(store, op.get("theme_id")),
            "chantier_id": cid,
            "contact_ids": [c for c in (op.get("contact_ids") or []) if c],
            "epingle": False, "cree_le": today(), "maj_le": None,
        }
        _notes(store).insert(0, n)
        # Pieces deposees avant l'enregistrement : elles attendaient (note_id vide).
        joints = 0
        for fid in (op.get("piece_ids") or []):
            f = next((x for x in _fichiers(store) if x.get("id") == fid), None)
            if f is not None and not f.get("note_id"):
                f["note_id"] = n["id"]
                joints += 1
        return ("Note enregistree" + (f" : {titre}" if titre else "")
                + (f" ({joints} document{'s' if joints > 1 else ''} joint{'s' if joints > 1 else ''})"
                   if joints else ""))

    if name == "note_update":
        n = _note(store, op["id"])
        for k in ("titre", "corps"):
            if k in op and op[k] is not None:
                n[k] = str(op[k]).strip()
        if "type" in op and op["type"]:
            if op["type"] not in NOTE_TYPES:
                raise ValueError(f"Type de note invalide: {op['type']}")
            n["type"] = op["type"]
        if "theme_id" in op:
            n["theme_id"] = _theme_id_valide(store, op["theme_id"])
        if "chantier_id" in op:
            n["chantier_id"] = op["chantier_id"] or None
            if n["chantier_id"]:
                _chantier(store, n["chantier_id"])
        if "contact_ids" in op:
            n["contact_ids"] = [c for c in (op.get("contact_ids") or []) if c]
        if "date" in op and op["date"]:
            n["date"] = op["date"]
        if "heure" in op:
            n["heure"] = op["heure"] or ""
        if not n["corps"].strip() and not n["titre"].strip():
            raise ValueError("Une note vide n'a rien a tracer.")
        n["maj_le"] = today()                       # trace la reecriture : "quoi et quand" reste vrai
        return "Note mise a jour"

    if name == "note_pin":
        n = _note(store, op["id"])
        n["epingle"] = (not n.get("epingle")) if "epingle" not in op else bool(op["epingle"])
        return "Note epinglee" if n["epingle"] else "Note desepinglee"

    if name == "note_remove":
        n = _note(store, op["id"])
        store["notes"] = [x for x in _notes(store) if x["id"] != op["id"]]
        joints = [f for f in _fichiers(store) if f.get("note_id") == n["id"]]
        for f in joints:                        # les pieces suivent la note : pas de binaire orphelin
            _fichier_unlink(f)
        store["fichiers"] = [f for f in _fichiers(store) if f.get("note_id") != n["id"]]
        return "Note supprimee" + (f" ({len(joints)} document(s) joint(s))" if joints else "")

    if name == "note_to_action":
        # Transforme une ligne d'une note en action : le flux compte-rendu -> decisions.
        n = _note(store, op["id"])
        label = (op.get("label") or n.get("titre") or "").strip()
        if not label:
            raise ValueError("Indique le libelle de l'action a creer.")
        a = {
            "id": _uid("ac_"), "label": label, "desc": f"Issu de la note du {n['date']}.",
            "theme_id": n.get("theme_id"), "chantier_id": n.get("chantier_id"),
            "tache_id": None,
            "contact_id": (n.get("contact_ids") or [None])[0],
            "prio": op.get("prio") if op.get("prio") in PRIOS else "m",
            "echeance": op.get("echeance") or None, "heure": None,
            "estimation_min": 0, "recurrence": None, "occurrences": [],
            "done": False, "done_date": None, "actif": True,
            "cree_le": today(), "ordre": len(_actions(store)), "note_id": n["id"],
        }
        _actions(store).append(a)
        return f"Action creee depuis la note : {label}"

    # ---- Pieces jointes --------------------------------------------------- #
    if name == "fichier_add":
        nom = _nom_sur(op.get("nom"))
        try:
            data = base64.b64decode((op.get("b64") or "").split(",")[-1])
        except Exception:
            raise ValueError(f"Document illisible : {nom}")
        if not data:
            raise ValueError(f"Document vide : {nom}")
        if len(data) > FICHIER_MAX:
            raise ValueError(f"« {nom} » pese {len(data) / 1048576:.1f} Mio. "
                             f"Limite : {FICHIER_MAX // 1048576} Mio par document.")
        nid = op.get("note_id") or None
        if nid:
            _note(store, nid)                   # rattachement verifie AVANT d'ecrire sur le disque
        ext = _ext_sure(nom)
        f = {"id": _uid("fi_"), "nom": nom, "ext": ext, "taille": len(data),
             "mime": FICHIER_EXT_MIME.get(ext, "application/octet-stream"),
             "note_id": nid, "cree_le": today(), "heure": _hm()}
        os.makedirs(FICHIERS_DIR, exist_ok=True)
        with open(fichier_path(f), "wb") as fh:
            fh.write(data)
        _fichiers(store).append(f)
        return f"Document joint : {nom}"

    if name == "fichier_remove":
        f = _fichier(store, op["id"])
        store["fichiers"] = [x for x in _fichiers(store) if x["id"] != f["id"]]
        _fichier_unlink(f)
        return f"Document retire : {f['nom']}"

    if name == "fichier_attach":
        f = _fichier(store, op["id"])
        nid = op.get("note_id") or None
        if nid:
            _note(store, nid)
        f["note_id"] = nid
        return f"Document rattache : {f['nom']}" if nid else f"Document detache : {f['nom']}"

    # ---- Absences (congés, RTT, fériés) ---------------------------------- #
    if name == "add_absence":
        debut = (op.get("debut") or "").strip()
        if not debut:
            raise ValueError("Date de début requise.")
        fin = (op.get("fin") or "").strip() or debut
        if fin < debut:
            debut, fin = fin, debut
        typ = op.get("type") or "conge"
        if typ not in ABSENCE_TYPES:
            raise ValueError(f"Type d'absence invalide: {typ}")
        dup = _absence_overlap(store, debut, fin, typ, op.get("contact_id"))
        if dup:
            raise ValueError(f"Chevauche une absence existante : « {dup['label']} » "
                             f"du {dup['debut']} au {dup['fin']}.")
        a = {"id": _uid("ab_"), "debut": debut, "fin": fin, "type": typ,
             "label": (op.get("label") or "").strip() or ABSENCE_LABELS[typ],
             "contact_id": op.get("contact_id") or None, "note": (op.get("note") or "").strip()}
        store.setdefault("absences", []).append(a)
        store["absences"].sort(key=lambda x: x["debut"])
        n = _absence_jours(a)
        return f"Absence posée : {a['label']} du {debut} au {fin} ({n} j ouvré{'s' if n > 1 else ''})"

    if name == "update_absence":
        a = _sub(store.setdefault("absences", []), op["id"], "Absence")
        debut, fin = a["debut"], a["fin"]
        if op.get("debut"):
            debut = op["debut"].strip()
        if op.get("fin"):
            fin = op["fin"].strip()
        if fin < debut:
            debut, fin = fin, debut
        typ = op.get("type") or a["type"]
        cid = op["contact_id"] if "contact_id" in op else a.get("contact_id")
        dup = _absence_overlap(store, debut, fin, typ, cid, skip_id=a["id"])
        if dup:
            raise ValueError(f"Chevauche une absence existante : « {dup['label']} » "
                             f"du {dup['debut']} au {dup['fin']}.")
        a["debut"], a["fin"] = debut, fin
        if op.get("type"):
            if op["type"] not in ABSENCE_TYPES:
                raise ValueError(f"Type d'absence invalide: {op['type']}")
            a["type"] = op["type"]
        if "label" in op and op["label"] is not None:
            a["label"] = str(op["label"]).strip() or ABSENCE_LABELS.get(a["type"], "Absence")
        if "contact_id" in op:
            a["contact_id"] = op["contact_id"] or None
        if "note" in op and op["note"] is not None:
            a["note"] = str(op["note"]).strip()
        store["absences"].sort(key=lambda x: x["debut"])
        return f"Absence mise à jour : {a['label']} du {a['debut']} au {a['fin']}"

    if name == "remove_absence":
        a = _sub(store.setdefault("absences", []), op["id"], "Absence")
        store["absences"] = [x for x in store["absences"] if x["id"] != op["id"]]
        return f"Absence supprimée : {a['label']} du {a['debut']} au {a['fin']}"

    if name == "import_feries":
        try:
            year = int(op.get("annee") or date.today().year)
        except (TypeError, ValueError):
            raise ValueError("Année invalide.")
        if not 1970 <= year <= 2100:
            raise ValueError("Année hors plage (1970-2100).")
        abs_list = store.setdefault("absences", [])
        connus = {x["debut"] for x in abs_list if x.get("type") == "ferie"}
        ajout = 0
        for iso, nom in feries_fr(year):
            if iso in connus or date.fromisoformat(iso).weekday() >= 5:
                continue        # deja importe, ou tombe un week-end (deja non travaille)
            abs_list.append({"id": _uid("ab_"), "debut": iso, "fin": iso, "type": "ferie",
                             "label": nom, "contact_id": None, "note": ""})
            ajout += 1
        abs_list.sort(key=lambda x: x["debut"])
        if not ajout:
            return f"Jours fériés {year} : déjà à jour"
        return f"Jours fériés {year} importés : {ajout} jour{'s' if ajout > 1 else ''}"

    # ---- Suivi du temps (chrono) ----------------------------------------- #
    if name == "clock_start":
        kind = op.get("kind") or "libre"
        label = (op.get("label") or "").strip()
        refs = {k: op.get(k) for k in ("chantier_id", "tache_id", "action_id", "iteration_id",
                                       "point_id", "theme_id") if op.get(k)}
        if not label and kind == "tache" and refs.get("chantier_id") and refs.get("tache_id"):
            ch = _chantier(store, refs["chantier_id"])
            label = _sub(ch["taches"], refs["tache_id"], "Tache")["label"]
        if refs.get("action_id"):
            a = _action(store, refs["action_id"])
            kind = "action"
            if not label:
                label = a["label"]
            # action rattachée : son temps est compté sur le chantier / la tâche / le thème
            for k in ("chantier_id", "tache_id", "theme_id"):
                if a.get(k) and not refs.get(k):
                    refs[k] = a[k]
        if not label and kind == "recette" and refs.get("chantier_id"):
            ch = _chantier(store, refs["chantier_id"])
            pt = next((x for x in (ch.get("recette") or {}).get("points", [])
                       if x["id"] == refs.get("point_id")), None)
            label = f"Recette — {pt['titre']}" if pt else f"Recette — {ch['titre']}"
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
        if "theme_id" in op:      # classer une plage "libre" : elle sort du fourre-tout gris
            s["theme_id"] = _theme_id_valide(store, op["theme_id"])
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
            "chantier_id": op.get("chantier_id"), "tache_id": op.get("tache_id"),
            "action_id": op.get("action_id"), "iteration_id": op.get("iteration_id"),
            "point_id": op.get("point_id"),
            "theme_id": _theme_id_valide(store, op.get("theme_id")),
        })
        return f"Plage ajoutée : {label}"

    # ---- Rapport hebdomadaire (bilan + à venir + REX) --------------------- #
    if name == "rapport_generate":   # crée le rapport de la semaine, ou recalcule ses faits
        semaine = (op.get("semaine") or "").strip() or _iso_week(date.today())
        debut, fin = _week_bounds(semaine)
        # Rituel du vendredi : le bilan d'une semaine ne s'établit qu'à partir de
        # SON vendredi (les semaines passées restent générables : rattrapage).
        vendredi = _shift_iso(debut, 4)
        if today() < vendredi:
            raise ValueError(f"Le bilan de la semaine {semaine} s'établit à partir de son vendredi "
                             f"({vendredi[8:10]}/{vendredi[5:7]}) — patience, ou navigue vers une semaine passée.")
        raps = store.setdefault("rapports", [])
        r = next((x for x in raps if x.get("semaine") == semaine), None)
        if r is not None and r.get("statut") == "finalise":
            raise ValueError("Rapport finalisé : rouvre-le avant d'actualiser ses données.")
        facts = _rapport_facts(store, debut, fin)
        creation = r is None
        if creation:
            r = {"id": _uid("rh_"), "semaine": semaine, "debut": debut, "fin": fin,
                 "statut": "brouillon",
                 "cree_le": datetime.now().isoformat(timespec="seconds"),
                 "cree_par": _moi_nom(store),                    # visa de création (traçabilité)
                 "vise_par": "",
                 "maj_le": None, "finalise_le": None,
                 "synthese": "", "priorites": "",
                 "rex_general": {"positif": "", "negatif": "", "actions": ""},
                 "points": [], "exclus": []}
            raps.append(r)
            raps.sort(key=lambda x: x.get("semaine", ""))
        # Fusion : l'auto est remplacé, la rédaction (avancement/rex) est conservée.
        anciens = {p.get("chantier_id"): p for p in r.get("points", [])}
        points = []
        for cid, auto in facts["points"].items():
            if cid in r.get("exclus", []):
                continue
            p = anciens.pop(cid, None) or {"chantier_id": cid, "manuel": False,
                                           "avancement": "", "rex": ""}
            p["chantier"] = facts["titres"].get(cid) or p.get("chantier", "")
            p["auto"] = auto
            points.append(p)
        for cid, p in anciens.items():   # ajoutés à la main ou déjà rédigés : jamais perdus
            if p.get("manuel") or (p.get("avancement") or "").strip() or (p.get("rex") or "").strip():
                ch = next((c for c in store.get("chantiers", []) if c.get("id") == cid), None)
                p["auto"] = _rapport_auto_vide(ch) if ch else (p.get("auto") or {})
                points.append(p)
        points.sort(key=lambda p: (-(p.get("auto", {}).get("temps_min") or 0),
                                   -len(p.get("auto", {}).get("taches") or []),
                                   p.get("chantier", "")))
        r["points"] = points
        r["stats"], r["avenir"] = facts["stats"], facts["avenir"]
        r["termines"], r["gantt"] = facts["termines"], facts["gantt"]
        r["hors_chantier"] = facts["hors_chantier"]
        # Le travail qui n'appartient a aucun chantier : il etait calcule mais jamais
        # range dans le rapport — donc compte dans les KPI et invisible dans le bilan.
        r["actions_faites"] = facts["actions_faites"]
        r["routines_tenue"] = facts["routines_tenue"]
        r["notes_libres"] = facts["notes_libres"]
        _rapport_masque(r)      # ce que l'utilisateur a ecarte le reste apres recalcul
        # Retards : la liste est recalculée, les justifications déjà saisies survivent.
        justifs = {x.get("chantier_id"): x.get("justification", "")
                   for x in r.get("retards", []) if (x.get("justification") or "").strip()}
        for x in facts["retards"]:
            if justifs.get(x["chantier_id"]):
                x["justification"] = justifs[x["chantier_id"]]
        r["retards"] = facts["retards"]
        if not r.get("cree_par"):                # rapports d'avant le visa : rattrapage
            r["cree_par"] = _moi_nom(store)
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return (f"Rapport de la semaine {semaine} " + ("créé" if creation else "actualisé")
                + f" — {len(points)} chantier(s) au bilan, {len(r['retards'])} retard(s) à justifier")

    if name == "rapport_update":   # rédaction : synthèse, priorités, REX général
        r = _rapport(store, op["rapport_id"])
        for f in ("synthese", "priorites"):
            if f in op and op[f] is not None:
                r[f] = str(op[f])
        rg = r.setdefault("rex_general", {"positif": "", "negatif": "", "actions": ""})
        for f in ("positif", "negatif", "actions"):
            if "rex_" + f in op and op["rex_" + f] is not None:
                rg[f] = str(op["rex_" + f])
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return "Rapport mis à jour"

    if name == "rapport_point_update":   # rédaction d'un point : avancement, REX
        r = _rapport(store, op["rapport_id"])
        p = next((x for x in r.get("points", [])
                  if x.get("chantier_id") == op.get("chantier_id")), None)
        if p is None:
            raise ValueError("Ce chantier n'est pas dans le rapport.")
        for f in ("avancement", "rex"):
            if f in op and op[f] is not None:
                p[f] = str(op[f])
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return "Point du rapport mis à jour"

    if name == "rapport_point_add":
        r = _rapport(store, op["rapport_id"])
        if r.get("statut") == "finalise":
            raise ValueError("Rapport finalisé : rouvre-le pour le modifier.")
        ch = _chantier(store, op["chantier_id"])
        if any(p.get("chantier_id") == ch["id"] for p in r.get("points", [])):
            raise ValueError("Ce chantier est déjà dans le rapport.")
        r["exclus"] = [x for x in r.get("exclus", []) if x != ch["id"]]
        facts = _rapport_facts(store, r["debut"], r["fin"])
        auto = facts["points"].get(ch["id"]) or _rapport_auto_vide(ch)
        r.setdefault("points", []).append({"chantier_id": ch["id"], "chantier": ch.get("titre", ""),
                                           "manuel": True, "avancement": "", "rex": "",
                                           "auto": auto})
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return f"« {ch.get('titre', '')} » ajouté au rapport"

    if name == "rapport_point_remove":
        r = _rapport(store, op["rapport_id"])
        if r.get("statut") == "finalise":
            raise ValueError("Rapport finalisé : rouvre-le pour le modifier.")
        cid = op.get("chantier_id")
        avant = len(r.get("points", []))
        r["points"] = [p for p in r.get("points", []) if p.get("chantier_id") != cid]
        if len(r["points"]) == avant:
            raise ValueError("Ce chantier n'est pas dans le rapport.")
        if cid not in r.setdefault("exclus", []):
            r["exclus"].append(cid)
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return "Chantier retiré du rapport"

    if name == "rapport_hc_remove":
        # Retire une ligne calculee du rapport (note, action, routine, temps hors
        # chantier). L'objet lui-meme n'est PAS touche : seul son affichage au
        # rapport est ecarte, et l'exclusion survit aux « Actualiser ».
        r = _rapport(store, op["rapport_id"])
        if r.get("statut") == "finalise":
            raise ValueError("Rapport finalisé : rouvre-le pour le modifier.")
        cle = (op.get("cle") or "").strip()
        fam = cle.split(":", 1)[0].split("#", 1)[0]
        if not cle or fam == cle:
            raise ValueError("Element a retirer non identifie.")
        if fam not in ("note", "action", "routine", "temps"):
            raise ValueError(f"Famille inconnue: {fam}")
        r.setdefault("exclus_hc", [])
        if cle in r["exclus_hc"]:
            return "Élément déjà retiré du rapport"
        # Un retrait qui ne retire rien doit se voir : sinon un clic sans effet
        # passe pour un bug de l'application.
        avant = _hc_total(r)
        r["exclus_hc"].append(cle)
        _rapport_masque(r)
        if _hc_total(r) == avant:
            r["exclus_hc"].remove(cle)
            raise ValueError("Élément introuvable dans le rapport — clique « ↻ Actualiser "
                             "les données » puis réessaie.")
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return "Élément retiré du rapport"

    if name == "rapport_hc_reset":   # remet tout ce qui avait ete ecarte
        r = _rapport(store, op["rapport_id"])
        if r.get("statut") == "finalise":
            raise ValueError("Rapport finalisé : rouvre-le pour le modifier.")
        n = len(r.get("exclus_hc") or [])
        if not n:
            return "Aucun élément écarté"
        r["exclus_hc"] = []
        # les faits ecartes ont ete retires des listes : il faut les recalculer
        facts = _rapport_facts(store, r["debut"], r["fin"])
        for cid, auto in facts["points"].items():
            p = next((x for x in r.get("points", []) if x.get("chantier_id") == cid), None)
            if p is not None:
                p["auto"] = auto
        r["hors_chantier"] = facts["hors_chantier"]
        r["actions_faites"] = facts["actions_faites"]
        r["routines_tenue"] = facts["routines_tenue"]
        r["notes_libres"] = facts["notes_libres"]
        r["stats"] = facts["stats"]
        _rapport_masque(r)
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return f"{n} élément(s) réaffiché(s)"

    if name == "rapport_retard_update":   # justification d'un retard (rédaction)
        r = _rapport(store, op["rapport_id"])
        x = next((x for x in r.get("retards", [])
                  if x.get("chantier_id") == op.get("chantier_id")), None)
        if x is None:
            raise ValueError("Ce chantier n'est pas dans les retards du rapport.")
        x["justification"] = str(op.get("justification") or "")
        r["maj_le"] = datetime.now().isoformat(timespec="seconds")
        return "Justification du retard enregistrée"

    if name == "rapport_finalize":   # fige les faits calculés (plus d'actualisation)
        r = _rapport(store, op["rapport_id"])
        if r.get("statut") == "finalise":
            return "Rapport déjà finalisé"
        # Règle : chaque retard DOIT être justifié avant de finaliser.
        manquants = [x for x in r.get("retards", [])
                     if not (x.get("justification") or "").strip()]
        if manquants:
            raise ValueError(f"{len(manquants)} retard(s) sans justification — la justification "
                             "des retards est obligatoire avant de finaliser le rapport.")
        r["statut"] = "finalise"
        r["finalise_le"] = datetime.now().isoformat(timespec="seconds")
        r["vise_par"] = _moi_nom(store)                  # visa de finalisation (traçabilité)
        return f"Rapport de la semaine {r.get('semaine', '')} finalisé — données figées"

    if name == "rapport_reopen":
        r = _rapport(store, op["rapport_id"])
        r["statut"] = "brouillon"
        r["finalise_le"] = None
        return "Rapport rouvert (brouillon)"

    if name == "rapport_delete":
        r = _rapport(store, op["rapport_id"])
        store["rapports"] = [x for x in store["rapports"] if x.get("id") != r["id"]]
        return f"Rapport de la semaine {r.get('semaine', '')} supprimé"

    if name == "set_settings":
        store.setdefault("settings", {}).update(op.get("settings") or {})
        return "Réglages mis à jour"

    raise ValueError(f"Operation inconnue: {name}")
