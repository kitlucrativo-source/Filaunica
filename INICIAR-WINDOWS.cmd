@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instale Node.js 24.14 ou superior da linha 24 antes de iniciar.
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
node --env-file-if-exists=.env server.js
pause
