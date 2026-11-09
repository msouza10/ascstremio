@echo off
rem Encerra o serviço. No Windows não há desligamento "limpo": o cofre de seed é gravado
rem a cada minuto, então perde-se no máximo ~1 min de contagem.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.ExecutablePath -like '%~dp0node\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Servico encerrado.
