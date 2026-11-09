# Amigos Share · Stremio

## Login ASC e busca de filmes

Execute `npm start` e abra **http://127.0.0.1:7020/** neste computador. Informe
usuário e senha do ASC e clique **Conectar**. O formulário usa a senha somente para
entrar; apenas cookies da sessão e a opção de freeleech ficam em
`private/asc-session.json` (ou `DATA_DIR`), com permissão 0600. Não envie sua senha pelo chat.

Reinstale o addon com **http://127.0.0.1:7000/manifest.json** para atualizar os catálogos.
Em Descobrir → Filmes, escolha **ASC — filmes**. O catálogo aceita busca textual;
abrir filmes de catálogos IMDb também consulta fontes no ASC. O filtro **somente
freeleech** vem ativado e descarta resultados sem confirmação explícita dessa marca.
Para mudar o filtro, faça login novamente com a opção desejada.

A configuração só atende em loopback e exige Host/origem e token CSRF válidos.
Sessão expirada exige novo login. Desafios do site, 2FA ou migração de senha podem
exigir ação no navegador; o código não tenta contorná-los. Remover a sessão local
apaga os cookies salvos; não encerra outras sessões no ASC nem torrents ativos.

A busca usa até 96 releases por consulta e oferece até doze fontes em buscas IMDb. Não há
paginação online ou seleção de episódios em packs. A integração online destina-se a filmes
(um vídeo principal por release). As chamadas ao ASC são serializadas com intervalo mínimo
de dois segundos.

**Como a lista de fontes aparece no Stremio.** Cada versão do filme é uma fonte. Cada dado
aparece num lugar só (nada repetido entre as duas colunas, e o título do filme não se repete):

```
ESQUERDA (nome)       DIREITA (descrição)
🆓 4K                 HDR10 · H.265
REMUX                 🇧🇷🇺🇸 TrueHD
                      👤 4 seeders · 💾 48,6 GB · ✅ 60
                      ⚠ avisos, quando houver
```

Esquerda: `🆓` (só se for freeleech), resolução e fonte (REMUX, WEB-DL…). Direita: HDR/codec de
vídeo; idioma em bandeira + codec de som (Atmos, TrueHD…); `👤` seeders (+ leechers), `💾`
tamanho e `✅` completos; e os avisos (só `⚠ Não é freeleech`, `⚠ ISO` e `⚠ Baixa de novo (72 h)`, este quando os arquivos já
foram removidos e assistir abre outra obrigação de 72 h). **Bandeiras:** a busca só traz o selo (*Dual Áudio*, *Dublado*, *Legendado*), então o idioma
**original** vem da página de um release do filme (atributo `language`, ex. Coreano): é
**uma leitura por filme**, guardada em memória, e a primeira abertura leva ~2 s a mais. Com ele:
*Dual Áudio* = 🇧🇷 + bandeira do original (Parasita = 🇧🇷🇰🇷), *Dublado* = 🇧🇷, *Legendado* =
bandeira do original + 💬. Se a leitura falhar, aparece 🌐 no lugar da bandeira e tenta de novo
na próxima abertura. O ASC **não publica as faixas de áudio** (o `mediainfo` vem vazio nos
releases testados): o 🇧🇷 é o que o selo promete, não algo verificado no arquivo. Selo
desconhecido aparece como texto. Ordem: com seeders e sem imagem de disco primeiro, **mais seeders
antes** e, em empate, freeleech antes; sem seeders e ISO vão para o fim (continuam visíveis).
Campos que a busca não traz (resolução em alguns releases, legenda) simplesmente não aparecem.
O play sem peers não trava: a ponte responde 504 se o primeiro trecho não chegar em 60 s.

**Abrir a página de um filme não baixa nada.** A lista de fontes é montada só com o que a
própria busca devolve: nome, selos (1080p, WEB-DL, Dual Áudio…), tamanho, seeders, leechers,
completos e freeleech. A URL de cada fonte é `http://127.0.0.1:7010/a/<id do release>`. O
`.torrent` só é baixado quando o player faz o primeiro `GET` nessa URL, ou seja, quando você
dá o play; `HEAD` e sondagens nunca baixam nem anunciam. Na prática:

- você pode olhar quantos filmes quiser sem gravar `.torrent` (com a sua passkey) nem gastar
  requisições à conta por opções que não vai tocar;
- o primeiro play leva 2 a 4 segundos a mais (download do `.torrent` e abertura do torrent);
- a regra do filtro "somente freeleech" vale no play: um release que não seja freeleech nunca
  é baixado com o filtro ligado (se a URL for antiga e não houver registro, o addon confirma
  na página do torrent antes de baixar);
- o formato do release (pack, ISO) só é conhecido com o `.torrent`: o addon descobre no play,
  responde com o motivo e passa a não oferecê-lo mais nas listas;
