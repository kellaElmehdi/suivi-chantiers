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
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _store_payload(self):
        return {"store": store.load(), "today": store.today()}

    # -- GET ------------------------------------------------------------- #
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            return self._file(os.path.join(STATIC, "index.html"))
        if path == "/api/store":
            return self._send(200, self._store_payload())
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
        if path.startswith("/static/"):
            rel = path[len("/static/"):].replace("..", "")
            return self._file(os.path.join(STATIC, rel))
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
        try:
            body = self._json_body()
        except Exception:  # noqa: BLE001
            return self._send(400, {"error": "JSON invalide"})

        if path == "/api/mutate":
            st = store.load()
            try:
                msg = store.apply_op(st, body)
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except KeyError as e:                      # champ requis manquant -> 400 propre (pas un 500 muet)
                return self._send(400, {"error": f"Champ requis manquant : {e}"})
            store.save(st)
            return self._send(200, {"ok": True, "message": msg, **self._store_payload()})

        if path == "/api/import":
            import base64
            import export_xlsx
            try:
                raw = base64.b64decode((body.get("b64") or "").split(",")[-1])
                st = store.load()
                n_ch, n_t, n_l = export_xlsx.import_into(st, raw)
                store.save(st)
            except Exception as e:  # noqa: BLE001
                return self._send(400, {"error": f"Import impossible : {e}"})
            return self._send(200, {"ok": True,
                                    "message": f"{n_ch} chantier(s), {n_t} tâche(s), {n_l} livrable(s) importés.",
                                    **self._store_payload()})

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
