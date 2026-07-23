"""Excel : export (Chantiers + Taches/timeline + Attentes), modele d'import,
et lecture d'un fichier d'import.

Le format d'export et le modele d'import partagent le meme schema (3 feuilles
Chantiers / Taches / Livrables) -> on peut exporter, editer dans Excel,
reimporter.
"""

from __future__ import annotations

import io
import unicodedata
from datetime import date, datetime, timedelta

STATUT_LBL = {"todo": "A faire", "doing": "En cours", "block": "Bloque", "recette": "Recette", "done": "Termine"}
PRIO_LBL = {"h": "Haute", "m": "Moyenne", "b": "Basse"}
LIV_LBL = {"attente": "En attente", "recu": "Recu", "partiel": "Recu partiel", "annule": "Annule"}

PRIO_IN = {"haute": "h", "moyenne": "m", "basse": "b", "h": "h", "m": "m", "b": "b"}
STATUT_IN = {"a faire": "todo", "en cours": "doing", "bloque": "block", "termine": "done",
             "todo": "todo", "doing": "doing", "block": "block", "done": "done"}
LIV_IN = {"en attente": "attente", "attente": "attente", "recu": "recu", "recu partiel": "partiel",
          "partiel": "partiel", "annule": "annule"}
TRUTHY = {"o", "oui", "x", "true", "vrai", "1", "yes", "y"}


def _norm(s) -> str:
    s = "" if s is None else str(s)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return s.strip().lower()


def _pct(ch: dict) -> int:
    t = ch.get("taches", [])
    return round(100 * sum(1 for x in t if x["done"]) / len(t)) if t else 0


def _is_late(d) -> bool:
    return bool(d) and d < date.today().isoformat()


def _blocked(ch: dict) -> bool:
    # miroir du frontend isBlocked : bloque uniquement si un livrable non reçu a son échéance
    # dépassée — un livrable rattaché à une tâche ne bloque plus tant que la date n'est pas passée.
    if ch.get("statut") == "done":
        return False
    if (ch.get("blocage") or "").strip():
        return True
    today = date.today().isoformat()
    return any(l.get("statut") in ("attente", "partiel") and l.get("date") and l["date"] < today
               for l in ch.get("livrables", []))   # livrable non reçu et en retard


def _safe(v):
    # anti-injection de formule Excel : un texte commençant par = + - @ (ou tab/CR) devient inerte
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def _append(ws, row):   # append d'une ligne de données en neutralisant chaque cellule texte
    ws.append([_safe(x) for x in row])


# --------------------------------------------------------------------------- #
# Mini-CPM cote Python (dates planifiees pour la feuille Taches de l'export)
# --------------------------------------------------------------------------- #
def _addd(s: str, n: int) -> str:
    return (datetime.strptime(s, "%Y-%m-%d") + timedelta(days=n)).strftime("%Y-%m-%d")


def _schedule(ch: dict) -> dict:
    tasks = ch.get("taches", [])
    start = ch.get("date_debut") or date.today().isoformat()
    ids = {t["id"] for t in tasks}
    preds = {t["id"]: [p for p in t.get("preds", []) if p in ids and p != t["id"]] for t in tasks}
    dur = lambda t: 0 if t.get("is_milestone") else max(0, int(t.get("duree") or 0))
    ES = {t["id"]: 0 for t in tasks}
    EF = {t["id"]: dur(t) for t in tasks}
    for _ in range(len(tasks) + 1):
        changed = False
        for t in tasks:
            es = max([EF[p] for p in preds[t["id"]]] or [0])
            if es != ES[t["id"]]:
                ES[t["id"]] = es
                EF[t["id"]] = es + dur(t)
                changed = True
        if not changed:
            break
    return {t["id"]: {"start": _addd(start, ES[t["id"]]), "end": _addd(start, EF[t["id"]])} for t in tasks}


# --------------------------------------------------------------------------- #
# Synthèse hebdomadaire (journal + métriques dérivées des dates existantes)
# --------------------------------------------------------------------------- #
def _iso_week_str(ds: str) -> str:
    try:
        y, w, _ = date.fromisoformat(str(ds)[:10]).isocalendar()
        return f"{y}-W{w:02d}"
    except (ValueError, TypeError):
        return ""


def _week_monday(wk: str) -> str:
    try:
        y, w = wk.split("-W")
        return date.fromisocalendar(int(y), int(w), 1).isoformat()
    except (ValueError, TypeError):
        return ""


