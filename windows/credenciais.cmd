@echo off
rem Credenciais de instalação do addon (veja docs/seguranca.md). Sem argumentos, emite a primeira
rem ("garantir": só cria se não houver nenhuma ativa) e mostra a URL do Stremio UMA vez, nesta janela.
rem O token nunca vai para log nem arquivo: esta saída não é redirecionada. Com argumentos, repassa
rem à CLI (listar, criar "Nome", rotacionar, revogar). ASC_SEM_PAUSA=1 dispensa o "pause" (testes).
setlocal
set "HERE=%~dp0"
if not defined DATA_DIR set "DATA_DIR=%LOCALAPPDATA%\AscStremio\data"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
rem Porta efetiva da ponte, pela configuração central (ambiente > settings.json > padrão). Não se
rem exporta padrão para o ambiente: ele venceria o settings.json e a CLI olharia a porta errada.
set "PORTA="
pushd "%HERE%app"
for /f "delims=" %%P in ('""%HERE%node\node.exe" src\credenciais-cli.js porta"') do set "PORTA=%%P"
popd
if not defined PORTA set "PORTA=7010"
rem A CLI fala com a ponte: garante que o serviço está de pé e espera ela responder.
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%PORTA%/health)|Out-Null;exit 0}catch{exit 1}" || wscript "%HERE%launcher.vbs"
powershell -NoProfile -Command "foreach($i in 1..60){try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%PORTA%/health)|Out-Null;exit 0}catch{Start-Sleep 1}};exit 1"
if errorlevel 1 (
  echo A ponte nao respondeu. Veja %DATA_DIR%\service.log e tente de novo.
  set "RC=1"
  goto :fim
)
cd /d "%HERE%app"
if "%~1"=="" (
  "%HERE%node\node.exe" src\credenciais-cli.js garantir
) else (
  "%HERE%node\node.exe" src\credenciais-cli.js %*
)
set "RC=%ERRORLEVEL%"
:fim
echo.
echo Se uma URL apareceu acima, copie-a agora para o Stremio: ela nao sera mostrada de novo.
if not defined ASC_SEM_PAUSA pause
exit /b %RC%
