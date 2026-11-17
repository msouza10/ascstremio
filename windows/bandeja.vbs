' Abre a bandeja (bandeja.ps1) sem janela de console. Uso: wscript bandeja.vbs
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\bandeja.ps1""", 0, False
