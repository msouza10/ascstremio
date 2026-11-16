; Instalador do Amigos Share · Stremio para Windows (NSIS). Instala um SERVIÇO do Windows (WinSW)
; que sobe no boot e uma bandeja por usuário. Pede administrador (UAC), porque criar serviço exige.
; Compilado por windows/build.sh:  makensis -DVERSION=.. -DSTAGE=.. -DOUTFILE=.. installer.nsi
Unicode true
!include "MUI2.nsh"

Name "Amigos Share · Stremio"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\AscStremio"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\open-panel.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o painel de login"
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
  SetRegView 64
  SetShellVarContext all
  ReadEnvStr $R9 ProgramData
  ; %LOCALAPPDATA% do usuário que instalou, lido do ambiente: a variável interna do NSIS muda com o contexto "all".
  ReadEnvStr $R5 LOCALAPPDATA

  ; Atualização: encerra a bandeja e o serviço da versão em execução antes de trocar os arquivos.
  IfFileExists "$INSTDIR\AscStremioServico.exe" 0 semservicoanterior
    ExecWait '"$INSTDIR\parar-bandeja.cmd"'
    nsExec::ExecToLog '"$INSTDIR\AscStremioServico.exe" stop'
    Pop $0
    nsExec::ExecToLog '"$INSTDIR\AscStremioServico.exe" uninstall'
    Pop $0
  semservicoanterior:

  ; Modelo antigo (por usuário, sem serviço): para o processo, tira atalhos e arquivos antigos.
  ; Os dados em %LOCALAPPDATA%\AscStremio\data NÃO são apagados aqui: são movidos mais abaixo.
  IfFileExists "$R5\Programs\AscStremio\stop.cmd" 0 semmodeloantigo
    ExecWait '"$R5\Programs\AscStremio\stop.cmd"'
    SetShellVarContext current
    Delete "$SMSTARTUP\Amigos Share Stremio.lnk"
    RMDir /r "$SMPROGRAMS\Amigos Share Stremio"
    SetShellVarContext all
    RMDir /r "$R5\Programs\AscStremio"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio"
  semmodeloantigo:

  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"

  ; Dados do serviço em %ProgramData%\AscStremio\data (o serviço sobe no boot, sem ninguém logado).
  CreateDirectory "$R9\AscStremio"
  StrCpy $R6 0
  IfFileExists "$R9\AscStremio\data\*.*" dadosprontos 0
    IfFileExists "$R5\AscStremio\data\*.*" 0 dadossemorigem
      ; Move (mesmo volume: instantâneo), nunca copia dezenas de GB nem sobrescreve o destino.
      ClearErrors
      Rename "$R5\AscStremio\data" "$R9\AscStremio\data"
      IfErrors 0 dadosmovidos
        ; Plano B: o move do cmd também só renomeia (mesmo volume), sem copiar.
        nsExec::ExecToLog 'cmd.exe /c move "$R5\AscStremio\data" "$R9\AscStremio\data"'
        Pop $0
        IfFileExists "$R9\AscStremio\data\*.*" dadosmovidos 0
        DetailPrint "Não foi possível mover os dados antigos; seguem em $R5\AscStremio\data."
        Goto dadossemorigem
      dadosmovidos:
      StrCpy $R6 1
    dadossemorigem:
    CreateDirectory "$R9\AscStremio\data"
  dadosprontos:

  ; Passkey, sessão e cofre ficam legíveis só por SYSTEM, administradores, LocalService (o serviço)
  ; e por quem instalou; sem herdar o acesso amplo do ProgramData.
  ReadEnvStr $R7 USERNAME
  ReadEnvStr $R8 USERDOMAIN
  StrCmp $R6 1 0 aclsemrecursao
    nsExec::ExecToLog 'icacls "$R9\AscStremio" /inheritance:r /T /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)F" "$R8\$R7:(OI)(CI)M"'
    Pop $0
    Goto aclfeita
  aclsemrecursao:
    nsExec::ExecToLog 'icacls "$R9\AscStremio" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)F" "$R8\$R7:(OI)(CI)M"'
    Pop $0
  aclfeita:

  nsExec::ExecToLog '"$INSTDIR\AscStremioServico.exe" install'
  Pop $0
  StrCmp $0 0 servicoinstalado
    MessageBox MB_OK|MB_ICONSTOP "Não foi possível instalar o serviço do Windows (código $0). Veja o log desta instalação." /SD IDOK
    Abort
  servicoinstalado:
  ; Usuário comum inicia, para e consulta só este serviço (a bandeja reinicia sem pedir UAC).
  nsExec::ExecToLog 'sc sdset AscStremio "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPDTLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"'
  Pop $0
  nsExec::ExecToLog 'sc start AscStremio'
  Pop $0

  CreateDirectory "$SMPROGRAMS\Amigos Share Stremio"
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Abrir painel.lnk" "$INSTDIR\open-panel.cmd" "" "$INSTDIR\node\node.exe"
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Bandeja.lnk" "wscript.exe" '"$INSTDIR\bandeja.vbs"'
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Obter URL do addon.lnk" "cmd.exe" '/c ""$INSTDIR\credenciais.cmd""'
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Configuração.lnk" "cmd.exe" '/k ""$INSTDIR\configurar.cmd""'
  CreateShortcut "$SMPROGRAMS\Amigos Share Stremio\Pasta de dados.lnk" "$R9\AscStremio\data"
  ; A bandeja abre sozinha ao entrar no Windows; o serviço já sobe no boot por conta própria.
  CreateShortcut "$SMSTARTUP\Amigos Share Stremio.lnk" "wscript.exe" '"$INSTDIR\bandeja.vbs"'
  Exec 'wscript.exe "$INSTDIR\bandeja.vbs"'

  WriteUninstaller "$INSTDIR\desinstalar.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "DisplayName" "Amigos Share · Stremio"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "UninstallString" '"$INSTDIR\desinstalar.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio" "NoModify" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all
  ReadEnvStr $R9 ProgramData
  ExecWait '"$INSTDIR\parar-bandeja.cmd"'
  nsExec::ExecToLog '"$INSTDIR\AscStremioServico.exe" stop'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\AscStremioServico.exe" uninstall'
  Pop $0
  Delete "$SMSTARTUP\Amigos Share Stremio.lnk"
  RMDir /r "$SMPROGRAMS\Amigos Share Stremio"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AscStremio"
  ; Passkey, sessão e cofre de seed em %ProgramData%\AscStremio ficam de propósito.
  MessageBox MB_OK "O serviço foi removido. Seus dados (passkey, sessão e cofre de seed) foram mantidos em $R9\AscStremio. Apague essa pasta se quiser removê-los." /SD IDOK
SectionEnd
