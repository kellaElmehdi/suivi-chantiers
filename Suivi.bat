@echo off
REM Lanceur double-clic du Suivi des chantiers.
REM Demarre le serveur Python (avec son venv) et ouvre le navigateur.
cd /d "%~dp0"

if exist ".venv\Scripts\pythonw.exe" (
    start "" ".venv\Scripts\pythonw.exe" app.py
) else (
    echo Premiere utilisation : creation de l'environnement...
    py -m venv .venv
    ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
    ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
    start "" ".venv\Scripts\pythonw.exe" app.py
)
