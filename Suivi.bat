@echo off
REM Lanceur double-clic du Suivi des chantiers.
REM Demarre le serveur Python (avec son venv) et ouvre le navigateur.
cd /d "%~dp0"

REM -- Arrete tout serveur app.py deja lance (sinon l'ancien code reste en --
REM -- memoire et les nouvelles operations renvoient "Operation inconnue"). --
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR Name='python.exe'\" | Where-Object { $_.CommandLine -match 'app\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

if exist ".venv\Scripts\pythonw.exe" (
    start "" ".venv\Scripts\pythonw.exe" app.py
) else (
    echo Premiere utilisation : creation de l'environnement...
    py -m venv .venv
    ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
    ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
    start "" ".venv\Scripts\pythonw.exe" app.py
)
