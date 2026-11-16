# Lógica de estado da bandeja (sem interface), carregada por bandeja.ps1. Fica separada para o CI
# conferir, no PowerShell 5.1 real, o mesmo código que a bandeja usa: bandeja.ps1 -SomenteEstado.
# Espera $aqui (pasta do pacote), $servico (nome do serviço) e $portaPonte (porta efetiva da ponte).

# Porta efetiva (ambiente > settings.json > padrão), pela mesma CLI que os atalhos usam.
function Obter-Porta([string]$qual) {
    $padrao = if ($qual -eq 'painel') { 7020 } else { 7010 }
    try {
        Push-Location (Join-Path $aqui 'app')
        $argumentos = @('src\credenciais-cli.js', 'porta')
        if ($qual -eq 'painel') { $argumentos += 'painel' }
        $saida = & (Join-Path $aqui 'node\node.exe') @argumentos 2>$null
        Pop-Location
        $n = 0
        if ([int]::TryParse([string]($saida | Select-Object -First 1), [ref]$n) -and $n -gt 0 -and $n -lt 65536) { return $n }
    } catch { try { Pop-Location } catch { } }
    return $padrao
}

function Saude-Ok {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$portaPonte/health")
        $req.Timeout = 1500
        $req.ReadWriteTimeout = 1500
        $resp = $req.GetResponse()
        $ok = ([int]$resp.StatusCode -eq 200)
        $resp.Close()
        return $ok
    } catch { return $false }
}

function Obter-Estado {
    $s = Get-Service -Name $servico -ErrorAction SilentlyContinue
    if (-not $s) { return 'ausente' }
    if ($s.Status -eq 'Running') { if (Saude-Ok) { return 'online' } else { return 'iniciando' } }
    if ($s.Status -eq 'StartPending' -or $s.Status -eq 'ContinuePending') { return 'iniciando' }
    return 'parado'
}
