@echo off
rem Regras de entrada do Firewall do Windows para o modo LAN. Pede administrador sozinho.
rem   firewall-lan.cmd liberar          libera o addon e a ponte (so TCP, so rede privada e sub-rede local)
rem   firewall-lan.cmd liberar painel   o mesmo, mais o painel (use so com a administracao pela LAN ligada)
rem   firewall-lan.cmd remover          apaga as duas regras
rem   firewall-lan.cmd remover painel   apaga so a regra do painel
rem A regra vale so para o node.exe deste pacote; nunca para qualquer origem nem para rede publica.
setlocal
set "HERE=%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "$p = Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
  exit /b %ERRORLEVEL%
)
if not defined DATA_DIR set "DATA_DIR=%ProgramData%\AscStremio\data"
set "NODE=%HERE%node\node.exe"
set "R_BASE=Amigos Share Stremio (LAN)"
set "R_PAINEL=Amigos Share Stremio (painel LAN)"
set "P_ADDON=7000"
set "P_PONTE=7010"
set "P_PAINEL=7020"
rem Portas efetivas (ambiente > settings.json > padrao), pela mesma CLI dos atalhos.
pushd "%HERE%app"
for /f "delims=" %%P in ('""%NODE%" src\credenciais-cli.js porta addon"') do set "P_ADDON=%%P"
for /f "delims=" %%P in ('""%NODE%" src\credenciais-cli.js porta"') do set "P_PONTE=%%P"
for /f "delims=" %%P in ('""%NODE%" src\credenciais-cli.js porta painel"') do set "P_PAINEL=%%P"
popd
if /i "%~1"=="liberar" goto :liberar
if /i "%~1"=="remover" goto :remover
echo uso: firewall-lan.cmd liberar [painel] ^| remover [painel]
exit /b 2

:liberar
if /i not "%~2"=="painel" (
  netsh advfirewall firewall delete rule name="%R_BASE%" >nul 2>&1
  netsh advfirewall firewall add rule name="%R_BASE%" dir=in action=allow protocol=TCP localport=%P_ADDON%,%P_PONTE% program="%NODE%" remoteip=LocalSubnet profile=private,domain enable=yes >nul
  if errorlevel 1 exit /b 1
)
if /i "%~2"=="painel" (
  netsh advfirewall firewall delete rule name="%R_BASE%" >nul 2>&1
  netsh advfirewall firewall add rule name="%R_BASE%" dir=in action=allow protocol=TCP localport=%P_ADDON%,%P_PONTE% program="%NODE%" remoteip=LocalSubnet profile=private,domain enable=yes >nul
  if errorlevel 1 exit /b 1
  netsh advfirewall firewall delete rule name="%R_PAINEL%" >nul 2>&1
  netsh advfirewall firewall add rule name="%R_PAINEL%" dir=in action=allow protocol=TCP localport=%P_PAINEL% program="%NODE%" remoteip=LocalSubnet profile=private,domain enable=yes >nul
  if errorlevel 1 exit /b 1
)
echo Firewall: regra de entrada criada para a rede local.
exit /b 0

:remover
netsh advfirewall firewall delete rule name="%R_PAINEL%" >nul 2>&1
if /i not "%~2"=="painel" netsh advfirewall firewall delete rule name="%R_BASE%" >nul 2>&1
echo Firewall: regra removida.
exit /b 0
