@echo off
title MSB Print Agent
echo.
echo =====================================================
echo   MSB Print Agent — Instalacao e Inicializacao
echo =====================================================
echo.

:: Verifica Python
python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  ERRO: Python nao encontrado!
    echo  Instale em: https://www.python.org/downloads/
    echo  Marque a opcao "Add Python to PATH" durante a instalacao.
    pause
    exit /b 1
)

echo  Instalando dependencias...
pip install pywin32 --quiet

echo  Iniciando agente...
echo.
python print_agent.py
pause
