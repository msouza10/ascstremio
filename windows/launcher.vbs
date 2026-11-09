' Inicia o serviço sem janela de console. Uso: wscript launcher.vbs
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & dir & "\start.cmd""", 0, False
