@echo off
rem Inicia o Amigos Share · Stremio (dados em %LOCALAPPDATA%\AscStremio).
setlocal
set "HERE=%~dp0"
if not defined DATA_DIR set "DATA_DIR=%LOCALAPPDATA%\AscStremio\data"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
rem Já está rodando? (a porta do painel responde)
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:7010/health)|Out-Null;exit 0}catch{exit 1}" && exit /b 0
cd /d "%HERE%app"
"%HERE%node\node.exe" --max-http-header-size=65536 src\index.js >> "%DATA_DIR%\service.log" 2>&1
