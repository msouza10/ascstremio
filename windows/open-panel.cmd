@echo off
rem Garante que o serviço está de pé e abre o painel de login.
wscript "%~dp0launcher.vbs"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:7020/"
