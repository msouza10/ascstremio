@echo off
rem Para o serviço do Windows (AscStremio). O cofre de seed é gravado a cada minuto, então a
rem parada perde no máximo ~1 min de contagem. O serviço sobe de novo no próximo boot ou por start.cmd.
sc stop AscStremio
exit /b %ERRORLEVEL%
