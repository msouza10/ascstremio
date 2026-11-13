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

**Faça o [backup](#backup-e-restauração) dos dados antes de atualizar.** Quem vem de uma versão anterior à 0.2.0 precisa emitir uma credencial (`credenciais garantir`) e reinstalar o addon no Stremio com a URL nova: a chave única antiga (`bridge-key`) deixou de valer. Os dados e o seed não são afetados. Depois de atualizar, confirme a versão e o estado do serviço no painel e nos logs.

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

Desinstalar o serviço Linux ou o programa Windows preserva os dados (passo a passo em [instalação](instalacao.md#desinstalar)). A exclusão definitiva deve considerar seed pendente e revogação das credenciais, além de backups existentes.

## Retenção por orçamento

Opcional e desligada por padrão (`RETENTION_MODE=off`; chaves em [configuração](configuracao.md#retenção-por-orçamento-opcional)). Ela só roda **com o aplicativo em execução**: a ponte sabe quais filmes estão tocando e é quem fala com o tracker; com o aplicativo parado nada disso é conhecido, então não existe modo offline que apague arquivos. Escolha de segurança: não há remoção automática.

```bash
npm run retencao                         # prévia: lista candidatos, ordem, motivo e bytes estimados; não remove nada
npm run retencao -- --executar <plano>   # executa a lista da prévia (o plano vale 10 minutos e uma vez)
```

No contêiner, rode `node src/retencao-cli.js` dentro dele (`docker exec`). As mesmas operações existem na ponte, com o token administrativo: `GET /retention` (prévia) e `POST /retention/run?plan=<id>`.

Na execução, o aplicativo: (1) relê o tracker à força para cada candidato; se a sessão ou o tracker falhar, **cancela tudo** e nada é removido; (2) recalcula; (3) reconfere cada título imediatamente antes de remover e, se algo mudou (play, sessão, obrigação reaberta, tracker sem registro), o título sai da lista; (4) enquanto remove um título, tentativas de abri-lo recebem `503`; (5) encerra o torrent e apaga apenas os arquivos que o `.torrent` lista, um a um, dentro de `BRIDGE_STORE`, sem seguir symlink e sem tocar em link físico; arquivo em uso permanece e é reportado. O log registra cada remoção (título abreviado, hash curto, bytes), sem caminhos absolutos nem segredos. Pastas de título que ficam vazias são aparadas; o `.torrent` e o cofre permanecem.

Limites conhecidos: bytes da prévia são estimativas (blocos alocados); se o orçamento não é alcançável só com títulos elegíveis, a prévia informa a falta e **não oferece execução**; a retenção não remove órfãos, parciais de streaming nem títulos com obrigação aberta, de modo que um disco cheio por eles não é resolvido por ela.

## Medir stalls e seeks da reprodução

A ponte **só observa** a reprodução; ela não altera leitura antecipada, buffer nem timeouts. O snapshot da ponte traz o bloco `streaming` (JSON de `GET /api/monitor` do painel, com a sessão do ASC conectada; ainda não há tela própria) e cada resposta de vídeo encerrada gera uma linha `reprodução: resposta encerrada` no log (nível `info` quando houve stall, seek ou 504; `debug` nos demais).

| Campo | Significado |
|---|---|
| `firstByte` | tempo entre abrir a resposta e o primeiro trecho vindo do torrent (contagem, P50/P95 estimados por faixa, máximo, faixas em ms) |
| `stalls` | esperas de **dados do torrent** de pelo menos `thresholds.stallMs` (2 s) depois do primeiro byte; `abandoned` conta o stall em que o player fechou antes de os dados chegarem. A espera pelo próprio player (HTTP lento) **não** conta |
| `stalledNow` | respostas em stall neste instante |
| `kinds` | respostas `inicial` (primeira do arquivo), `continuo` (retoma a menos de 4 MiB de onde a anterior parou), `avanco` e `recuo` (seeks) |
| `timeouts504` | primeiros trechos que não chegaram em 60 s (resposta 504) |
| `outcomes` | `ok`, `fechado` (player fechou ou saltou), `504`, `erro` |
| `sessions` | até 8 sessões recentes (um número sequencial por arquivo, descartado após 30 min ocioso), com seeks, stalls e 504 de cada |

Só há números: nenhum infoHash, caminho, nome de arquivo, IP, credencial ou passkey vai ao snapshot nem ao log. Os contadores valem desde a partida do processo, não são persistidos e reiniciam junto com ele. O benchmark offline e o critério para propor ajustes estão em [desenvolvimento](desenvolvimento.md#medir-a-reprodução-benchmark-offline).

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
| Play retorna 504 | Primeiro trecho não chegou no prazo; pode haver peers indisponíveis ou falta de conectividade. Veja `streaming.timeouts504` e [Medir stalls e seeks](#medir-stalls-e-seeks-da-reprodução) |
| Vídeo trava no meio | `streaming.stalls` e as linhas `reprodução: resposta encerrada` dizem se foram esperas do torrent (swarm/peers) e se seguiram um seek; esperas do player não contam. Veja [Medir stalls e seeks](#medir-stalls-e-seeks-da-reprodução) |
| Vídeo sem áudio/imagem no player | Compatibilidade do contêiner/codec do cliente; o servidor não transcodifica |
| Play retorna 507/503 | Sem folga além da reserva de disco (507) ou espaço não medido (503); veja [Disco](configuracao.md#disco) e ajuste `DISK_RESERVE_GIB`/`DISK_RESERVE_PERCENT` ou libere espaço |
| Retomada lenta na partida | O painel mostra o custo por torrent (`resume`) e o log traz linhas `retomada: …`. A verificação de arquivos grandes lê o torrent inteiro do disco. A ordem é por prazo de seed (mais urgente primeiro). Se o disco for rápido e houver vários torrents grandes, teste `RESUME_CONCURRENCY` 2 e compare o tempo total e o atraso do laço de eventos antes de manter |
| Disco não foi liberado | Confirmação do tracker pendente, falha de sessão/rede ou `AFTER_SEED=stop/keep` |
| Conta ainda não lida | Aguarde a consulta e examine sessão/rede; ausência de dados não significa tudo em dia |
| Alertas não chegam | `npm run alertas -- estado` mostra destino, último envio e último erro (sem a URL). Confira o host em `ALERT_WEBHOOK_ALLOWED_HOSTS`, `ALERT_WEBHOOK_ALLOW_PRIVATE` para rede privada, e teste pelo painel |
| Seed para quando o PC suspende | Verifique `KEEP_AWAKE`, ferramenta do sistema e energia do host, especialmente em contêiner |

Para abrir uma issue, informe versão, sistema, Node (se execução manual), método de instalação e passos sem dados reais. Informe também se mudou LAN, portas ou diretórios. Nunca inclua senha, passkey, cookie, URL de instalação do addon (`/<credencial>/manifest.json`) ou URL de vídeo com `?k=`.
