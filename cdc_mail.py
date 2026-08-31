"""Envoi du cahier des charges par e-mail (piece jointe Word).

Meme chaine que le rapport hebdomadaire (rapport_mail.py) : un brouillon .eml
portant `X-Unsent: 1` s'ouvre en REDACTION dans la messagerie du poste, la
piece jointe deja attachee. Marche avec l'ancien et le nouveau Outlook ; repli
COM puis Explorateur si aucune association .eml.

Difference : la piece jointe est le .docx genere par cdc_docx (la version
EDITABLE, a la charte) — le destinataire peut annoter dans Word et renvoyer,
et le fichier se reimporte dans l'appli avec revision tracee.
"""

from __future__ import annotations

import os
from email.message import EmailMessage

import cdc_docx
from rapport_mail import compose_outlook, open_eml

BASE = os.path.dirname(os.path.abspath(__file__))
CDC_DIR = os.path.join(BASE, "data", "cdc")

_DOCX_MIME = ("application",
              "vnd.openxmlformats-officedocument.wordprocessingml.document")


def _build_eml(docx_path: str, sujet: str, corps: str) -> str:
    m = EmailMessage()
    m["Subject"] = sujet
    m["X-Unsent"] = "1"          # ouvre en redaction, bouton « Envoyer »
    m.set_content(corps)
    with open(docx_path, "rb") as f:
        m.add_attachment(f.read(), maintype=_DOCX_MIME[0], subtype=_DOCX_MIME[1],
                         filename=os.path.basename(docx_path))
    eml = os.path.splitext(docx_path)[0] + ".eml"
    with open(eml, "wb") as f:
        f.write(bytes(m))
    return eml


def send(ch: dict) -> dict:
    """Genere le Word du CDC, l'archive dans data/cdc/, ouvre le brouillon."""
    cdc = ch.get("cdc") or {}
    data, fname = cdc_docx.build(ch)
    os.makedirs(CDC_DIR, exist_ok=True)
    docx_path = os.path.join(CDC_DIR, fname)
    with open(docx_path, "wb") as f:
        f.write(data)

    titre = cdc.get("titre") or ch.get("titre") or "Cahier des charges"
    sujet = "Cahier des charges à valider"
    corps = ("Bonjour,\n\n"
             f"Suite à notre échange, ci-joint le cahier des charges "
             f"« {titre} » pour validation.\n\n"
             "Cordialement,\n" + (cdc.get("redacteur") or ""))

    eml = _build_eml(docx_path, sujet, corps)
    if open_eml(eml):
        return {"mode": "eml", "docx": docx_path, "eml": eml,
                "message": "Brouillon ouvert dans ta messagerie — le cahier des "
                           "charges Word est en pièce jointe, il ne reste qu'à "
                           "choisir le destinataire et envoyer."}
    if compose_outlook(docx_path, sujet, corps):
        return {"mode": "outlook", "docx": docx_path, "eml": eml,
                "message": "Brouillon Outlook ouvert — le cahier des charges Word "
                           "est en pièce jointe, il ne reste qu'à choisir le "
                           "destinataire et envoyer."}
    try:
        import subprocess
        subprocess.Popen(["explorer", "/select,", docx_path])
    except OSError:
        pass
    return {"mode": "dossier", "docx": docx_path, "eml": eml,
            "message": f"Aucune messagerie n'a pu être ouverte automatiquement — "
                       f"le Word est prêt : {docx_path} (fenêtre Explorateur "
                       "ouverte, glisse-le dans ton e-mail)."}
