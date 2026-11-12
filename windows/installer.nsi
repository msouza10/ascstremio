; Instalador do Amigos Share · Stremio para Windows (NSIS). Por usuário, sem administrador.
; Compilado por windows/build.sh:  makensis -DVERSION=.. -DSTAGE=.. -DOUTFILE=.. installer.nsi
Unicode true
!include "MUI2.nsh"

Name "Amigos Share · Stremio"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\AscStremio"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\open-panel.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Iniciar e abrir o painel de login"
; Segunda caixa da última página: abre o console da primeira credencial. No modo silencioso (/S)
; a página não aparece, então o CI e instalações automáticas nunca emitem nem mostram token.
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Obter a URL do addon para o Stremio (mostrada uma única vez)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION AbrirCredenciais
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

Function AbrirCredenciais
  Exec 'cmd.exe /c ""$INSTDIR\credenciais.cmd""'
FunctionEnd

Section "Instalar"
  ; Atualização: encerra a versão em execução antes de trocar os arquivos.
  ExecWait '"$INSTDIR\stop.cmd"'
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  CreateDirectory "$SMPROGRAMS\Amigos Share Stremio"
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Abrir painel.lnk" "$INSTDIR\open-panel.cmd" "" "$INSTDIR\node\node.exe"
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Parar servico.lnk" "$INSTDIR\stop.cmd"
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Obter URL do addon.lnk" "cmd.exe" '/c ""$INSTDIR\credenciais.cmd""'
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Configuração.lnk" "cmd.exe" '/k ""$INSTDIR\configurar.cmd""'
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Pasta de dados.lnk" "$LOCALAPPDATA\AscStremio\data"
  ; Inicia sozinho ao entrar no Windows (precisa semear por 72 h).
  CreateShortcut "$SMSTARTUP\Amigos Share Stremio.lnk" "wscript.exe" '"$INSTDIR\launcher.vbs"'
  CreateDirectory "$LOCALAPPDATA\AscStremio\data"
  WriteUninstaller "$INSTDIR\desinstalar.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "DisplayName" "Amigos Share · Stremio"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "UninstallString" '"$INSTDIR\desinstalar.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "NoModify" 1
SectionEnd

Section "Uninstall"
  ExecWait '"$INSTDIR\stop.cmd"'
  Delete "$SMSTARTUP\Amigos Share Stremio.lnk"
  RMDir /r "$SMPROGRAMS\Amigos Share Stremio"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio"
  ; Passkey, sessão e cofre de seed em %LOCALAPPDATA%\AscStremio ficam de propósito.
  MessageBox MB_OK "Seus dados (passkey, sessão e cofre de seed) foram mantidos em $LOCALAPPDATA\AscStremio. Apague essa pasta se quiser removê-los." /SD IDOK
SectionEnd