def _weekly_synthese(store: dict) -> dict:
    from collections import defaultdict
    m = defaultdict(lambda: {"taches": 0, "jalons": 0, "notes": 0, "retours": 0, "relances": 0, "actions": 0})
    for ch in store.get("chantiers", []):
        for t in ch.get("taches", []):
            if t.get("done") and t.get("done_date"):
                w = _iso_week_str(t["done_date"])
                if w:
                    m[w]["taches"] += 1
                    if t.get("is_milestone"):
                        m[w]["jalons"] += 1
        for e in ch.get("histo", []):
            w = _iso_week_str(e.get("d", ""))
            if w:
                m[w]["notes"] += 1
        for l in ch.get("livrables", []):
            w = _iso_week_str(l.get("derniere") or "")
            if w:
                m[w]["relances"] += 1
        for it in ch.get("iterations", []):
            for r in it.get("retours", []):
                w = _iso_week_str(r.get("date") or "")
                if w:
                    m[w]["retours"] += 1
    for j in store.get("journal", []):
        w = j.get("week") or _iso_week_str(j.get("date", ""))
        if w:
            m[w]["actions"] += 1
    return m


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def _styles():
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    return {
        "head_fill": PatternFill("solid", fgColor="2D2B28"),
        "head_font": Font(color="FFFFFF", bold=True),
        "late_font": Font(color="A8261B", bold=True),
        "border": Border(*[Side(style="thin", color="D9D7CF")] * 4),
        "Alignment": Alignment,
    }


def _header(ws, ncols, st):
    for col in range(1, ncols + 1):
        c = ws.cell(row=1, column=col)
        c.fill, c.font = st["head_fill"], st["head_font"]
    ws.freeze_panes = "A2"
    ws.row_dimensions[1].height = 20


def _widths(ws, ws_widths):
    for i, w in enumerate(ws_widths, 1):
        ws.column_dimensions[chr(64 + i)].width = w


