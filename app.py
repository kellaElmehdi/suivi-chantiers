"""Serveur local du suivi des chantiers.

Lancement : double-clic sur Suivi.bat (ou `python app.py`).
- Sert l'interface (static/) et une petite API JSON.
- Stocke tout dans data/store.json (sauvegarde atomique).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")


def _load_dotenv() -> None:
    """Parse minimal de .env (KEY=VALUE), sans dependance externe."""
    path = os.path.join(BASE, ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


_load_dotenv()

import store  # noqa: E402  (apres .env, au cas ou)

_STORE_LOCK = threading.Lock()   # serialise lecture-modif-ecriture du store (ThreadingHTTPServer multi-thread)

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silencieux
        pass

    # -- helpers --------------------------------------------------------- #
    def _send(self, code, body=b"", ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json_body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n > 16 * 1024 * 1024:                  # 16 MiB : borne anti-abus (import xlsx en base64 compris)
            raise ValueError("Corps de requete trop volumineux")
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _local_only(self) -> bool:
        # anti-CSRF : on n'accepte les requetes mutantes que depuis l'appli locale (origine/host loopback)
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
            return False
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("", "127.0.0.1", "localhost", "::1")

    def _store_payload(self):
        return {"store": store.load(), "today": store.today()}

    # -- GET ------------------------------------------------------------- #
    def do_GET(self):
        path, _, qs = self.path.partition("?")
        if path == "/" or path == "/index.html":
            return self._file(os.path.join(STATIC, "index.html"))
        if path == "/api/store":
            return self._send(200, self._store_payload())
        if path == "/api/cdc_docx":
            # Cahier des charges en Word, pour le retoucher hors de l'appli.
            cid = (parse_qs(qs).get("chantier_id") or [""])[0]
            try:
                import cdc_docx
                st = store.load()
                ch = next((c for c in st["chantiers"] if c["id"] == cid), None)
                if ch is None:
                    return self._send(400, {"error": "Chantier introuvable."})
                data, fname = cdc_docx.build(ch)
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                return self._send(500, {"error": str(e)})
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-"
                                             "officedocument.wordprocessingml.document")
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if path in ("/api/export", "/api/template"):
            try:
                import export_xlsx
                if path == "/api/export":
                    data, fname = export_xlsx.build(), "suivi_chantiers.xlsx"
                else:
                    data, fname = export_xlsx.build_template(), "modele_import_chantiers.xlsx"
            except Exception as e:  # noqa: BLE001
                return self._send(500, {"error": str(e)})
            self.send_response(200)
            self.send_header("Content-Type",
                             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if path == "/api/fichier":
            # Piece jointe d'une note : le binaire vit dans data/fichiers/,
            # nomme par son id. Le nom d'origine ne sert qu'a l'en-tete de
            # telechargement, jamais a construire le chemin.
            fid = (parse_qs(qs).get("id") or [""])[0]
            st = store.load()
            f = next((x for x in st.get("fichiers", []) if x.get("id") == fid), None)
            if f is None:
                return self._send(404, {"error": "Document introuvable."})
            fp = store.fichier_path(f)
            if not os.path.isfile(fp):
                return self._send(404, {"error": "Le fichier n'est plus sur le disque."})
            with open(fp, "rb") as fh:
                data = fh.read()
            nom = f.get("nom") or "document"
            ascii_nom = nom.encode("ascii", "replace").decode("ascii").replace('"', "'")
            # inline = apercu dans l'onglet (images, PDF, texte) ; le reste se telecharge.
            dispo = "inline" if (f.get("ext") or "") in store.FICHIER_INLINE else "attachment"
            self.send_response(200)
            self.send_header("Content-Type", f.get("mime") or "application/octet-stream")
            self.send_header("X-Content-Type-Options", "nosniff")   # pas de reniflage de type
            self.send_header("Content-Disposition",
                             f'{dispo}; filename="{ascii_nom}"; '
                             f"filename*=UTF-8''{quote(nom)}")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            return self.wfile.write(data)
        if path.startswith("/static/"):
            rel = path[len("/static/"):].lstrip("/\\")
            static_root = os.path.realpath(STATIC)
            full = os.path.realpath(os.path.join(static_root, rel))
            try:   # confinement strict a static/ : bloque .. , chemins absolus, lettre de lecteur, UNC
                if os.path.commonpath([static_root, full]) != static_root:
                    raise ValueError
            except ValueError:
                return self._send(404, {"error": "not found"})
            return self._file(full)
        return self._send(404, {"error": "not found"})

    def _file(self, fp):
        if not os.path.isfile(fp):
            return self._send(404, {"error": "not found"})
        ext = os.path.splitext(fp)[1]
        with open(fp, "rb") as f:
            self._send(200, f.read(), CONTENT_TYPES.get(ext, "application/octet-stream"))

    # -- POST ------------------------------------------------------------ #
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self._local_only():                     # anti-CSRF : refuse les ecritures cross-site
            return self._send(403, {"error": "origine refusee"})
        try:
            body = self._json_body()
        except Exception:  # noqa: BLE001
            return self._send(400, {"error": "JSON invalide"})

        if path == "/api/mutate":
            with _STORE_LOCK:                          # lecture-modif-ecriture atomique : pas de perte d'ecriture concurrente
                st = store.load()
                try:
                    msg = store.apply_op(st, body)
                except ValueError as e:
                    return self._send(400, {"error": str(e)})
                except KeyError as e:                  # champ requis manquant -> 400 propre (pas un 500 muet)
                    return self._send(400, {"error": f"Champ requis manquant : {e}"})
                store.save(st)
                return self._send(200, {"ok": True, "message": msg, **self._store_payload()})

        if path == "/api/cdc_import":
            # Relecture du .docx modifie : les sections reviennent, et le
            # changement est trace comme une revision du document.
            import base64
            try:
                import cdc_docx
                raw = base64.b64decode((body.get("b64") or "").split(",")[-1])
                lu = cdc_docx.parse(raw)
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                return self._send(400, {"error": f"Document illisible : {e}"})
            cid = body.get("chantier_id") or lu.get("chantier_id")
            if not cid:
                return self._send(400, {"error": "Impossible de savoir à quel chantier "
                                                 "rattacher ce document."})
            if (lu.get("chantier_id") and body.get("chantier_id")
                    and lu["chantier_id"] != body["chantier_id"]):
                return self._send(400, {"error": "Ce document appartient à un autre "
                                                 "chantier. Ouvre le bon cahier des charges."})
            with _STORE_LOCK:
                st = store.load()
                try:
                    msg = store.apply_op(st, {"op": "cdc_docx_import", "chantier_id": cid,
                                              "sections": lu["sections"]})
                except ValueError as e:
                    return self._send(400, {"error": str(e)})
                except KeyError as e:
                    return self._send(400, {"error": f"Champ requis manquant : {e}"})
                store.save(st)
                return self._send(200, {"ok": True, "message": msg, **self._store_payload()})

        if path == "/api/import":
            import base64
            import export_xlsx
            try:
                raw = base64.b64decode((body.get("b64") or "").split(",")[-1])
                with _STORE_LOCK:
                    st = store.load()
                    n_ch, n_t, n_l = export_xlsx.import_into(st, raw)
                    store.save(st)
            except Exception as e:  # noqa: BLE001
                return self._send(400, {"error": f"Import impossible : {e}"})
            return self._send(200, {"ok": True,
                                    "message": f"{n_ch} chantier(s), {n_t} tâche(s), {n_l} livrable(s) importés.",
                                    **self._store_payload()})

        if path == "/api/cdc_mail":
            # brouillon e-mail avec le cahier des charges Word en piece jointe
            try:
                import cdc_mail
                st = store.load()
                ch = next((c for c in st["chantiers"]
                           if c["id"] == body.get("chantier_id")), None)
                if ch is None:
                    return self._send(400, {"error": "Chantier introuvable."})
                if not ch.get("cdc"):
                    return self._send(400, {"error": "Ce chantier n'a pas de cahier des charges."})
                res = cdc_mail.send(ch)
            except Exception as e:  # noqa: BLE001
                return self._send(200, {"ok": False,
                                        "message": f"Préparation de l'e-mail impossible : {e}"})
            return self._send(200, {"ok": True, **res})

        if path == "/api/rapport_mail":
            # prépare l'e-mail du rapport : PDF (Edge headless) + brouillon Outlook
            try:
                import rapport_mail
                st = store.load()
                rap = next((x for x in st.get("rapports", [])
                            if x.get("id") == body.get("rapport_id")), None)
                if rap is None:
                    return self._send(400, {"error": "Rapport introuvable."})
                html = body.get("html") or ""
                if not html.strip():
                    return self._send(400, {"error": "Contenu du rapport manquant."})
                res = rapport_mail.send(rap, html)
            except Exception as e:  # noqa: BLE001
                return self._send(200, {"ok": False,
                                        "message": f"Préparation de l'e-mail impossible : {e}"})
            return self._send(200, {"ok": True, **res})

        return self._send(404, {"error": "not found"})


def main():
    port = int(os.environ.get("SUIVI_PORT", "8765"))
    url = f"http://127.0.0.1:{port}/"
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        # un serveur tourne deja sur ce port -> on ouvre simplement la page
        print(f"Suivi deja lance — ouverture de {url}")
        webbrowser.open(url)
        return
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    print(f"Suivi des chantiers — ouvert sur {url}")
    print("Ferme cette fenetre pour arreter le serveur.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
