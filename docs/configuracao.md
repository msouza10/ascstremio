# Configuração

As variáveis são lidas na inicialização. Reinicie a instância depois de alterar o ambiente. A aplicação não carrega `.env` automaticamente.

## Precedência e arquivo persistente

Cada opção vem de uma de três origens, da mais forte para a mais fraca:

1. **Ambiente** (shell, `service.env`, Compose): sempre vence e nunca é sobrescrito por outra origem.
2. **Arquivo `DATA_DIR/settings.json`** (modo `0600`, gravado de forma atômica, com `version` e `revision`): usado pelas interfaces de configuração (terminal, descrito abaixo, e painel). Não precisa existir e não é criado na partida; quem usa só variáveis de ambiente continua exatamente como antes.
3. **Padrão** do esquema (tabelas abaixo).

Regras que valem para qualquer origem:

- Variável vazia conta como ausente.
- Valor inválido, arquivo corrompido ou de versão mais nova, e combinação insegura **recusam a partida** com a lista de problemas; nada cai silenciosamente em padrão (`AFTER_SEED=delete` apaga arquivos).
- Segredos (`PASSKEY`, `ANNOUNCE_BASE`) e `DATA_DIR`, `PASSKEY_FILE`, `BRIDGE_ALLOW_LAN` e `ASCSTREMIO_CONTAINER` existem **só no ambiente**; o arquivo não os aceita e nenhuma leitura sanitizada os devolve. Senhas do ASC não são persistidas.
- Alterar uma opção que o ambiente define é recusado (a origem exibida é `env`); edite o `service.env`/Compose.
- Alterações exigem a revisão lida (`expectedRevision`); se outro processo gravou antes, a alteração é recusada e nada muda. Uma alteração inválida não toca o disco.
- Quase todas as opções só valem após reiniciar; `LOG_LEVEL` é a exceção. `ASC_TORRENT_DIR` e `BRIDGE_STORE` não movem arquivos já baixados.

### Modos local e LAN

`ASCSTREMIO_MODE` aceita `local` (padrão: addon e ponte escutam só em `127.0.0.1`) ou `lan` (escutam em todas as interfaces, para os outros aparelhos da mesma pessoa). Ele só escolhe a interface de escuta; não desliga nenhuma proteção (Host, chave `?k=`, token administrativo, painel local). `BRIDGE_ALLOW_LAN=1` continua valendo e equivale a `lan`. São recusados: `BRIDGE_ALLOW_LAN=1` com `ASCSTREMIO_MODE=local`, portas repetidas entre `PORT`, `BRIDGE_PORT`, `CONFIG_PORT` e `TORRENT_PORT`, `lan` em contêiner sem `BRIDGE_PUBLIC_URL` e `ADDON_PUBLIC_URL`, URLs com usuário/senha e `ALLOWED_HOSTS` com curinga ou porta. Voltar de `lan` para `local` não apaga seed nem dados.

- Execução manual: exporte as variáveis no terminal antes de `npm start`.
- Serviço Linux: edite `DATA_DIR/service.env`, uma variável por linha, e reinicie `ascstremio.service`.
- Compose: use `environment` no serviço; recrie o contêiner para aplicar mudanças. Um `.env` do Compose só interpola o YAML quando referenciado.
- `scripts/docker.sh run` repassa diretamente apenas `AFTER_SEED` e `LOG_LEVEL`, além dos padrões da imagem; outras opções exigem ajustar a invocação ou usar Compose.
- Windows: não há carregamento de `service.env` pelo launcher; configure o ambiente herdado pelo processo e reinicie-o.

## Configuração pelo terminal

Depois de instalar, a configuração também se consulta e se altera pelo terminal (no host ou por SSH), com a mesma validação da partida. Não é um terminal servido no navegador e não depende da sessão do ASC: serve para consertar rede e painel mesmo com a sessão expirada.

| Onde | Comando |
|---|---|
| Linux (código ou pacote) | `npm run configurar -- <comando>`; o instalador imprime a linha completa com `DATA_DIR` e o Node usado |
| Contêiner | `scripts/docker.sh configurar <comando>` |
| Windows | `configurar.cmd <comando>` na pasta de instalação (atalho "Configuração" no Menu Iniciar) |