def build() -> bytes:
    from openpyxl import Workbook
    from store import load

    store = load()
    st = _styles()
    Align = st["Alignment"]
    wb = Workbook()

    # --- Chantiers ---
    ws = wb.active
    ws.title = "Chantiers"
    cols = ["Titre", "Objectif", "Debut", "Echeance", "Priorite", "Statut", "Tags",
            "Avancement %", "Point bloquant"]
    ws.append(cols)
    for ch in sorted(store["chantiers"], key=lambda c: c.get("ordre", 0)):
        _append(ws, [ch["titre"], ch.get("objectif") or "", ch.get("date_debut") or "",
                   ch.get("echeance") or "", PRIO_LBL.get(ch["prio"], ch["prio"]),
                   "Bloque" if _blocked(ch) else STATUT_LBL.get(ch["statut"], ch["statut"]),
                   "; ".join(ch.get("tags", [])), _pct(ch), ch.get("blocage") or ""])
        r = ws.max_row
        if ch["statut"] != "done" and _is_late(ch.get("echeance")):
            ws.cell(row=r, column=4).font = st["late_font"]
        for col in range(1, len(cols) + 1):
            ws.cell(row=r, column=col).border = st["border"]
            ws.cell(row=r, column=col).alignment = Align(vertical="top", wrap_text=col in (2, 9))
    _widths(ws, [30, 44, 12, 12, 10, 10, 22, 12, 36])
    _header(ws, len(cols), st)

    # --- Taches (plan + timeline) ---
    ws2 = wb.create_sheet("Taches")
    cols2 = ["Chantier", "Tache", "Jalon", "Duree (j)", "Predecesseurs", "Fait",
             "Debut prevu", "Fin prevue"]
    ws2.append(cols2)
    for ch in sorted(store["chantiers"], key=lambda c: c.get("ordre", 0)):
        sched = _schedule(ch)
        lbl = {t["id"]: t["label"] for t in ch["taches"]}
        for t in ch["taches"]:
            preds = "; ".join(lbl.get(p, "") for p in t.get("preds", []) if p in lbl)
            _append(ws2, [ch["titre"], t["label"], "O" if t.get("is_milestone") else "",
                        0 if t.get("is_milestone") else t.get("duree", 1), preds,
                        "O" if t["done"] else "", sched[t["id"]]["start"], sched[t["id"]]["end"]])
            for col in range(1, len(cols2) + 1):
                ws2.cell(row=ws2.max_row, column=col).border = st["border"]
    _widths(ws2, [28, 38, 7, 10, 30, 6, 12, 12])
    _header(ws2, len(cols2), st)

    # --- Attentes (par personne) ---
    ws3 = wb.create_sheet("Attentes")
    cols3 = ["Personne", "Role", "Chantier", "Livrable attendu", "Pour le", "Statut", "Relances", "Impact"]
    ws3.append(cols3)
    rows = []
    for ch in store["chantiers"]:
        for l in ch["livrables"]:
            late = l["statut"] == "attente" and _is_late(l.get("date"))
            rows.append((l["personne"], l.get("role", ""), ch["titre"], l["quoi"],
                         l.get("date") or "", "EN RETARD" if late else LIV_LBL.get(l["statut"], l["statut"]),
                         l.get("relances", 0), l.get("impact") or "", late))
    rows.sort(key=lambda r: (r[0].lower(), r[4] or "9999"))
    for r in rows:
        _append(ws3, list(r[:8]))
        if r[8]:
            ws3.cell(row=ws3.max_row, column=6).font = st["late_font"]
        for col in range(1, len(cols3) + 1):
            ws3.cell(row=ws3.max_row, column=col).border = st["border"]
            ws3.cell(row=ws3.max_row, column=col).alignment = Align(vertical="top", wrap_text=col in (4, 8))
    _widths(ws3, [22, 16, 28, 40, 12, 13, 9, 34])
    _header(ws3, len(cols3), st)

    # --- Synthese hebdo (progression semaine par semaine) ---
    ws4 = wb.create_sheet("Synthese hebdo")
    cols4 = ["Semaine", "Debut (lundi)", "Taches terminees", "Jalons", "Notes",
             "Retours recus", "Relances", "Actions"]
    ws4.append(cols4)
    syn = _weekly_synthese(store)
    for w in sorted(syn.keys(), reverse=True):
        d = syn[w]
        ws4.append([w, _week_monday(w), d["taches"], d["jalons"], d["notes"],
                    d["retours"], d["relances"], d["actions"]])
        for col in range(1, len(cols4) + 1):
            ws4.cell(row=ws4.max_row, column=col).border = st["border"]
    _widths(ws4, [12, 14, 16, 9, 9, 14, 10, 9])
    _header(ws4, len(cols4), st)

    # --- Journal (toutes les actions horodatees) ---
    ws5 = wb.create_sheet("Journal")
    cols5 = ["Date", "Semaine", "Chantier", "Action"]
    ws5.append(cols5)
    for j in sorted(store.get("journal", []), key=lambda x: x.get("ts", ""), reverse=True):
        _append(ws5, [j.get("date", ""), j.get("week", ""), j.get("chantier", ""), j.get("msg", "")])
        for col in range(1, len(cols5) + 1):
            ws5.cell(row=ws5.max_row, column=col).border = st["border"]
            ws5.cell(row=ws5.max_row, column=col).alignment = Align(vertical="top", wrap_text=col == 4)
    _widths(ws5, [12, 12, 28, 64])
    _header(ws5, len(cols5), st)

    # --- Cahiers des charges (synthese + validation) ---
    CDC_LBL = {"brouillon": "Brouillon", "en_validation": "En validation",
               "valide": "Valide", "obsolete": "Obsolete"}
    ws6 = wb.create_sheet("Cahiers des charges")
    cols6 = ["Chantier", "Reference", "Titre", "Indice", "Statut", "Redige par",
             "Mis a jour", "Valide par", "Date validation", "Parties prenantes", "Lien"]
    ws6.append(cols6)
    for ch in store.get("chantiers", []):
        cdc = ch.get("cdc")
        if not cdc:
            continue
        pp = " ; ".join(f"{p.get('nom', '')}{(' (' + p['role'] + ')') if p.get('role') else ''}"
                        for p in cdc.get("parties_prenantes", []))
        _append(ws6, [ch.get("titre", ""), cdc.get("reference", ""), cdc.get("titre", ""),
                    cdc.get("indice", ""), CDC_LBL.get(cdc.get("statut"), cdc.get("statut", "")),
                    cdc.get("redacteur", ""), cdc.get("date_maj", ""), cdc.get("valide_par", ""),
                    cdc.get("date_validation", "") or "", pp, cdc.get("lien", "")])
        for col in range(1, len(cols6) + 1):
            ws6.cell(row=ws6.max_row, column=col).border = st["border"]
            ws6.cell(row=ws6.max_row, column=col).alignment = Align(vertical="top", wrap_text=col in (3, 10))
    _widths(ws6, [24, 16, 30, 7, 13, 12, 12, 16, 13, 34, 28])
    _header(ws6, len(cols6), st)

    # --- CdC : suivi des modifications (revisions, tous chantiers) ---
    ws7 = wb.create_sheet("CdC revisions")
    cols7 = ["Chantier", "Indice", "Date", "Auteur", "Objet de la modification"]
    ws7.append(cols7)
    for ch in store.get("chantiers", []):
        cdc = ch.get("cdc")
        if not cdc:
            continue
        for r in cdc.get("revisions", []):
            ws7.append([ch.get("titre", ""), r.get("indice", ""), r.get("date", ""),
                        r.get("auteur", ""), r.get("objet", "")])
            for col in range(1, len(cols7) + 1):
                ws7.cell(row=ws7.max_row, column=col).border = st["border"]
                ws7.cell(row=ws7.max_row, column=col).alignment = Align(vertical="top", wrap_text=col == 5)
    _widths(ws7, [24, 7, 12, 16, 60])
    _header(ws7, len(cols7), st)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# Modele d'import
