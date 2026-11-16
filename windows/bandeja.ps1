# Bandeja do Amigos Share · Stremio: mostra se o serviço do Windows está no ar e dá o menu para
# abrir o painel, iniciar, reiniciar e parar. Roda por usuário (iniciada no login), oculta e só
# fala com 127.0.0.1. Não lê credencial, passkey nem token, e não baixa nem executa nada de fora.
param([switch]$SomenteEstado)
$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$servico = 'AscStremio'
$dados = Join-Path $env:ProgramData 'AscStremio\data'
$env:DATA_DIR = $dados

. (Join-Path $aqui 'bandeja-estado.ps1')
$portaPonte = Obter-Porta 'ponte'
$portaPainel = Obter-Porta 'painel'

# Modo de teste (CI): imprime online, iniciando, parado ou ausente e sai, sem criar ícone nem janela.
if ($SomenteEstado) { Write-Output (Obter-Estado); exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Uma só bandeja por usuário: um segundo atalho só termina em silêncio.
$criou = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\AscStremioBandeja', [ref]$criou)
if (-not $criou) { exit 0 }

# Ícones desenhados em código (círculo colorido): sem arquivo binário no pacote.
function Novo-Icone([System.Drawing.Color]$cor) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $pincel = New-Object System.Drawing.SolidBrush $cor
    $g.FillEllipse($pincel, 1, 1, 13, 13)
    $g.Dispose(); $pincel.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icones = @{
    'online'    = Novo-Icone ([System.Drawing.Color]::FromArgb(46, 160, 67))
    'iniciando' = Novo-Icone ([System.Drawing.Color]::FromArgb(219, 158, 0))
    'parado'    = Novo-Icone ([System.Drawing.Color]::FromArgb(207, 34, 46))
    'ausente'   = Novo-Icone ([System.Drawing.Color]::FromArgb(130, 130, 130))
}
$textos = @{
    'online'    = 'online'
    'iniciando' = 'iniciando…'
    'parado'    = 'parado'
    'ausente'   = 'serviço não instalado'
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icones['iniciando']
$tray.Text = 'Amigos Share · Stremio'
$tray.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu

function Avisar([string]$mensagem) {
    $tray.BalloonTipTitle = 'Amigos Share · Stremio'
    $tray.BalloonTipText = $mensagem
    $tray.ShowBalloonTip(4000)
}

function Abrir-Painel {
    $script:portaPainel = Obter-Porta 'painel'
    Start-Process "http://127.0.0.1:$($script:portaPainel)/"
}

# Controlar o serviço sem UAC depende do direito concedido pelo instalador; sem ele, avisa.
function Controlar([string]$acao) {
    $anterior = [System.Windows.Forms.Cursor]::Current
    [System.Windows.Forms.Cursor]::Current = [System.Windows.Forms.Cursors]::WaitCursor
    try {
        switch ($acao) {
            'iniciar'   { Start-Service -Name $servico }
            'parar'     { Stop-Service -Name $servico -Force }
            'reiniciar' { Restart-Service -Name $servico -Force }
        }
    } catch {
        Avisar 'Não foi possível controlar o serviço. Reinstale ou use o aplicativo Serviços do Windows.'
    } finally {
        [System.Windows.Forms.Cursor]::Current = $anterior
    }
    Atualizar
}

function Abrir-Logs {
    $log = Join-Path $dados 'AscStremioServico.out.log'
    if (Test-Path $log) { Start-Process notepad.exe -ArgumentList "`"$log`"" } else { Start-Process explorer.exe -ArgumentList "`"$dados`"" }
}

$itemPainel = $menu.Items.Add('Abrir painel')
$itemPainel.Font = New-Object System.Drawing.Font($itemPainel.Font, [System.Drawing.FontStyle]::Bold)
$itemPainel.add_Click({ Abrir-Painel })
$null = $menu.Items.Add('-')
$itemIniciar = $menu.Items.Add('Iniciar')
$itemIniciar.add_Click({ Controlar 'iniciar' })
$itemReiniciar = $menu.Items.Add('Reiniciar')
$itemReiniciar.add_Click({ Controlar 'reiniciar' })
$itemParar = $menu.Items.Add('Parar')
$itemParar.add_Click({ Controlar 'parar' })
$null = $menu.Items.Add('-')
$itemLogs = $menu.Items.Add('Ver logs')
$itemLogs.add_Click({ Abrir-Logs })
$itemDados = $menu.Items.Add('Pasta de dados')
$itemDados.add_Click({ Start-Process explorer.exe -ArgumentList "`"$dados`"" })
$null = $menu.Items.Add('-')
# Sair fecha só o ícone: o serviço continua rodando (e semeando).
$itemSair = $menu.Items.Add('Sair da bandeja')
$itemSair.add_Click({
    $timer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$tray.add_DoubleClick({ Abrir-Painel })

$script:ultimo = $null
function Atualizar {
    $estado = Obter-Estado
    $tray.Icon = $icones[$estado]
    $tray.Text = "Amigos Share · Stremio: $($textos[$estado])"
    $itemIniciar.Enabled = ($estado -eq 'parado')
    $itemParar.Enabled = ($estado -eq 'online' -or $estado -eq 'iniciando')
    $itemReiniciar.Enabled = ($estado -ne 'ausente')
    $itemPainel.Enabled = ($estado -eq 'online')
    # Avisa só quando o serviço cai (online → parado), não a cada leitura.
    if ($script:ultimo -eq 'online' -and $estado -eq 'parado') { Avisar 'O serviço parou. Use "Iniciar" no menu da bandeja.' }
    $script:ultimo = $estado
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ Atualizar })
$timer.Start()
Atualizar
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
