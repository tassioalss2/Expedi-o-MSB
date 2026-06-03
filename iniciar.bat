@echo off
echo.
echo  ======================================
echo   ACE-MSB — Iniciando o sistema...
echo  ======================================
echo.

:: Backend
echo  [1/2] Iniciando Backend (API)...
start "ACE-MSB Backend" cmd /k "cd /d "%~dp0backend" && venv\Scripts\activate && uvicorn main:app --port 8000"

:: Aguarda 3 segundos para o backend subir
timeout /t 3 /nobreak >nul

:: Frontend
echo  [2/2] Iniciando Frontend (App)...
start "ACE-MSB Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

:: Aguarda mais 4 segundos e abre o navegador
timeout /t 4 /nobreak >nul
echo.
echo  Abrindo o aplicativo no navegador...
start http://localhost:5173

echo.
echo  ======================================
echo   ACE-MSB rodando!
echo   App: http://localhost:5173
echo   API: http://localhost:8000
echo  ======================================
echo.
