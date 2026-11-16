@echo off
rem Garante o serviço de pé e a bandeja ativa (instância única) e abre o painel de login.
setlocal
set "HERE=%~dp0"
if not defined DATA_DIR set "DATA_DIR=%ProgramData%\AscStremio\data"
call "%HERE%start.cmd"
wscript "%HERE%bandeja.vbs"
rem Porta efetiva do painel, pela configuração central (ambiente > settings.json > padrão).
set "PORTA_PAINEL=7020"
pushd "%HERE%app"
for /f "delims=" %%P in ('""%HERE%node\node.exe" src\credenciais-cli.js porta painel"') do set "PORTA_PAINEL=%%P"
popd
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:%PORTA_PAINEL%/"
