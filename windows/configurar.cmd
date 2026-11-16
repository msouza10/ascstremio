@echo off
rem Configuração no terminal (listar, definir, validar, recuperar; sem argumentos: modo guiado).
rem Para alterar, pare o serviço antes (stop.cmd) e inicie de novo depois (start.cmd); consultar funciona com ele ligado.
setlocal
set "HERE=%~dp0"
if not defined DATA_DIR set "DATA_DIR=%ProgramData%\AscStremio\data"
cd /d "%HERE%app"
"%HERE%node\node.exe" src\configurar-cli.js %*
exit /b %ERRORLEVEL%
