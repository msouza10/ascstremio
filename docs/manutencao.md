# Manutenção e diagnóstico

Antes de atualizar ou mover uma instalação, identifique o `DATA_DIR` e verifique as pendências no painel. Parar o aplicativo interrompe o seed, mas não suspende prazos do tracker.

## Atualizar e reiniciar

| Instalação | Procedimento |
|---|---|
| Pelo código | Pare a instância; atualize o código para a revisão desejada; execute `npm ci` e `npm run check`; inicie pelo mesmo método e com o mesmo `DATA_DIR` |
| Instalador remoto Linux | Execute novamente o instalador da distribuição confiável; o código é substituído, os dados ficam separados |
| Serviço Linux pelo código | Atualize dependências/verificações e execute `systemctl --user restart ascstremio` |
| Compose com imagem GHCR | `docker compose pull` e `docker compose up -d`; preserve o volume. Se fixou uma tag, altere-a para a versão desejada |
| Compose com build local | `docker compose up -d --build`; preserve o volume |
| `scripts/docker.sh` | Pare com `scripts/docker.sh stop`, execute `scripts/docker.sh build` e depois `scripts/docker.sh run`; preserve o volume |
| Windows | Pare pelo atalho e execute o instalador da versão desejada; os dados ficam fora da pasta do programa |

`scripts/docker.sh run` reutiliza a imagem `latest` existente e recria o contêiner. Use `build` explicitamente para incorporar código novo. Não use `docker compose down -v` para uma atualização: `-v` remove os volumes.

No serviço Linux, alterar `service.env` exige reiniciar. O serviço tenta iniciar mesmo sem rede e o monitor volta a consultar o ASC depois. Verifique logs e status; processo ativo não significa sessão válida ou tracker acessível.

## Uma instância por instalação

Ao iniciar, o programa cria o arquivo `.ascstremio.lock` em `DATA_DIR` (e em `ASC_TORRENT_DIR` e `BRIDGE_STORE` quando ficam fora dela) e o remove ao encerrar. Uma segunda instância na mesma pasta recusa a partida, mesmo com portas diferentes, porque dois processos gravando o cofre de seed perderiam atualizações. Caminhos equivalentes por symlink ou `..` contam como a mesma pasta. Também são recusados: `ASC_TORRENT_DIR` e `BRIDGE_STORE` sobrepostos, `DATA_DIR` dentro de um deles, e armazenamento externo já usado por outro `DATA_DIR`.

