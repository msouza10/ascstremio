@echo off
rem Encerra só a bandeja (o serviço continua). O instalador usa antes de trocar os arquivos.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*bandeja.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
exit /b 0