# --------------------------------------------------------------------------- #
def build_template() -> bytes:
    from openpyxl import Workbook
    st = _styles()
    wb = Workbook()

    ws = wb.active
    ws.title = "Chantiers"
    ws.append(["Titre", "Objectif", "Debut", "Echeance", "Priorite", "Statut", "Tags"])
    ws.append(["Nouveau site web", "Refondre le site vitrine", "2026-06-10", "2026-07-15",
               "Haute", "En cours", "Web; Comm"])
    _widths(ws, [28, 40, 12, 12, 10, 10, 20]); _header(ws, 7, st)

    ws2 = wb.create_sheet("Taches")
    ws2.append(["Chantier", "Tache", "Jalon", "Duree (j)", "Predecesseurs"])
    ex = [
        ("Nouveau site web", "Cadrage", "", 2, ""),
        ("Nouveau site web", "Maquettes", "", 4, "Cadrage"),
        ("Nouveau site web", "Validation maquettes", "O", 0, "Maquettes"),
        ("Nouveau site web", "Integration", "", 6, "Validation maquettes"),
        ("Nouveau site web", "Contenus", "", 5, "Cadrage"),
        ("Nouveau site web", "Recette", "", 3, "Integration; Contenus"),
        ("Nouveau site web", "Mise en ligne", "O", 0, "Recette"),
    ]
    for r in ex:
        ws2.append(list(r))
    _widths(ws2, [28, 34, 7, 10, 34]); _header(ws2, 5, st)

    ws3 = wb.create_sheet("Livrables")
    ws3.append(["Chantier", "Personne", "Role", "Livrable", "Pour le", "Statut", "Impact"])
    ws3.append(["Nouveau site web", "Agence", "Prestataire", "Livrer les maquettes",
                "2026-06-20", "En attente", "Bloque l'integration"])
    _widths(ws3, [28, 20, 16, 36, 12, 13, 30]); _header(ws3, 7, st)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# Lecture d'un fichier d'import
# --------------------------------------------------------------------------- #
def _sheet(wb, *names):
    want = {_norm(n) for n in names}
    for s in wb.worksheets:
        if _norm(s.title) in want:
            return s
    return None


def _rows(ws):
    """Renvoie une liste de dicts {header_normalise: valeur}."""
    if ws is None:
        return []
    it = ws.iter_rows(values_only=True)
    try:
        headers = [_norm(h) for h in next(it)]
    except StopIteration:
        return []
    out = []
    for row in it:
        if row is None or all(c is None or str(c).strip() == "" for c in row):
            continue
        out.append({headers[i]: row[i] for i in range(min(len(headers), len(row)))})
    return out


def _cell(d, *keys):
    for k in keys:
        if k in d and d[k] is not None and str(d[k]).strip() != "":
            return d[k]
    return None


def _to_date(v):
    if v is None or str(v).strip() == "":
        return None
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    return s[:10] if len(s) >= 10 and s[4] == "-" else s