- **Parada limpa ou queda no mesmo computador:** se o processo dono da trava não existe mais, a próxima partida a recupera sozinha. Se o PID continua vivo, a partida é recusada (o sistema pode ter reaproveitado o PID após uma queda).
- **Outra máquina, contêiner recriado ou arquivo ilegível:** não há como provar que o dono morreu, então a partida é recusada e a mensagem informa o arquivo. Confirme que nenhuma instância usa a pasta e apague o `.ascstremio.lock` indicado. Em contêiner recriado após queda o nome do host muda; reiniciar o mesmo contêiner é reconhecido normalmente.
- **Limites:** a trava confia em `open` exclusivo e no PID/host do sistema. Em compartilhamento de rede (NFS, SMB) ou volume sincronizado, a exclusividade não é garantida entre máquinas; nunca use a mesma pasta de dados em dois computadores. Uma pasta de armazenamento externa que contém a de outra instalação já em execução (aninhamento inverso) não é detectada.
- A configuração pelo painel roda no mesmo processo e herda a trava. A [configuração pelo terminal](configuracao.md#configuração-pelo-terminal) adquire a mesma trava antes de gravar e recusa a alteração se o aplicativo estiver ativo; outras ferramentas que gravem no `DATA_DIR` devem fazer o mesmo.

## Backup e restauração

1. Verifique as pendências e pare a instância para obter um conjunto consistente.
2. Copie toda a pasta de dados, incluindo arquivos ocultos quando existirem. Se `ASC_TORRENT_DIR` ou `BRIDGE_STORE` apontarem para fora dela, copie esses caminhos também.
3. Proteja o backup como credencial: ele contém sessão, passkey e verificadores das credenciais de reprodução. Não o envie ao GitHub.
4. Restaure com a aplicação parada, em uma única instância, preservando permissões e caminhos configurados.
5. Inicie e confirme sessão, arquivos locais, pendências e conciliação com o tracker no painel.

O cache pode ser grande, mas restaurar apenas o cofre não restaura os dados necessários para semear. No Docker, copie o conteúdo do volume correto; os nomes de Compose e `docker.sh` podem ser diferentes. Restaurar contadores antigos nunca substitui a leitura do tracker.

Desinstalar o serviço Linux ou o programa Windows preserva os dados. A exclusão definitiva deve considerar seed pendente e revogação das credenciais, além de backups existentes.

## Logs

Abra **http://127.0.0.1:7020/logs** mesmo quando o login no ASC estiver falhando. É possível filtrar por nível, fonte, período e texto, acompanhar novas entradas e exportar texto/NDJSON ou arquivos diários.

O buffer guarda até 5000 entradas; os arquivos ficam em `DATA_DIR/logs/ascstremio-AAAA-MM-DD.log`, com retenção padrão de 14 dias. Depois do limite diário de 20 MB, apenas avisos e erros continuam sendo gravados. O nível mínimo padrão é `debug`. A saída do processo e os arquivos do logger têm filtros próprios.

| Instalação | Saída do processo |
|---|---|
| Manual | Terminal de `npm start` |
| Serviço Linux | `journalctl --user -u ascstremio -f` |
| Docker/Podman pelo script | `scripts/docker.sh logs` |
| Compose | `docker compose logs --tail 100 -f` |
| Windows | `%LOCALAPPDATA%\AscStremio\data\service.log` |

A redação automática não remove necessariamente dados pessoais, títulos ou identificadores. Revise antes de compartilhar.

## Diagnóstico

| Sintoma | O que conferir |
|---|---|
| `EADDRINUSE` ou porta ocupada | Outra instância/serviço nas mesmas portas; pare-a ou use portas e dados separados |
| Painel responde 403 | Use `127.0.0.1`, não `localhost`, nome do NAS ou IP LAN; mantenha a porta externa igual à interna no contêiner |
| POST do painel responde 403 | Reabra a página após reiniciar; token antigo, Origin ou tipo JSON incorretos são recusados |
| Sem fontes ASC | Sessão confirmada, filme compatível, filtro freeleech e disponibilidade da busca; consulte os logs |
| Catálogo de status não aparece | `STATUS_CATALOG`, credencial emitida sem `--status` e manifesto guardado pelo Stremio; remova e reinstale o addon |
| Addon ou vídeo dão 403 depois de atualizar | A chave única antiga `bridge-key` não vale mais; emita uma credencial (`credenciais garantir`) e reinstale o addon com a URL nova |
| `UND_ERR_HEADERS_OVERFLOW` | Execute por `npm start` ou com a opção de cabeçalhos prevista no launcher; não use `node src/index.js` isoladamente |
| Torrent sem peers | Passkey carregada, peers disponíveis, rede e acesso ao tracker; login no site não substitui passkey |
| Play retorna 409 | Filtro freeleech ou política de seed, conforme a rota e a mensagem |
| Play retorna 422 | Release sem vídeo principal elegível ou imagem de disco |
| Play retorna 503 | Ausência de seeders na fonte online, antes de criar download |
| Play retorna 504 | Primeiro trecho não chegou no prazo; pode haver peers indisponíveis ou falta de conectividade |
| Vídeo sem áudio/imagem no player | Compatibilidade do contêiner/codec do cliente; o servidor não transcodifica |
| Play retorna 507/503 | Sem folga além da reserva de disco (507) ou espaço não medido (503); veja [Disco](configuracao.md#disco) e ajuste `DISK_RESERVE_GIB`/`DISK_RESERVE_PERCENT` ou libere espaço |
| Retomada lenta na partida | O painel mostra o custo por torrent (`resume`) e o log traz linhas `retomada: …`. A verificação de arquivos grandes lê o torrent inteiro do disco. A ordem é por prazo de seed (mais urgente primeiro). Se o disco for rápido e houver vários torrents grandes, teste `RESUME_CONCURRENCY` 2 e compare o tempo total e o atraso do laço de eventos antes de manter |
| Disco não foi liberado | Confirmação do tracker pendente, falha de sessão/rede ou `AFTER_SEED=stop/keep` |
| Conta ainda não lida | Aguarde a consulta e examine sessão/rede; ausência de dados não significa tudo em dia |
| Alertas não chegam | `npm run alertas -- estado` mostra destino, último envio e último erro (sem a URL). Confira o host em `ALERT_WEBHOOK_ALLOWED_HOSTS`, `ALERT_WEBHOOK_ALLOW_PRIVATE` para rede privada, e teste pelo painel |
| Seed para quando o PC suspende | Verifique `KEEP_AWAKE`, ferramenta do sistema e energia do host, especialmente em contêiner |

Para abrir uma issue, informe versão, sistema, Node (se execução manual), método de instalação e passos sem dados reais. Informe também se mudou LAN, portas ou diretórios. Nunca inclua senha, passkey, cookie, URL de instalação do addon (`/<credencial>/manifest.json`) ou URL de vídeo com `?k=`.
