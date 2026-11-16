@echo off
rem Garante que o serviço do Windows (AscStremio) está iniciado. Não precisa de administrador:
rem o instalador concede ao usuário o direito de iniciar e parar só este serviço.
sc query AscStremio | find "RUNNING" >nul && exit /b 0
sc start AscStremio >nul
exit /b %ERRORLEVEL%