- o nome real do arquivo (`filename`) só vai nas fontes cujo `.torrent` já está na biblioteca.

### Quais releases tocam

| Caso | O que acontece |
| --- | --- |
| `private: 1` ou `private: 0` | **Tocam igual.** A ponte usa o `.torrent` real com o DHT desligado e só o tracker do ASC. A flag só impedia a reprodução direta pelo motor do Stremio (`docs/reproducao-asc.md`). Em 08/11/2026: 21 dos 26 `.torrent` da biblioteca são `private: 1` e 5 são `private: 0`. |
| Um vídeo, ou filme + extras pequenos | **Toca.** O filme é o vídeo que domina o torrent (≥ 70% do total e ≥ 4× o segundo): making-of, entrevistas e trailers ao lado não contam. Ex.: `asc-467` (*Perdido em Marte*) = 1 filme de 6,6 GB + 8 extras de 20 a 70 MB. |
| Vários vídeos de tamanho parecido (trilogia, coleção, CD1/CD2) | Não toca: recusado no play (422) com o motivo. |
| Imagem de disco (`.iso`, BDMV, BD25, DVD9) | Não toca (não há vídeo para servir). Já é avisado na lista (`⚠ ISO`) e vai para o fim. |
| 0 seeders | Aparece com `👤 0 seeders` (sem frase de aviso) e vai para o fim da lista. O play é recusado (503) **antes** de baixar o `.torrent` ou anunciar, porque abrir só criaria um snatch vazio no tracker. Se os dados já estão completos em disco, toca. |
| Fora do freeleech com o filtro ligado | Nunca é baixado (409). Com o filtro desligado, toca e a lista avisa do ratio. |

Resultado em 08/11/2026 sobre os 26 `.torrent` da biblioteca: 25 tocam e 1 não (um `.iso`).

Validação: `node --test test/asc-auth.test.js` cobre CSRF, cookies rotacionados,
persistência sem senha, redirects externos, sessão expirada e freeleech estrito.
Login real e formato dos resultados autenticados ainda precisam do teste do usuário.

## Painel de monitoramento

Em **http://127.0.0.1:7020/**. Sem sessão confirmada só existe a página de entrada; depois
do login (ou com uma sessão salva, que o addon confirma sozinho) o painel abre. Cada seção
tem URL própria, então dá para guardar e compartilhar links entre as páginas:

| Página | O que mostra |
| --- | --- |
| `/` Visão geral | avisos de risco, seis indicadores (seed pendente, em risco, máquina ligada, download, cumpridos, espaço), obrigações e downloads em andamento, tráfego da última hora e a conta no ASC |
| `/filmes` | todos os filmes com abas por situação (`?estado=`), busca (`?q=`) e uma linha por filme com seed de 72 h, prazo de 12 dias e rede |
| `/filmes/<infoHash>` | um filme: seed (regra 13.1), prazo (13.3), situação, dados do tracker, atividade da sessão, detalhes e o botão **Concluir download em segundo plano** (com confirmação) |
| `/trafego` | gráfico de download e upload (com tooltip, teclado e tabela equivalente) e a composição do disco por situação, com o que está sem uso |
| `/logs` | central de logs: visor ao vivo com filtros, download e arquivos (ver [Logs](#logs)) |
| `/conta` | abas Sessão, Conta no ASC (ratio, hit-and-run, prisão), Serviço (configuração em uso e comandos do systemd) e Regras |
| `/entrar` | login (a senha só serve para entrar; fica salva só a sessão) |

A barra do topo mostra ratio, upload, download e seed/leech da conta; a sidebar mostra a
sessão e a contagem por situação (cada item é um filtro de `/filmes`). Atualiza a cada 5 s
sem perder foco, aba aberta nem texto digitado. O botão de tema alterna escuro (padrão) e
claro.

**Visual.** Segue o visual do ASC (tokens OKLCH, Inter,
ícones Lucide, cards só com borda, badges `cor/15`, tabela e abas do site). As cores de
seed (verde), leech (vermelho), completo (âmbar) e primária (azul) têm o mesmo significado do
site. Só as duas séries do gráfico foram reescalonadas no tema escuro para passar no
validador de paleta. Não usa o logotipo, o banner nem a fonte Ethnocentric (identidade
restrita). Os arquivos estão em `src/ui/`.

É só leitura, exceto o botão de concluir, que exige o token CSRF da página. Atende só em
loopback e recusa `Host` diferente de `127.0.0.1`. O painel e o addon sobem antes da
retomada dos torrents, então abrem em segundos mesmo com dezenas de GB para verificar.

## Status dentro do Stremio

O addon tem um catálogo **ASC — status** (Descobrir → Filmes) com a situação da conta sem
sair do app. É preciso **remover e instalar o addon de novo** no Stremio para o catálogo
aparecer (o app guarda o manifesto):

- **Monitor ASC** (primeiro item): muda de cor e de título conforme o risco ("tudo em dia",
  "atenção", "aja agora") e traz ratio, upload/download, filmes na biblioteca, em seed,
  baixando e cumpridos, seed pendente, disco e hit-and-run/prisão.
- **Um cartão por aviso**, os críticos primeiro, com o texto completo (seed parado, prazo
  curto, arquivo ausente, inatividade perto dos 90 dias, ratio abaixo de 1,0).
- **Conta** (ratio e hit-and-runs) e **um cartão por filme em andamento** (semeando, baixando,
  cumprido) com seed, prazo e dados do tracker.
- Abrir qualquer item mostra a descrição completa, e a única "fonte" é *Abrir o painel*.
- **Alerta nas fontes:** quando há risco crítico, hit-and-run ou prisão, toda página de filme
  ASC mostra no topo uma entrada "⚠ Monitor ASC" que abre o painel. Avisos comuns ficam só
  no catálogo, para não incomodar. As fontes de um filme cujos arquivos já foram removidos
  avisam que assistir baixa de novo e abre outra obrigação de 72 h.

O Stremio não tem notificações para addons; é isso que dá para fazer dentro dele. Os
cartões são imagens SVG geradas na hora (`/status/poster/<id>.svg`, só ids que existem no
estado atual). Se o seu cliente não desenhar SVG, os itens aparecem sem imagem, com o mesmo
texto. `STATUS_CATALOG=off` desliga tudo; `ADDON_PUBLIC_URL` define o endereço dos cartões
quando o Stremio roda em outro aparelho (junto com `BRIDGE_ALLOW_LAN=1`, o ratio fica visível
na sua rede local).

## Logs

Tudo que o addon faz fica registrado: partida e configuração, cada chamada ao ASC (método,
caminho, status e tempo), eventos do cofre de seed (registro, conclusão, confirmação do
tracker, liberação), ciclo de vida dos torrents (aberto, sem peers, concluído, erro), cada
requisição de streaming, pedidos do Stremio, conciliação com o tracker e as ações do painel.
Falhas fatais também entram, com a pilha, antes do serviço reiniciar.

- **Níveis:** `debug`, `info`, `warn` (aviso) e `error` (erro). `LOG_LEVEL` define o mínimo
  gravado (padrão `debug`); dá para trocar em tempo de execução na própria página.
- **Onde ficam:** memória (últimas 5000 linhas, consulta instantânea) e `private/logs/`,
  um arquivo NDJSON por dia (`ascstremio-AAAA-MM-DD.log`, permissão 0600). Ao subir, o painel já
  mostra o que veio antes do restart. `LOG_RETENTION_DAYS` (padrão 14) apaga os antigos;
  passado 20 MB num dia só aviso e erro continuam sendo gravados.
- **Segredos:** a passkey, cookies, senhas, tokens CSRF e URLs de announce são removidos
  **antes** de qualquer gravação (memória, arquivo, terminal, API e download). O info hash
  (identifica o filme) é mantido. Cabeçalhos, cookies e corpo das chamadas ao ASC nunca são
  registrados, e a busca por texto não registra o que você pesquisou.
- **Página `/logs`:** chips por nível com contagem, busca com destaque (na mensagem e nos
  dados), fonte, janela de tempo (5 min a 24 h ou tudo), modo ao vivo, "carregar anteriores",
  copiar o que está na tela e `{…}` para ver os dados de cada linha. O filtro fica na URL.
  Abre mesmo sem sessão no ASC, que é quando mais se precisa dele. É só leitura, exceto o
  nível mínimo (exige o token CSRF da página).
- **Baixar:** `.txt` ou `.ndjson` do filtro atual, ou cada arquivo diário como está.
  Pela linha de comando: `GET /api/logs?nivel=warn,error&fonte=hnr&q=texto&limit=500` e
  `GET /api/logs/download?formato=ndjson&nivel=error`.
- No terminal: `journalctl --user -u ascstremio -f` mostra as linhas de info para cima.

## Teste dos dois torrents no aplicativo

Com `npm start` em execução, instale no Stremio Desktop pelo endereço
`http://127.0.0.1:7000/manifest.json` no campo de URL de addons. No Discover/Descobrir,
selecione Filmes e o catálogo **ASC (local)**. Abra um dos dois títulos e escolha a
fonte **ASC**. O player recebe vídeo por streaming, enquanto a ponte baixa os trechos.

O computador precisa permanecer ligado com o processo em execução. A ponte usa a porta
7010 e o addon usa a porta 7000, **ambos só em 127.0.0.1** por padrão (ver
[Uso pessoal e rede](#uso-pessoal-e-rede)).

O catálogo de teste lê os arquivos `.torrent` de `private/torrents/`; isso não significa
que os filmes já estejam baixados nem confirma que os releases sejam freeleech. A busca
autenticada e o filtro no ASC ainda serão integrados. A ponte é para teste local/LAN,
sem autenticação; não exponha essas portas à internet. TV/celular exigem `BRIDGE_ALLOW_LAN=1`
e instalação do addon compatível com o aplicativo utilizado.

Foram validados catálogo, respostas de streams e trechos reais de ambos os MKVs pela
ponte em HTTP 206. Imagem, áudio e compatibilidade de codecs precisam ser conferidos no
aplicativo Stremio. Encerrar o processo também encerra o seed dos trechos recebidos.

Base em JavaScript com o SDK oficial `stremio-addon-sdk`. Login, busca, download do
`.torrent` e streaming pela ponte já funcionam (ver acima); o catálogo online só
cobre filmes de arquivo único.

## Uso pessoal e rede

A conta do ASC é pessoal e intransferível (regras 2.1 e 2.2). Por isso:

- **Uma instância por pessoa, na própria máquina.** Não hospede o addon como serviço,
  não o publique na internet e não o compartilhe com outras pessoas: isso é compartilhar
  a conta e pode levar a banimento.
- O addon (`PORT`), a ponte (`BRIDGE_PORT`) e a tela de login (`CONFIG_PORT`) escutam só
  em `127.0.0.1`. Para assistir em TV/celular na **mesma rede local**, use
  `BRIDGE_ALLOW_LAN=1 npm start`; o log mostra um aviso, porque a ponte não tem
  autenticação. Nunca abra essas portas no roteador.
- `/cleanup`, `/seed-status` e `/status` respondem 403 a qualquer origem que não seja
  esta máquina e a pedidos vindos de páginas web (cabeçalho `Origin`).
- Cada `.torrent` carrega a sua chave de acesso (regra 2.9): não compartilhe a pasta de
  dados (`private/` ou `DATA_DIR`; no Docker, o volume `ascstremio-data`).
- **Docker:** publique as portas só em `127.0.0.1` (já é o padrão do `docker-compose.yml` e do
  `scripts/docker.sh`). Rodar no seu PC/NAS de casa é uso pessoal; hospedar em servidor para
  outras pessoas não é.

## Inatividade (regra 2.6)

Conta sem acesso ao site por 90 dias é banida. Semear pelo addon **não** é acesso ao
site. O addon guarda a data do último login explícito (`lastLoginAt` em
`private/asc-session.json`) e avisa no log ao iniciar, uma vez por dia, em
`GET /seed-status` (`avisos`) e na tela de login quando passam de 60 dias, ou quando a
data é desconhecida (sessão anterior a este recurso). Entre no ASC pelo navegador e faça
login de novo no addon para zerar a contagem.

## Ratio fora do freeleech (regra 2.7)

O filtro freeleech vem ativado. Se você o desligar, as fontes que não são freeleech
aparecem no Stremio com o aviso curto "⚠ Não é freeleech" (o download conta no ratio),
porque streaming parcial soma download e quase nenhum upload.

## Instalação

Escolha um caminho. Todos guardam passkey, sessão, cofre de seed, `.torrent`, cache e logs
em uma **pasta de dados** (`DATA_DIR`), separada do código, que sobrevive a atualizações.

| Onde | Como | Pasta de dados |
|---|---|---|
| Linux (qualquer distro glibc) | `curl -fsSL <URL>/install.sh \| bash` ou `scripts/install.sh` | `~/.local/share/ascstremio/data` (curl) ou `private/` (a partir do código) |
| Docker / Podman | `scripts/docker.sh run` ou `docker compose up -d --build` | volume `ascstremio-data` (`/data`) |
| Windows 10/11 | `AscStremio-Setup-<versão>.exe` (por usuário, sem administrador) | `%LOCALAPPDATA%\AscStremio\data` |
| macOS | à mão: Node 22+, `npm ci && npm start` (ou Docker) | `private/` |

Testes, build e releases automáticos: ver "Esteira de CI/CD" abaixo.

### Linux: script de instalação

```bash
scripts/install.sh            # confere, instala o que faltar, testa e cria o serviço
scripts/install.sh --check    # só confere, sem alterar nada
scripts/install.sh --uninstall
```

Funciona em qualquer Linux **glibc** (x64, arm64, armv7) sem pedir root: se o sistema não tem
Node 22+, baixa o Node oficial do nodejs.org (tar.gz, **SHA-256 conferido** contra o
`SHASUMS256.txt`; download que não confere é descartado) para
`~/.local/share/ascstremio/node`. Precisa só de `curl` ou `wget`, `tar` e `sha256sum`.
`--system-node` proíbe o download. Alpine/musl não é suportado pelo Node oficial: use
`apk add nodejs npm` ou o Docker.

Depois roda `npm ci`, `npm run check` (sintaxe + testes) e **só então**, havendo
`systemd --user`, cria e inicia `~/.config/systemd/user/ascstremio.service` com reinício
automático e liga o *linger* (sobe no boot sem login). Sem systemd de usuário (WSL, Alpine,
contêiner), instala e testa e mostra o comando para rodar à mão. Como serviço de usuário não
enxerga o `network-online.target`, a unidade espera a rede com
`ExecStartPre=-nm-online -q -t 90` (o `-` deixa subir sem NetworkManager ou sem internet;
`TimeoutStartSec=120`). Se a leitura do ASC falhar na partida, o monitor tenta de novo em 15 s,
30 s, 1 min… até 5 min, e o cartão de status mostra "dados da conta ainda não lidos" (nunca
"tudo em dia" sem ter lido o ratio). Unidade antiga vira cópia `.bak-*`. Se as portas
7000/7010/7020 estiverem ocupadas, para e avisa quem as ocupa; para um `npm start` **deste
mesmo projeto**, `--replace-manual` o encerra com SIGINT (cofre preservado) e segue.

- Estado: `systemctl --user status ascstremio` · Logs: `journalctl --user -u ascstremio -f`
- Configuração: `service.env` na pasta de dados (modelo comentado), depois `systemctl --user restart ascstremio`.
- **Energia:** enquanto houver seed pendente ou download em andamento, o addon bloqueia a
  suspensão do PC (`KEEP_AWAKE=auto`) e solta quando não há mais nada pendente. O bloqueio
  morre junto com o processo. Linux: `systemd-inhibit`; macOS: `caffeinate`; Windows:
  `SetThreadExecutionState` (PowerShell). **No Docker não há bloqueio**: a suspensão é da
  máquina hospedeira; configure-a para não suspender enquanto houver seed pendente.
- **Limite cumprido:** quando 72 h ou ratio 1.0 são **confirmados pelo tracker**, a ponte
  encerra o seed e libera disco e rede (`AFTER_SEED=delete`, padrão: apaga os arquivos;
  `stop`: mantém os arquivos; `keep`: continua semeando). Reabrir o filme depois baixa de novo.

### Linux: uma linha com curl

```bash
curl -fsSL <URL-base>/install.sh | bash                      # instala ou atualiza
curl -fsSL <URL-base>/install.sh | bash -s -- --no-service   # sem serviço
```

`<URL-base>` é onde você hospedou os arquivos gerados por `scripts/build-release.sh`
(`install.sh`, `ascstremio-latest.tar.gz` e o `.sha256`). O instalador baixa o pacote,
**recusa instalar se o SHA-256 não conferir**, rejeita caminhos suspeitos no `.tar.gz`, instala
o código em `~/.local/share/ascstremio/app` e chama `scripts/install.sh`. Atualizar é rodar de
novo: o código é trocado e os dados em `.../data` ficam (a versão anterior fica em
`app.anterior` se a instalação falhar). O SHA-256 vem do mesmo servidor do pacote, então ele
protege de download corrompido, **não** de um servidor comprometido: hospede em um lugar seu.

### Docker / Podman

```bash
scripts/docker.sh run        # constrói a imagem, cria o volume e sobe o contêiner
scripts/docker.sh passkey    # grava a passkey no volume (sem eco no terminal)
scripts/docker.sh logs       # (também: build, stop, shell, save)
docker compose up -d --build # alternativa com o docker-compose.yml
```

Painel em http://127.0.0.1:7020/ e addon em http://127.0.0.1:7000/manifest.json, como no Linux.
O `docker.sh` usa `docker` ou `podman` (ou `CONTAINER_ENGINE=`). A imagem é `node:22-bookworm-slim`,
roda como usuário `node`, sem root, com `ASCSTREMIO_CONTAINER=1` (escuta em `0.0.0.0` **dentro** do
contêiner, e trata o gateway do Docker como "esta máquina" nas rotas administrativas).

- **As portas 7000/7010/7020 são publicadas só em `127.0.0.1`.** Não troque isso por `0.0.0.0`:
  a ponte não tem autenticação e usa a sua conta (regra 2.2). A porta do painel de fora
  **precisa** ser igual à de dentro (o painel confere o cabeçalho `Host`); para mudar, defina
  `CONFIG_PORT` e publique a mesma porta.
- `7030` (`TORRENT_PORT`) é a porta de entrada dos peers; remova-a se não quiser receber conexões.
- Configuração por variáveis (`-e AFTER_SEED=keep`, `environment:` no compose). Parar o
  contêiner usa SIGINT (desligamento limpo, o cofre é preservado; `stop_grace_period: 30s`).
- `scripts/docker.sh save` exporta a imagem para `dist/` (carregar com `docker load`).

### Windows

O instalador `AscStremio-Setup-<versão>.exe` traz o Node 22 oficial, o app e as dependências
(as bibliotecas nativas já incluem binários win32-x64). Instala **por usuário, sem administrador**
em `%LOCALAPPDATA%\Programs\AscStremio`, cria atalhos no Menu Iniciar ("Abrir painel", "Parar
serviço", "Pasta de dados") e um atalho na pasta Inicializar para subir ao entrar no Windows
(necessário para semear as 72 h). O fim do assistente abre o painel de login. Logs do processo:
`%LOCALAPPDATA%\AscStremio\data\service.log`. Desinstalar mantém a pasta de dados.

Limites do Windows: não há desligamento "limpo" (Parar encerra o processo; o cofre grava a cada
minuto, então perde-se no máximo ~1 min de contagem); na primeira execução o Firewall do Windows
pergunta sobre o `node.exe` (a porta de peers escuta em todas as interfaces; o addon e o painel
ficam em `127.0.0.1`). **O instalador nunca foi executado em um Windows real nesta base**: gere-o
com `scripts/build-release.sh --windows` (precisa de `makensis`) e teste antes de distribuir.
O instalador não é assinado: o SmartScreen avisa na primeira vez.

### Variáveis de ambiente

| Variável | Padrão | Efeito |
|---|---|---|
| `DATA_DIR` | `private/` | pasta de passkey, sessão, cofre, `.torrent`, cache e logs |
| `PORT` / `BRIDGE_PORT` / `CONFIG_PORT` | 7000 / 7010 / 7020 | addon, ponte, painel |
| `TORRENT_PORT` | aleatória | porta de entrada dos peers (fixe-a no Docker) |
| `BRIDGE_ALLOW_LAN` | desligado | `1` escuta na rede local (sem autenticação) |
| `ASCSTREMIO_CONTAINER` | desligado | `1` escuta em `0.0.0.0` dentro do contêiner (a imagem já define) |
| `BRIDGE_PUBLIC_URL` / `ADDON_PUBLIC_URL` | automática | endereço que o Stremio usa, se não for `127.0.0.1` (o host entra na lista permitida) |
| `ALLOWED_HOSTS` | vazio | nomes DNS extras aceitos no cabeçalho `Host`, separados por vírgula |
| `AFTER_SEED` | `delete` | `delete`, `stop` ou `keep` ao cumprir o limite |
| `BACKGROUND_COMPLETE` | `off` | `auto` conclui freeleech parados |
| `KEEP_AWAKE` | `auto` | `off` não bloqueia a suspensão |
| `LOG_LEVEL` / `LOG_RETENTION_DAYS` | `debug` / 14 | logs |
| `PASSKEY` / `PASSKEY_FILE` | `DATA_DIR/passkey.txt` | passkey por ambiente ou arquivo |

## Executar à mão

Requer Node.js 22 ou superior (em macOS, o único caminho sem Docker). Use `npm start`: ele passa `--max-http-header-size=65536`,
necessário porque a página `/torrents/<id>` do ASC responde com cabeçalhos de ~14 KB e o
padrão do Node (16 KB no total) recusa a resposta (`UND_ERR_HEADERS_OVERFLOW`).

```bash
npm ci
npm start
```

Manifesto local: `http://127.0.0.1:7000/manifest.json`.
Cole esse endereço no campo de instalação de addons do Stremio.
Para mudar a porta: `PORT=7001 npm start`.

## Demonstração

```bash
DEMO_MODE=true npm start
```

No Stremio, abra o filme **Big Buck Bunny (2008)**. Uma opção de demonstração aparecerá entre os streams. A URL externa de teste depende da disponibilidade do servidor público.

Também é possível consultar diretamente:

```bash
curl http://127.0.0.1:7000/manifest.json
curl http://127.0.0.1:7000/stream/movie/tt1254207.json
curl http://127.0.0.1:7000/stream/series/tt0944947:1:1.json
```

Sem demonstração ou integração, a resposta é `{"streams":[]}`.

## Como funciona

1. O Stremio lê o manifesto para identificar os recursos do addon.
2. Ao abrir um filme ou episódio de um catálogo compatível, solicita seus streams.
3. O addon converte o ID em `{ type, imdbId, season?, episode? }`.
4. `src/providers/amigos-share.js` deverá consultar o serviço e devolver objetos Stream do Stremio.
5. O player recebe a fonte e tenta reproduzi-la. A base não retransmite vídeos.

Filmes usam IDs como `tt1254207`; episódios usam `tt0944947:1:1` (IMDb, temporada, episódio). A base usa os catálogos já presentes no Stremio; não fornece catálogo próprio.

## Integração com Amigos Share

O serviço já foi mapeado: `amigos-share.club` é um tracker privado (Laravel + Inertia +
React, atrás de Cloudflare), a autenticação é por **cookie de sessão** e a listagem sai de
`GET /torrents` com `category=4` (Filmes). Os detalhes — parâmetros, formato da resposta e
mapeamento de campos — ficam nas notas locais do mantenedor, fora do repositório.

### Reprodução: ponte, não P2P direto

Verificado com torrents reais: a autenticação funciona (o
`.torrent` traz `https://amigos-share.club/announce/<passkey>` e esse announce autentica sem
cookie), mas o
Stremio não aceita `.torrent` — só o equivalente a um magnet, e torrent com `private: 1`
não pode ser convertido em magnet. Além disso ele injeta `dht:<infoHash>` sempre e não
semeia. Como o ASC emite torrents com `private: 1` **e** `private: 0`, a ponte de streaming
é o caminho: o addon baixa o `.torrent` com o cookie, e a ponte carrega o arquivo real
(trackers só do ASC, DHT desligado), serve `Range/206` baixando apenas os trechos pedidos e
mantém o seed.

O adaptador devolve `{ name, description, url, behaviorHints: { notWebReady: true } }`
com a URL da ponte — `notWebReady` é obrigatório porque a URL é `http://` e o arquivo
costuma ser MKV.

Não há autenticação de usuários, cache compartilhado ou publicação nesta fase. O cache HTTP das respostas está desativado para não reutilizar futuros links temporários. Antes de exposição pública, definir autenticação e tratamento de credenciais conforme a integração escolhida.

Para acesso remoto, hospedar com HTTPS. O SDK fornece as rotas e CORS; HTTPS fica por conta da hospedagem/reverse proxy. Não é necessário publicar no diretório de addons para instalar por URL.

## Credencial fora dos arquivos (para publicar o projeto)

Os `.torrent` do ASC carregam a passkey no announce. Para publicar o código sem
expor a conta, a credencial saiu dos arquivos:

```bash
# 1. guarda a passkey em um único arquivo 0600 (ou use a env PASSKEY)
printf '%s' SUA_PASSKEY > private/passkey.txt && chmod 600 private/passkey.txt

# 2. a ponte injeta a credencial em memória ao abrir cada torrent
npm start
```

`ANNOUNCE_BASE` define a base do announce quando o arquivo foi sanitizado com
`--strip` (padrão: `https://amigos-share.club/announce`). `BRIDGE_UPLOAD_LIMIT`
(bytes/s) limita o quanto a ponte sobe para o swarm. `GET /seed-status` mostra
horas de seed e ratio por torrent; `POST /cleanup` encerra e apaga o cache, mas
**recusa** antes de cumprir a regra 13.1 do site (72 h ou ratio 1.0 no torrent),
salvo com `?force=1`. Isso evita hit-and-run por engano.

O que isso protege: o repositório, prints, backups e a pasta de torrents deixam
de conter a credencial. O que não muda: todo announce continua sendo creditado
à sua conta no tracker.

## Evitar hit-and-run (HNR)

`HEAD` passou a ser respondido pelo `.torrent` local, sem abrir torrent nenhum —
assim previews e testes do Stremio não criam snatch no tracker. Só um `GET`
abre e anuncia. As obrigações de seed ficam em `private/seed-vault.json`
(`0600`), sobrevivem a reinício e são retomadas no start; o tick de 60 s só
acumula tempo com o torrent ativo e semeando. `SEED_REQUIRED_HOURS` (padrão 72)
define a meta.

**Concluir em segundo plano.** Assistir só um trecho cria o snatch no tracker, mas seed de
download incompleto não é creditado. Para quitar, baixe o resto: `curl -X POST
"http://127.0.0.1:7010/complete?hash=<infoHash>"` (qualquer release), ou ligue
`BACKGROUND_COMPLETE=auto npm start` para concluir sozinhos os **freeleech** parados há
`BACKGROUND_IDLE_MINUTES` (padrão 10). Baixa com prioridade baixa, só com espaço em disco, e
abre a obrigação de 72 h (conciliada com o tracker). Não é um modo de "nunca concluir".

Além do cofre local, o addon confere o `myHistory` do tracker (na partida, de hora em
hora e antes de qualquer `/cleanup`) e **o tracker vence**: tempo local de 72 h só
vale depois que o site confirmar. Avisos de torrent inativo com pendência, prazo
curto ou HnR registrado saem no log (`[hnr]`) e em `GET /seed-status`. A ponte pública ficou adiada.

## Esteira de CI/CD

GitHub Actions em `.github/workflows/`:

- **`ci.yml`** (push, pull request): testes em Ubuntu e Windows com Node 22 e 24, shellcheck,
  actionlint, auditoria de dependências, barreira de segredos, pacote Linux, imagem Docker,
  instalador Windows instalado de verdade e, nos pull requests, conferência dos títulos dos commits.
- **`release.yml`** (push na `main`): versão, changelog e release automáticos (abaixo).

### Versão e changelog pelos commits

Os títulos dos commits seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/)
(`scripts/check-commits.sh` confere nos pull requests) e decidem a versão:

| Título do commit | Efeito (hoje, em 0.x) |
|---|---|
| `fix:`, `perf:`, `security:` | correção: 0.1.0 → 0.1.1 |
| `feat:` | versão menor: 0.1.0 → 0.2.0 |
| `feat!:` ou rodapé `BREAKING CHANGE:` | versão maior (em 0.x conta como menor; depois da 1.0, maior) |
| `docs:` `refactor:` `build:` `ci:` | entram no changelog, **sem** versão nova |
| `test:` `chore:` `style:` | não entram no changelog |

Fluxo: a cada push na `main`, o *release-please* mantém um PR **"chore(main): release X.Y.Z"**
com o `CHANGELOG.md` e a versão nova (`package.json` e lock). **Mergear esse PR é lançar a versão**:
o release é criado como rascunho e a esteira então testa e monta tudo — pacote Linux
(`ascstremio-X.Y.Z.tar.gz` + `install.sh`), instalador `AscStremio-Setup-X.Y.Z.exe` (instalado e
iniciado num Windows real antes de sair), `SHA256SUMS` e atestado de procedência — publica a
**imagem Docker no GitHub Packages** (`ghcr.io/<dono>/ascstremio`, tags `X.Y.Z`, `X.Y` e `latest`,
amd64 e arm64) e só então publica o release com as notas do changelog. Se algum passo falhar, o
release continua rascunho. Nada de `npm version` nem de tag à mão.

Os passos vivem em `scripts/` e rodam igual localmente: `scripts/build-release.sh`,
`scripts/smoke-install.sh`, `scripts/smoke-container.sh`, `scripts/check-no-secrets.sh`.

## Segurança e dados

- O repositório **não** contém passkey, cookies, `.torrent`, cofre de seed, logs nem capturas do
  site: `private/`, `*.torrent`, `docs/`, `tools/` e afins ficam no `.gitignore`, e
  `scripts/check-no-secrets.sh` (rodado no CI antes de qualquer pacote) falha se algo assim
  aparecer. Só o `README.md` e o `CHANGELOG.md` gerado são publicados.
- **Proteções do app local** (cada uma com teste em `test/`):
  - escuta só em `127.0.0.1` (a rede local exige `BRIDGE_ALLOW_LAN=1`);
  - **anti DNS rebinding**: addon, ponte e painel recusam `Host` que seja nome DNS (só IP
    literal, `localhost` e o que estiver em `ALLOWED_HOSTS`, `BRIDGE_PUBLIC_URL` ou
    `ADDON_PUBLIC_URL`; quem usa um nome próprio, como um NAS, o declara ali);
  - **chave nas URLs de stream** (`?k=`, 128 bits, em `bridge-key` 0600): sem ela `/s/…` e `/a/…`
    dão 403, então uma página web não consegue disparar download ou anúncio no tracker com a
    sua conta adivinhando `/a/<id>`. Reabrir a fonte no Stremio gera a URL com a chave;
  - rotas administrativas só da própria máquina e nunca com `Origin` (bloqueia CSRF); o painel
    exige token CSRF, `Origin` e `Host` exatos;
  - passkey, cookies e chave nunca vão para logs (redação antes de gravar) nem para os `.torrent`;
    pasta de dados `0700`, arquivos `0600`;
  - serviço systemd com `NoNewPrivileges`, `RestrictSUIDSGID`, `LockPersonality`, `UMask=0077`;
    contêiner sem root, `read_only`, `cap_drop: ALL`, `no-new-privileges`;
  - `scripts/audit-check.js` audita as dependências de produção: advisory novo reprova o CI;
    os já avaliados (sem correção publicada) ficam listados com o motivo no próprio script.
- Rode `npm test` (`npm run check`) antes de contribuir; os testes ficam em `test/` e não usam
  dados reais.

## Referências oficiais

- https://github.com/Stremio/stremio-addon-sdk
- https://stremio.github.io/stremio-addon-sdk/api/requests/defineStreamHandler.html
- https://stremio.github.io/stremio-addon-sdk/api/responses/stream.html
- https://stremio.github.io/stremio-addon-sdk/api/responses/manifest.html
