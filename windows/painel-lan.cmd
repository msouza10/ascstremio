@echo off
rem Painel pela rede (LAN): deixa o painel abrir em OUTROS computadores da rede, protegido por senha.
rem   painel-lan.cmd                  menu
rem   painel-lan.cmd ligar [--ip IPV4] [--trocar]   modo LAN, senha gerada (mostrada uma vez) e firewall
rem   painel-lan.cmd desligar         fecha o acesso pela rede e remove a regra do painel
rem   painel-lan.cmd status           mostra a situacao
rem   painel-lan.cmd senha            gera outra senha de administracao (vale na hora)
rem Ligar e desligar mexem na configuracao: o servico e parado antes e SEMPRE iniciado depois.
rem A senha nunca vai por argumento nem para arquivo; nao e a senha do ASC.
setlocal
set "HERE=%~dp0"
if not defined DATA_DIR set "DATA_DIR=%ProgramData%\AscStremio\data"
set "NODE=%HERE%node\node.exe"
cd /d "%HERE%app"

set "ACAO=%~1"
if "%ACAO%"=="" goto :menu
set "RESTO="
for /f "tokens=1*" %%A in ("%*") do set "RESTO=%%B"
if /i "%ACAO%"=="ligar" goto :ligar
if /i "%ACAO%"=="desligar" goto :desligar
if /i "%ACAO%"=="status" goto :status
if /i "%ACAO%"=="senha" goto :senha
echo uso: painel-lan.cmd [ligar [--ip IPV4] [--trocar] ^| desligar ^| status ^| senha]
exit /b 2

:menu
echo.
echo  Painel pela rede (outros computadores da rede abrem o painel com senha)
echo    1) Ligar
echo    2) Desligar
echo    3) Ver situacao
echo    4) Gerar outra senha
echo    0) Sair
set "OP="
set /p "OP=Escolha: "
if "%OP%"=="1" goto :ligar
if "%OP%"=="2" goto :desligar
if "%OP%"=="3" goto :status
if "%OP%"=="4" goto :senha
exit /b 0

:ligar
call :parar || exit /b 1
"%NODE%" "%HERE%app\src\admin-cli.js" assistente %RESTO%
set "RC=%ERRORLEVEL%"
sc start AscStremio >nul
if "%RC%"=="0" call "%HERE%firewall-lan.cmd" liberar painel
exit /b %RC%

:desligar
call :parar || exit /b 1
"%NODE%" "%HERE%app\src\admin-cli.js" desativar --sim
set "RC=%ERRORLEVEL%"
sc start AscStremio >nul
if "%RC%"=="0" call "%HERE%firewall-lan.cmd" remover painel
if "%RC%"=="0" echo O modo LAN do addon continua; para voltar ao modo local use configurar.cmd (modo local).
exit /b %RC%

:status
"%NODE%" "%HERE%app\src\admin-cli.js" status
exit /b %ERRORLEVEL%

:senha
"%NODE%" "%HERE%app\src\admin-cli.js" gerar --trocar
exit /b %ERRORLEVEL%

:parar
sc query AscStremio | find "STOPPED" >nul && exit /b 0
sc stop AscStremio >nul
for /l %%I in (1,1,30) do (
  sc query AscStremio | find "STOPPED" >nul && exit /b 0
  timeout /t 1 /nobreak >nul
)
echo Nao foi possivel parar o servico.
exit /b 1