Sem comando e em terminal interativo abre o **modo guiado** (ver todas as opções, trocar local/LAN, alterar, remover, diagnóstico e recuperação). Sem terminal (cron, `docker exec` sem `-t`, pipe) nada espera entrada: sem comando, ou `guiado`, falha com o uso.

| Comando | O que faz |
|---|---|
| `listar [--json] [--detalhes]` | Todas as opções com valor efetivo, **origem** (`ambiente`, `ambiente (service.env)`, `arquivo`, `padrão`) e se **exige reinício** |
| `obter CHAVE [--json]` | Uma opção, com descrição, valores aceitos e padrão |
| `definir CHAVE=VALOR... [--revisao N] [--json]` | Grava no `settings.json` (também `definir CHAVE VALOR`) |
| `remover CHAVE... [--revisao N]` | Tira do arquivo; volta ao ambiente ou padrão |
| `modo [local\|lan]` | Mostra ou troca o modo de uso |
| `validar [--json]` | Confere ambiente + arquivo; sai com 1 se houver problema |
| `diagnosticar [--json]` | Arquivo, `service.env`, instância ativa, problemas e como consertar |
| `recuperar [--sim]` | Renomeia (nunca apaga) um `settings.json` quebrado para `settings.json.quebrado-<data>` |

Regras:

- **Segredos nunca por argumento nem na saída.** `PASSKEY` e `ANNOUNCE_BASE` são recusadas (`definir PASSKEY=...` falha sem repetir o valor); aparecem só como "definido" ou "não definido". A passkey continua em `passkey.txt` ou no ambiente. Senhas do ASC não passam por aqui.
- **Escrita exige o aplicativo parado.** A CLI adquire a [trava da instância](manutencao.md#uma-instância-por-instalação) antes de gravar; com o serviço ligado a alteração é recusada (código 3) em vez de escrever por trás dele. Consultar (`listar`, `obter`, `validar`, `diagnosticar`) funciona com ele ligado. Fluxo: pare o serviço, altere, inicie. No contêiner: `scripts/docker.sh stop`, `scripts/docker.sh configurar ...`, `scripts/docker.sh run`.
- **Controle de versão.** Cada gravação confere a revisão lida; `--revisao N` usa a revisão que você leu antes (`listar --json`), e um arquivo alterado no meio do caminho é recusado (código 4).
- **O ambiente vence.** Opção definida por variável de ambiente ou `service.env` é recusada (a origem é `ambiente`); edite o `service.env`/Compose. A CLI lê o `DATA_DIR/service.env` para mostrar o mesmo ambiente do serviço Linux; em shell, contêiner (`docker exec` herda o ambiente do contêiner; `run --rm` só tem o da imagem) e Windows ela vê apenas as variáveis do próprio processo. Rode-a no mesmo ambiente do aplicativo.
- **Reinício.** As alterações valem na próxima partida do aplicativo (a CLI não fala com o processo em execução). A saída lista as que exigem reinício.
- **Configuração quebrada.** `settings.json` corrompido, de versão futura ou com valor inválido recusa a partida e `definir` não regrava por cima. `diagnosticar` aponta o problema; `recuperar` isola o arquivo (guarda cópia) para voltar a ambiente + padrões. Problemas que vêm do ambiente não são tocados.
- **Modo LAN.** `modo lan` passa pela mesma validação (em contêiner exige `BRIDGE_PUBLIC_URL` e `ADDON_PUBLIC_URL`) e mostra o aviso de segurança. Voltar a `local` não apaga dados.

Códigos de saída: `0` ok; `1` recusado ou inválido; `2` uso incorreto ou sem terminal; `3` aplicativo em execução; `4` conflito de revisão. Com `--json` os erros saem como `{"ok":false,"code":...,"problems":[...]}`.

## Credenciais e caminhos

| Variável | Padrão | Comportamento |
|---|---|---|
| `DATA_DIR` | `private/` na raiz do código | Sessão, passkey, credenciais de reprodução, cofre, torrents, cache e logs |
| `ASC_TORRENT_DIR` | `DATA_DIR/torrents` | Biblioteca local de `.torrent` |
| `BRIDGE_STORE` | `DATA_DIR/cache` | Arquivos de vídeo e dados recebidos |
| `PASSKEY` | ausente | Credencial do tracker em memória; precede a leitura do arquivo |
| `PASSKEY_FILE` | ver limitação abaixo | Opção do leitor de passkey; não altera o arquivo na inicialização atual |
| `ANNOUNCE_BASE` | Base de announce do ASC definida em `src/passkey.js` | Base usada para injetar a passkey em memória |

**Limitação de `PASSKEY_FILE`:** `src/index.js` chama o leitor passando explicitamente `DATA_DIR/passkey.txt`, e esse argumento prevalece sobre `PASSKEY_FILE`. Para o programa principal, use esse arquivo ou `PASSKEY`. Não há necessidade de definir `ANNOUNCE_BASE` em uma instalação normal.

Caminhos relativos fornecidos por variável são interpretados a partir do diretório de trabalho do processo. Prefira caminhos absolutos em serviços e instalações separadas do código.

## Rede e Stremio

| Variável | Padrão na execução manual | Comportamento |
|---|---|---|
| `PORT` | `7000` | Servidor do addon |
| `BRIDGE_PORT` | `7010` | Ponte de vídeo |
| `CONFIG_PORT` | `7020` | Painel; use sempre `http://127.0.0.1:<porta>` |
| `TORRENT_PORT` | Porta livre escolhida pelo sistema | Entrada de peers; a imagem fixa `7030` |
| `ASCSTREMIO_MODE` | `local` | `local` ou `lan`; ver acima |
| `BRIDGE_ALLOW_LAN` | desligado | `1` faz addon e ponte escutarem em todas as interfaces; não muda o painel nativo |
| `ASCSTREMIO_CONTAINER` | desligado | `1` faz os três servidores escutarem em `0.0.0.0` dentro do contêiner; a imagem já define |
| `BRIDGE_PUBLIC_URL` | Calculada a partir da interface e da porta | URL da ponte nas fontes; não muda sozinha a interface de escuta |
| `ADDON_PUBLIC_URL` | Calculada a partir da interface e da porta | Base das imagens do catálogo de status; não muda sozinha a interface de escuta |
| `LAN_ADVERTISE_HOST` | ausente | Endereço anunciado aos outros aparelhos no modo LAN: IPv4 ou nome DNS (IPv6 ainda não: a escuta é só IPv4), sem esquema, porta ou caminho; ver [endereço anunciado](#endereço-anunciado-na-lan) |
| `LAN_INTERFACE` | ausente | Interface de onde tirar o endereço anunciado quando há várias (`enp3s0`, `Wi-Fi`) |
| `ALLOWED_HOSTS` | vazio | Nomes DNS adicionais aceitos por addon/ponte, separados por vírgula |
| `STATUS_CATALOG` | `on` | `off` remove o catálogo de status e seus alertas das fontes |
| `DEMO_MODE` | desligado | `true` adiciona uma fonte de demonstração externa |

`PORT`, `BRIDGE_PORT` e `CONFIG_PORT` devem ser inteiros entre 1 e 65535. `ALLOWED_HOSTS` não muda o Host exato exigido pelo painel. Alterar a porta interna do contêiner exige ajustar a publicação da mesma porta no host para o painel. Os nomes em `BRIDGE_PUBLIC_URL`/`ADDON_PUBLIC_URL` também entram na lista de hosts aceitos por addon/ponte.

### Endereço anunciado na LAN

Três coisas são independentes: a **escuta** (interface de bind, definida pelo modo), o **endereço anunciado** (o que entra nas URLs de instalação e de vídeo que o Stremio de outro aparelho vai usar) e os **hosts aceitos** (cabeçalho `Host`, anti DNS rebinding). Escolher o endereço anunciado não amplia a escuta nem o `Host` aceito, exceto por incluir o próprio nome DNS escolhido, sem curingas; também não abre o painel pela LAN.

Ordem de decisão por serviço (addon e ponte): URL explícita (`ADDON_PUBLIC_URL`/`BRIDGE_PUBLIC_URL`) > `LAN_ADVERTISE_HOST` + porta do serviço > endereço de `LAN_INTERFACE` > escolha automática. No modo local o resultado é sempre `127.0.0.1`, sem configurar nada.

- **Escolha automática (modo LAN nativo).** Só considera redes locais comuns. São excluídos, com o motivo visível em `npm run rede`: loopback, link-local (`169.254/16`, `fe80::/10`), interfaces virtuais (Docker, `veth`, `virbr`, VirtualBox, VMware, Hyper-V/WSL) multicast e endereços IPv6 (a escuta é só IPv4, então anunciar IPv6 geraria URLs inalcançáveis). VPN/overlay (Tailscale, WireGuard, faixa `100.64.0.0/10`) só entra por escolha explícita. Com mais de uma interface candidata o programa **avisa no log** e continua com a primeira (para não impedir a retomada do seed), mas isso é ambiguidade: defina `LAN_ADVERTISE_HOST` ou `LAN_INTERFACE`.
- **Endereço estável.** IP de DHCP muda. Reserve o IP no roteador ou use um nome do DNS local em `LAN_ADVERTISE_HOST`. mDNS (`.local`) não funciona em todo aparelho. Um nome DNS não é verificado (o programa não sabe se ele resolve para cá).
- **Validação.** O IPv4 escolhido precisa pertencer a uma interface deste computador: ao **salvar** pela configuração central a divergência é recusada; na **partida** é só aviso (a rede pode estar subindo). URLs explícitas (proxy, NAT, DNS) não precisam pertencer a nenhuma interface. `LAN_ADVERTISE_HOST` e `LAN_INTERFACE` contraditórios são recusados.
- **Interface perdida.** No modo LAN o aplicativo confere a cada 5 min se o endereço anunciado ainda existe aqui e registra um aviso uma vez por mudança. Nada é alterado em silêncio: as URLs já instaladas no Stremio continuam as mesmas (o programa não conhece o manifesto guardado em cada cliente); depois de corrigir o endereço, remova e reinstale o addon com a URL nova. Seed e dados não são tocados.
- **Contêiner.** Dentro dele só se vê a interface interna, então o programa não adivinha: informe `LAN_ADVERTISE_HOST` (ou as duas URLs públicas) com o endereço do host e publique as portas com os mesmos números.
- **Alcance pelo cliente é desconhecido.** Pertencer ao host não prova que a TV chega lá (roteador, firewall, isolamento de Wi-Fi). Não existe teste de URL arbitrária.

Diagnóstico (só lê, não grava nem abre conexão):

```bash
npm run rede                          # modo, escuta, endereço anunciado, interfaces e justificativas, avisos
npm run rede -- validar 192.168.1.10  # simula LAN_ADVERTISE_HOST sem gravar (mesma validação estrita do salvar)
npm run rede -- --json
```

A URL de instalação aparece com `<credencial>`; o token real só sai uma vez em `npm run credenciais -- criar "<nome>"`, já com o endereço anunciado (e um aviso se ele não servir a outros aparelhos), e nunca vai para log. QR code não é gerado.

Consulte [segurança e rede](seguranca.md) antes de habilitar LAN. Não use essas opções para hospedar uma conta compartilhada.

## Seed, energia e transferência

| Variável | Padrão | Comportamento |
|---|---|---|
| `AFTER_SEED` | `delete` | Depois da confirmação do tracker: `delete` encerra e apaga arquivos; `stop` encerra e preserva; `keep` continua semeando |
| `BACKGROUND_COMPLETE` | `off` | `auto` conclui automaticamente apenas freeleech elegíveis parados |
| `BACKGROUND_IDLE_MINUTES` | `10` | Inatividade antes da conclusão automática; número ≥ 1 |
| `SEED_REQUIRED_HOURS` | `72` | Meta local; não altera a obrigação imposta pelo tracker |
| `KEEP_AWAKE` | `auto` | `off` desliga o bloqueio de suspensão; no contêiner o bloqueio não é usado |
| `BRIDGE_UPLOAD_LIMIT` | `-1` (sem limite) | Limite de upload em bytes/s |

Não reduza a meta local como forma de contornar as regras do ASC. A conciliação continua subordinada ao tracker. Veja [seed](seed.md) para os efeitos de assistir só parte de um filme e de concluir o download.

## Disco

| Variável | Padrão | Comportamento |
|---|---|---|
| `DISK_RESERVE_GIB` | `2` | Reserva absoluta de espaço livre, em GiB (número ≥ 0; `0` desliga esta parte) |
| `DISK_RESERVE_PERCENT` | `0` (desligado) | Reserva em percentual do tamanho do volume, de 0 a 90 |

A reserva vale para o volume de `BRIDGE_STORE` (inclusive disco externo ou montagem; se a pasta ainda não existe, mede o volume onde ela será criada). Quando as duas coexistem, **vale a maior**. Se o percentual está ligado e o sistema não informa o tamanho do volume, a reserva não pode ser honrada e o estado é "desconhecido".

A mesma política decide **todo novo download**: streaming sob demanda (`/s` e `/a`), conclusão em segundo plano (automática ou `POST /complete`) e retomada na partida. Um download novo só é aprovado se `livre - reserva - o que outros downloads em curso ainda vão gravar >= o que ele precisa`. A conta é feita de uma vez só, então dois filmes abertos juntos não usam a mesma folga duas vezes. Para o streaming, o necessário é o tamanho do torrent menos o que já ocupa disco (blocos alocados, pois o arquivo é esparso), porque o player pode seguir até o fim ou pular para o final; no Windows, sem arquivos esparsos garantidos, isso também cobre a escrita fora de ordem. Não se promete que 2 GiB bastem para qualquer vídeo: um filme de 40 GiB exige 40 GiB mais a reserva.

- **Recusa antes de qualquer efeito:** sem folga, o player recebe `507` e o painel mostra o motivo, sem baixar o `.torrent` (snatch), abrir o torrent nem anunciar. Em `/a/<id>` o tamanho vem da listagem; sem ele, exige ao menos a reserva livre e confere o tamanho real ao abrir o torrent.
- **Falha na medição (`statfs`):** o estado é "desconhecido" e novos downloads são recusados (`503`, com `Retry-After`), nunca tratados como espaço infinito. O que já está completo em disco continua abrindo e semeando, e nenhum torrent existente é encerrado por isso.
- **`HEAD` e listagem de fontes** continuam sem efeito: não medem para reservar, não baixam `.torrent` nem anunciam.
- **Nada é apagado** por esta política. Liberar espaço continua sendo `AFTER_SEED` e a retenção prevista na issue #27.
- O painel (e o catálogo "ASC — status") mostra livres, reserva efetiva, espaço comprometido e disponível; o alerta de bloqueio tem histerese (entra ao esgotar a folga e só sai quando sobra a maior de 256 MiB ou 10% da reserva).

## Logs

| Variável | Padrão | Comportamento |
|---|---|---|
| `LOG_LEVEL` | `debug` | Mínimo registrado: `debug`, `info`, `warn` ou `error` |
| `LOG_RETENTION_DAYS` | `14` | Retenção dos arquivos diários |

A página `/logs` permite mudar o nível durante a execução; para preservar a escolha depois de reiniciar, altere o ambiente. Consulte [manutenção](manutencao.md#logs).

## Exemplo de instância separada

Em Bash, para testar sem usar as portas HTTP e os dados da instalação principal:

```bash
DATA_DIR=/tmp/ascstremio-teste PORT=18000 BRIDGE_PORT=18010 CONFIG_PORT=18020 npm start
```

A pasta precisa ser exclusiva dessa instância. Não copie a conta real para testes automatizados. Essa configuração não simula o ASC: sem sessão e passkey, a integração autenticada continua indisponível.
