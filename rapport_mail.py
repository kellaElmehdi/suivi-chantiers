"""Envoi du rapport hebdomadaire par e-mail (pièce jointe PDF).

Chaîne 100 % locale, sans dépendance Python :
1. le HTML imprimable (généré par l'UI, identique à « Imprimer / PDF »)
   est converti en PDF par Edge en mode headless ;
2. le PDF est archivé dans data/rapports/ (traçabilité) ;
3. un brouillon est ouvert dans la messagerie du poste, pièce jointe attachée.

Le brouillon passe par un fichier .eml portant l'en-tête `X-Unsent: 1` : c'est
ce qui fait ouvrir le fichier en RÉDACTION (bouton Envoyer) et non en lecture.
Cette voie marche avec l'ancien comme avec le NOUVEAU Outlook, contrairement à
l'automatisation COM qui n'existe pas dans le nouveau (olk.exe) — elle y échoue
avec 0x80080005 CO_E_SERVER_EXEC_FAILURE. Elle évite aussi PowerShell, dont
l'antivirus du poste bloque une partie des scripts. Le COM reste en second
recours pour les postes où seul l'Outlook classique est automatisable.
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
from email.message import EmailMessage

BASE = os.path.dirname(os.path.abspath(__file__))
PDF_DIR = os.path.join(BASE, "data", "rapports")

EDGE_PATHS = [
    os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
    os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
]


def _edge() -> str:
    for p in EDGE_PATHS:
        if os.path.isfile(p):
            return p
    raise RuntimeError("Microsoft Edge introuvable — impossible de produire le PDF.")


def build_pdf(html: str, semaine: str) -> str:
    """HTML imprimable -> data/rapports/rapport_<semaine>.pdf (Edge headless)."""
    os.makedirs(PDF_DIR, exist_ok=True)
    pdf = os.path.join(PDF_DIR, f"rapport_{semaine}.pdf")
    if os.path.exists(pdf):
        os.remove(pdf)
    with tempfile.TemporaryDirectory(prefix="suivi_rapport_") as tmp:
        src = os.path.join(tmp, "rapport.html")
        with open(src, "w", encoding="utf-8") as f:
            f.write(html)
        # --user-data-dir dédié : ne pas entrer en conflit avec un Edge déjà ouvert
        subprocess.run(
            [_edge(), "--headless", "--disable-gpu", "--no-first-run",
             f"--user-data-dir={os.path.join(tmp, 'profil')}",
             f"--print-to-pdf={pdf}", "--no-pdf-header-footer",
             pathlib.Path(src).as_uri()],
            timeout=90, capture_output=True, check=False,
        )
    if not os.path.isfile(pdf) or os.path.getsize(pdf) == 0:
        raise RuntimeError("La conversion PDF a échoué (Edge headless).")
    return pdf


def _ps(script: str, timeout: int) -> subprocess.CompletedProcess:
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False,
                                     encoding="utf-8-sig") as f:
        f.write(script)
        ps1 = f.name
    try:
        return subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
            timeout=timeout, capture_output=True,
        )
    finally:
        try:
            os.remove(ps1)
        except OSError:
            pass


def build_eml(pdf: str, semaine: str, sujet: str, corps: str, dest: str = "") -> str:
    """Brouillon .eml (PDF joint) archivé à côté du PDF, prêt à être ouvert."""
    m = EmailMessage()
    m["Subject"] = sujet
    if dest:
        m["To"] = dest
    m["X-Unsent"] = "1"      # ouvre en rédaction, avec le bouton « Envoyer »
    m.set_content(corps)
    with open(pdf, "rb") as f:
        m.add_attachment(f.read(), maintype="application", subtype="pdf",
                         filename=os.path.basename(pdf))
    eml = os.path.join(PDF_DIR, f"rapport_{semaine}.eml")
    with open(eml, "wb") as f:
        f.write(bytes(m))
    return eml


def open_eml(eml: str) -> bool:
    """Ouvre le brouillon dans la messagerie par défaut. False si rien ne l'ouvre."""
    try:
        os.startfile(eml)    # noqa: S606 — ouverture par l'association Windows
        return True
    except (OSError, AttributeError):
        return False


def compose_outlook(pdf: str, sujet: str, corps: str) -> bool:
    """Ouvre un brouillon Outlook avec la pièce jointe. False si non automatisable."""
    script = f"""
$ErrorActionPreference = 'Stop'
try {{
  $o = New-Object -ComObject Outlook.Application
  $m = $o.CreateItem(0)
  $m.Subject = @'
{sujet}
'@.Trim()
  $m.Body = @'
{corps}
'@
  $null = $m.Attachments.Add('{pdf}')
  $m.Display()
  exit 0
}} catch {{ exit 1 }}
"""
    try:
        return _ps(script, timeout=60).returncode == 0
    except subprocess.TimeoutExpired:
        return False


def send(rapport: dict, html: str) -> dict:
    """Prépare l'e-mail du rapport : PDF + brouillon Outlook (ou dossier en repli)."""
    semaine = rapport.get("semaine", "")
    num = semaine.split("-W")[-1] or "?"

    def _fr(iso):
        return f"{iso[8:10]}/{iso[5:7]}/{iso[0:4]}" if iso else ""

    pdf = build_pdf(html, semaine)
    sujet = f"Rapport hebdomadaire — Semaine {num} ({_fr(rapport.get('debut'))} au {_fr(rapport.get('fin'))})"
    qui = rapport.get("vise_par") or rapport.get("cree_par") or ""
    corps = ("Bonjour,\n\n"
             f"Veuillez trouver ci-joint le rapport hebdomadaire de la semaine {num} "
             f"(du {_fr(rapport.get('debut'))} au {_fr(rapport.get('fin'))}).\n\n"
             "Cordialement,\n" + qui)
    # 1. le brouillon .eml : marche avec l'ancien ET le nouveau Outlook.
    eml = build_eml(pdf, semaine, sujet, corps, rapport.get("destinataire", ""))
    if open_eml(eml):
        return {"mode": "eml", "pdf": pdf, "eml": eml,
                "message": "Brouillon ouvert dans ta messagerie — le PDF est en pièce jointe, "
                           "il ne reste qu'à choisir le destinataire et envoyer."}
    # 2. repli : automatisation de l'Outlook classique (postes sans association .eml)
    if compose_outlook(pdf, sujet, corps):
        return {"mode": "outlook", "pdf": pdf, "eml": eml,
                "message": "Brouillon Outlook ouvert — le PDF est en pièce jointe, il ne reste qu'à choisir le destinataire et envoyer."}
    # 3. dernier recours : montrer le PDF dans l'Explorateur pour un glisser-déposer
    try:
        subprocess.Popen(["explorer", "/select,", pdf])
    except OSError:
        pass
    return {"mode": "dossier", "pdf": pdf, "eml": eml,
            "message": f"Aucune messagerie n'a pu être ouverte automatiquement — le PDF est prêt : {pdf} "
                       "(fenêtre Explorateur ouverte, glisse-le dans ton e-mail)."}