def parse_import(data: bytes) -> dict:
    """Lit un classeur d'import et renvoie une structure normalisee :
    {chantiers:[...], taches:{key:[...]}, livrables:{key:[...]}}.
    `key` = titre normalise (pour relier les feuilles entre elles)."""
    from openpyxl import load_workbook
    wb = load_workbook(filename=io.BytesIO(data), data_only=True, read_only=True)

    chantiers, taches, livrables = [], {}, {}
    seen = {}

    def ensure(titre):
        k = _norm(titre)
        if k not in seen:
            seen[k] = {"key": k, "titre": str(titre).strip(), "objectif": "", "debut": None,
                       "echeance": None, "prio": "m", "statut": "todo", "tags": []}
            chantiers.append(seen[k])
            taches[k] = []
            livrables[k] = []
        return seen[k]

    for d in _rows(_sheet(wb, "Chantiers", "Chantier")):
        titre = _cell(d, "titre", "chantier")
        if not titre:
            continue
        c = ensure(titre)
        c["objectif"] = str(_cell(d, "objectif") or "")
        c["debut"] = _to_date(_cell(d, "debut", "date debut", "debut prevu"))
        c["echeance"] = _to_date(_cell(d, "echeance", "echeance prevue"))
        c["prio"] = PRIO_IN.get(_norm(_cell(d, "priorite", "priorite")), "m")
        c["statut"] = STATUT_IN.get(_norm(_cell(d, "statut")), "todo")
        tags = _cell(d, "tags")
        if tags:
            c["tags"] = [t.strip() for t in str(tags).replace(",", ";").split(";") if t.strip()]

    for d in _rows(_sheet(wb, "Taches", "Tache")):
        titre = _cell(d, "chantier")
        label = _cell(d, "tache", "tâche", "label")
        if not titre or not label:
            continue
        ensure(titre)
        preds = _cell(d, "predecesseurs", "predecesseur", "preds")
        preds = [p.strip() for p in str(preds).replace(",", ";").split(";") if p.strip()] if preds else []
        jalon = _norm(_cell(d, "jalon")) in TRUTHY
        try:
            duree = 0 if jalon else max(0, int(float(_cell(d, "duree", "duree (j)", "duree j") or 1)))
        except (ValueError, TypeError):
            duree = 1
        taches[_norm(titre)].append({"label": str(label).strip(), "is_milestone": jalon,
                                     "duree": duree, "preds": preds})

    for d in _rows(_sheet(wb, "Livrables", "Livrable", "Attentes")):
        titre = _cell(d, "chantier")
        quoi = _cell(d, "livrable", "livrable attendu", "quoi")
        personne = _cell(d, "personne")
        if not titre or not quoi or not personne:
            continue
        ensure(titre)
        livrables[_norm(titre)].append({
            "personne": str(personne).strip(), "role": str(_cell(d, "role") or ""),
            "quoi": str(quoi).strip(), "date": _to_date(_cell(d, "pour le", "date", "echeance")),
            "statut": LIV_IN.get(_norm(_cell(d, "statut")), "attente"),
            "impact": str(_cell(d, "impact") or "")})

    wb.close()
    return {"chantiers": chantiers, "taches": taches, "livrables": livrables}


def import_into(store: dict, data: bytes):
    """Cree de NOUVEAUX chantiers dans `store` a partir du classeur. Renvoie
    (nb_chantiers, nb_taches, nb_livrables). Mute store ; l'appelant sauvegarde."""
    import store as store_mod
    parsed = parse_import(data)
    n_ch = n_t = n_l = 0
    for c in parsed["chantiers"]:
        store_mod.apply_op(store, {"op": "create_chantier", "titre": c["titre"],
                                   "objectif": c["objectif"], "prio": c["prio"], "statut": c["statut"],
                                   "echeance": c["echeance"], "date_debut": c["debut"]})
        ch = store["chantiers"][-1]
        n_ch += 1
        for tag in c["tags"]:
            store_mod.apply_op(store, {"op": "add_tag", "chantier_id": ch["id"], "tag": tag})
        # taches (1re passe : creation, on garde label -> id)
        label_to_id = {}
        for t in parsed["taches"].get(c["key"], []):
            store_mod.apply_op(store, {"op": "add_tache", "chantier_id": ch["id"], "label": t["label"],
                                       "is_milestone": t["is_milestone"], "duree": t["duree"]})
            label_to_id[_norm(t["label"])] = ch["taches"][-1]["id"]
            n_t += 1
        # 2e passe : resolution des predecesseurs par label
        for t in parsed["taches"].get(c["key"], []):
            if t["preds"]:
                pred_ids = [label_to_id[_norm(p)] for p in t["preds"] if _norm(p) in label_to_id]
                if pred_ids:
                    tid = label_to_id[_norm(t["label"])]
                    store_mod.apply_op(store, {"op": "update_tache", "chantier_id": ch["id"],
                                               "tache_id": tid, "preds": pred_ids})
        for l in parsed["livrables"].get(c["key"], []):
            store_mod.apply_op(store, {"op": "add_livrable", "chantier_id": ch["id"],
                                       "personne": l["personne"], "role": l["role"], "quoi": l["quoi"],
                                       "date": l["date"], "statut": l["statut"], "impact": l["impact"]})
            n_l += 1
    return n_ch, n_t, n_l
