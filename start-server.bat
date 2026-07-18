@echo off
REM Serves this folder at http://localhost:8000 so the app can load its ES
REM modules and talk to Google. Opening index.html directly does NOT work --
REM browsers block both on file:// URLs.

cd /d "%~dp0"

echo.
echo   SufYam Home - Web Console
echo   =========================
echo   Serving at http://localhost:8000
echo   Leave this window open. Press Ctrl+C to stop.
echo.

start "" http://localhost:8000

python -m http.server 8000 2>nul
if errorlevel 1 (
  echo.
  echo   Python not found. Trying Node instead...
  npx --yes serve -l 8000
)

pause
