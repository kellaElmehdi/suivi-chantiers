"""Envoi du rapport hebdomadaire par e-mail (pièce jointe PDF).

Chaîne 100 % locale, sans dépendance Python :
1. le HTML imprimable (généré par l'UI, identique à « Imprimer / PDF »)
   est converti en PDF par Edge en mode headless ;
2. le PDF est archivé dans data/rapports/ (traçabilité) ;
3. un brouillon Outlook est ouvert, pièce jointe attachée, prêt à envoyer
   (COM). Si Outlook n'est pas automatisable (ex. « nouveau Outlook »),
   l'Explorateur s'ouvre sur le PDF pour un glisser-déposer manuel.
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile

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
    if compose_outlook(pdf, sujet, corps):
        return {"mode": "outlook", "pdf": pdf,
                "message": "Brouillon Outlook ouvert — le PDF est en pièce jointe, il ne reste qu'à choisir le destinataire et envoyer."}
    # repli : montrer le PDF dans l'Explorateur pour un glisser-déposer
    try:
        subprocess.Popen(["explorer", "/select,", pdf])
    except OSError:
        pass
    return {"mode": "dossier", "pdf": pdf,
            "message": f"Outlook n'est pas automatisable sur ce poste — le PDF est prêt : {pdf} "
                       "(fenêtre Explorateur ouverte, glisse-le dans ton e-mail)."}
