# Instalação

O ASCStremio precisa de uma conta individual válida no ASC, acesso à internet, espaço para os vídeos e uma máquina que permaneça ligada para semear. O Stremio é instalado separadamente. O addon não cria uma conta no tracker.

## Antes de começar

| Plataforma | Precisa de |
|---|---|
| Linux | glibc em x64, arm64 ou armv7 (Alpine/musl não serve com o Node oficial); `curl` ou `wget`, `tar`, `gzip` e `sha256sum` (ou `shasum`) para o instalador remoto; `systemd --user` para o serviço (sem ele, o instalador mostra como rodar à mão) |
| Docker / Podman | Docker ou Podman com Compose v2 |
| Windows | Windows 64 bits; o instalador já traz o Node |
| Execução manual | Node.js 22+ e npm |

Em todos os casos: a conta e a passkey do ASC, e espaço livre para os vídeos.

## Escolha a instalação

| Plataforma | Caminho | Dados persistentes |
|---|---|---|
| Linux glibc | Instalador via curl ou script local | `private/` na instalação pelo código; `~/.local/share/ascstremio/data` na instalação remota |
| Docker / Podman | Imagem pronta do GHCR ou build local | Volume em `/data` |
| Windows | `AscStremio-Setup-<versão>.exe` | `%LOCALAPPDATA%\AscStremio\data` |
| macOS / execução manual | Node.js 22+ e npm | `private/` na raiz do projeto |

Não use a mesma pasta de dados simultaneamente em duas instâncias. Não misture os volumes de instalações diferentes.

## Linux com serviço de usuário

Na pasta do projeto:

```bash
scripts/install.sh --check
scripts/install.sh
```

`--check` confere o ambiente e roda os testes, sem criar serviço. O instalador executa as verificações e cria `ascstremio.service` quando há `systemd --user`; sem ele, mostra como executar manualmente. Para o serviço subir no boot sem você estar logado, o instalador tenta ligar o *linger* (`loginctl enable-linger`); se o sistema pedir autorização e ela não for dada, o serviço só roda com a sessão aberta. Confira a saída para saber o que aconteceu.

Em Linux glibc x64, arm64 ou armv7, se faltar Node 22+, o script baixa o Node oficial e confere seu SHA-256. `--system-node` impede esse download. O binário oficial não serve para musl/Alpine; use um Node compatível ou a imagem do projeto.

| Opção | Uso |
|---|---|
| `--no-service` | Instala dependências e verifica sem criar serviço |
| `--no-linger` | Não liga o linger: o serviço só roda com você logado |
| `--system-node` | Exige Node compatível já instalado |
| `--replace-manual` | Encerra com SIGINT uma execução manual identificada deste projeto que esteja ocupando as portas |
| `--uninstall` | Remove o serviço, preservando os dados |

Estado e logs:

```bash
systemctl --user status ascstremio
journalctl --user -u ascstremio -f
```

Para mudar a configuração, use `npm run configurar` (com o serviço parado para alterar; veja [configuração pelo terminal](configuracao.md#configuração-pelo-terminal)) ou edite `service.env` dentro da pasta de dados e reinicie o serviço. Veja [manutenção](manutencao.md).

### Instalar pelo GitHub com curl

Não é necessário clonar o repositório. O script-fonte fica no raw do GitHub e baixa o pacote do último release publicado:

```bash
curl -fsSL https://raw.githubusercontent.com/msouza10/ascstremio/main/scripts/install-remote.sh | \
  ASCSTREMIO_BASE_URL=https://github.com/msouza10/ascstremio/releases/latest/download bash
```

Para instalar sem criar o serviço:

```bash
curl -fsSL https://raw.githubusercontent.com/msouza10/ascstremio/main/scripts/install-remote.sh | \
  ASCSTREMIO_BASE_URL=https://github.com/msouza10/ascstremio/releases/latest/download bash -s -- --no-service
```

A variável precisa ser passada ao **bash**, depois do pipe: o script-fonte não tem uma URL padrão embutida. O [install.sh anexado ao release](https://github.com/msouza10/ascstremio/releases/latest/download/install.sh) já traz essa base preenchida e também pode ser baixado para inspeção antes de executar. Para repetir exatamente uma versão, use o script e o pacote do release escolhido, em vez de combinar `main` com `latest`.

O código é instalado em `~/.local/share/ascstremio/app`; os dados ficam em `~/.local/share/ascstremio/data` (salvo configuração de `XDG_DATA_HOME` ou `ASCSTREMIO_HOME`). Executar novamente atualiza o código e preserva os dados. O script baixa `ascstremio-latest.tar.gz` e seu `.sha256` e recusa um hash diferente. O hash servido pelo mesmo servidor não protege contra comprometimento dessa origem.

**Verifique o download.** O instalador já confere o `.sha256` do pacote. Para conferir também o `SHA256SUMS` da release, baixe-o junto do pacote e rode, na mesma pasta, `sha256sum -c --ignore-missing SHA256SUMS`. A procedência (atestado de build) se verifica com `gh attestation verify ascstremio-X.Y.Z.tar.gz --repo msouza10/ascstremio`, que exige o GitHub CLI 2.49 ou mais novo.

**Comandos do aplicativo na instalação remota.** `npm run credenciais`, `configurar`, `rede` e os demais procuram os dados em `<pasta do código>/private`, mas a instalação remota guarda os dados em outra pasta. Rode-os na pasta do código e informe o `DATA_DIR`:

```bash
cd ~/.local/share/ascstremio/app
DATA_DIR="$HOME/.local/share/ascstremio/data" npm run credenciais -- criar "Stremio"
```

Sem o `DATA_DIR`, o comando não acha os dados e recusa. O mesmo vale para `scripts/install.sh --uninstall`. As variáveis fixas do serviço ficam em `~/.local/share/ascstremio/data/service.env`.

**Repositório privado:** esses comandos curl não autenticam no GitHub. Enquanto o repositório e seus assets exigirem acesso, uma resposta 404/401 não significa que o caminho esteja errado. Com GitHub CLI já autenticado e autorizado, baixe os arquivos e instale localmente:

```bash
mkdir -p ascstremio-download
cd ascstremio-download
gh release download --repo msouza10/ascstremio \
  --pattern install.sh \
  --pattern ascstremio-latest.tar.gz \
  --pattern ascstremio-latest.tar.gz.sha256
ASCSTREMIO_BASE_URL="file://$PWD" bash install.sh
```

## Docker / Podman

### Usar a imagem pronta do GHCR

A imagem do projeto é **`ghcr.io/msouza10/ascstremio:latest`**. Não precisa de Node no host nem de clonar/compilar o código. A esteira publica variantes Linux `amd64` e `arm64`, com tags de versão completa, versão menor e `latest`. Para fixar uma distribuição, use uma tag publicada (`:X.Y.Z`, com a versão desejada) em lugar de `:latest`.

Se o pacote exigir autenticação, faça login primeiro:

```bash
docker login ghcr.io --username SEU_USUARIO_GITHUB
```

Substitua o nome pelo seu usuário e, quando o Docker pedir a senha, use um token do GitHub autorizado a ler o pacote (`read:packages` e acesso ao pacote). Não use a senha da conta nem coloque o token na linha de comando. A visibilidade do pacote pode ser diferente da visibilidade do repositório; acesso anônimo não deve ser presumido.

Crie uma pasta e salve este conteúdo como `compose.yaml`:

```yaml
services:
  ascstremio:
    image: ghcr.io/msouza10/ascstremio:latest
    container_name: ascstremio
    restart: unless-stopped
    stop_signal: SIGINT
    stop_grace_period: 30s
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    ports:
      - "127.0.0.1:7000:7000"
      - "127.0.0.1:7010:7010"
      - "127.0.0.1:7020:7020"
      - "7030:7030"
    volumes:
      - ascstremio-data:/data
    environment:
      AFTER_SEED: delete
      BACKGROUND_COMPLETE: "off"
volumes:
  ascstremio-data:
    name: ascstremio-data
```

Depois, na mesma pasta:

```bash
docker compose pull
docker compose up -d
docker compose logs --tail 100 -f
```

O volume tem nome explícito para preservar os dados entre recriações. Não suba esse exemplo junto de outra instalação que já use o nome `ascstremio`, as mesmas portas ou o mesmo volume.

Para gravar a passkey nesse volume sem colocá-la no histórico, use Bash no host:

```bash
read -r -s -p 'Passkey do ASC: ' asc_passkey; printf '\n'
printf '%s' "$asc_passkey" | docker run --rm -i \
  --volume ascstremio-data:/data \
  --entrypoint sh ghcr.io/msouza10/ascstremio:latest \
  -c 'umask 077; cat > /data/passkey.txt'
unset asc_passkey
docker compose restart ascstremio
```

Use a mesma tag escolhida no Compose também no comando de gravação. Abra **http://127.0.0.1:7020/** para fazer login e continue em [primeiro acesso](#primeiro-acesso).

Com Podman, use `podman login`, `podman pull` e um provedor Compose compatível com sua instalação. O script local abaixo também escolhe Podman via `CONTAINER_ENGINE=podman`.

### Construir a partir do código

Para desenvolver ou testar alterações locais, na raiz do repositório:

```bash
scripts/docker.sh run
scripts/docker.sh passkey
```

O script usa uma imagem local chamada `ascstremio:latest`; se ela não existir, constrói a imagem. Não baixa automaticamente a imagem do GHCR. Use `scripts/docker.sh build` para reconstruir depois de alterar o código.

O `docker-compose.yml` do repositório também é voltado ao build local:

```bash
docker compose up -d --build
```

**Os volumes podem ter nomes diferentes:** `scripts/docker.sh` e o exemplo de imagem pronta usam `ascstremio-data`; o Compose do repositório normalmente acrescenta o nome do projeto. Confirme o volume usado antes de gravar a passkey ou migrar dados. Não use a mesma pasta/volume simultaneamente em duas instâncias.

As portas HTTP 7000/7010/7020 ficam em `127.0.0.1` do host. A porta TCP 7030 de peers é publicada em todas as interfaces; remova essa publicação se não quiser conexões de entrada. A porta de fora tem de ser igual à de dentro (`7030:7030`), pois é a de dentro que o tracker recebe; o programa não consegue verificar a publicação de dentro do contêiner (confira com `docker port`). Em instalação nativa, receber conexões de entrada exige fixar `TORRENT_PORT`, liberá-la no firewall e encaminhá-la no roteador; atrás de CGNAT isso não é possível sem o provedor. Veja `npm run rede -- peers` e [configuração](configuracao.md#porta-de-peers-diagnóstico). Mantenha painel e administração locais; leia [segurança](seguranca.md) antes de mudar a rede. O contêiner não bloqueia a suspensão do hospedeiro.

## Windows

Baixe `AscStremio-Setup-<versão>.exe` na [página de releases](https://github.com/msouza10/ascstremio/releases) (só 64 bits) e confira o hash com o `.sha256` ao lado dele (no PowerShell: `Get-FileHash .\AscStremio-Setup-<versão>.exe -Algorithm SHA256`). Ele contém Node e dependências e instala por usuário, sem administrador, em `%LOCALAPPDATA%\Programs\AscStremio`.

O Menu Iniciar recebe atalhos para abrir o painel, parar o processo, abrir a pasta de dados, a configuração no terminal (`configurar.cmd`) e **Obter URL do addon** (`credenciais.cmd`). Na última página do instalador há uma caixa marcada com o mesmo nome: ela sobe o serviço, emite a primeira credencial só se ainda não houver nenhuma ativa e mostra a URL do Stremio **uma única vez**, numa janela de console local (sem log, arquivo ou área de transferência; copie-a antes de fechar). Com o instalador silencioso (`/S`) nada é emitido nem mostrado. Atualizar ou reinstalar não troca nem revoga credenciais; rodar o atalho de novo só informa que já existe uma (para outro aparelho: `credenciais.cmd criar "Nome"`). Um atalho na pasta Inicializar sobe o programa ao entrar no Windows. A máquina precisa continuar ligada e a sessão de usuário precisa permitir sua execução. A desinstalação mantém os dados.

O instalador não é assinado; o SmartScreen pode mostrar um aviso. A porta de peers pode provocar uma solicitação do firewall. Os serviços HTTP permanecem em loopback. O comando de parar encerra o processo à força; o cofre é salvo a cada minuto. A CI possui teste de instalação silenciosa e inicialização em Windows; isso não comprova compatibilidade de reprodução com todos os players e codecs.

## Pelo código: Linux e macOS

Na pasta do repositório, com Node.js 22+ e npm:

```bash
npm ci
npm start
```

Mantenha o terminal aberto. `Ctrl+C` encerra o aplicativo e o seed. A retomada ocorre na próxima execução, mas o prazo no tracker continua correndo. O macOS usa execução manual ou contêiner; não há instalador nativo próprio.

## Passkey do tracker

A senha autentica a sessão do site; a **passkey** autentica os anúncios BitTorrent. Configure ambas para usar a integração completa. A passkey não é a credencial de reprodução do addon, emitida pelo aplicativo (`credentials.json`).

Na execução manual ou serviço Linux, guarde sua passkey em `passkey.txt` dentro da pasta de dados, sem espaços extras. No Linux/macOS, uma forma de digitá-la sem incluí-la no histórico é:

```bash
mkdir -p private
chmod 700 private
read -r -s -p 'Passkey do ASC: ' asc_passkey; printf '\n'
(umask 077; printf '%s' "$asc_passkey" > private/passkey.txt)
unset asc_passkey
```

O exemplo é para Bash e para a instalação pelo código (pasta `private/`). Na instalação remota, a pasta é `~/.local/share/ascstremio/data`: troque `private` por `"$HOME/.local/share/ascstremio/data"` nos comandos. No Windows, crie o arquivo `passkey.txt` em `%LOCALAPPDATA%\AscStremio\data` com um editor de texto simples, só com a passkey, sem espaços nem linhas extras. No Docker, use o comando da seção de imagem pronta. Nunca envie a passkey pelo chat ou por uma issue. No Windows, proteja o arquivo pelas permissões da conta de usuário.

`PASSKEY` no ambiente tem precedência sobre o arquivo.

## Primeiro acesso

1. Abra **http://127.0.0.1:7020/** e faça login no ASC. A senha é usada para entrar; a sessão é salva em disco. Depois do primeiro login o painel abre o assistente de primeira configuração uma vez; dá para pulá-lo e ajustar tudo depois em **Configurações**.
2. Mantenha **somente freeleech** ativado até entender as regras de ratio e seed.
3. Emita a credencial de reprodução (o instalador Linux já emite a primeira): `npm run credenciais -- garantir`; no contêiner, `scripts/docker.sh credenciais garantir`; no Windows, o atalho **Obter URL do addon** (ou `credenciais.cmd` na pasta de instalação). Na instalação remota Linux, informe o `DATA_DIR` (veja acima). Instale no Stremio a URL `http://127.0.0.1:7000/<credencial>/manifest.json` mostrada na saída: no app do Stremio, abra **Addons**, cole a URL no campo de busca de addons e instale. Ela aparece só uma vez; se perder, use **Substituir** em Conta › Addons no painel (ou `credenciais rotacionar <id>`) e instale a URL nova.
4. Confira os dados da conta no painel. Se ainda não foram lidos, não interprete a ausência de avisos como regularidade.

## Parar, iniciar e ver o estado

| Instalação | Parar | Iniciar | Estado e logs |
|---|---|---|---|
| Serviço Linux | `systemctl --user stop ascstremio` | `systemctl --user start ascstremio` | `systemctl --user status ascstremio` e `journalctl --user -u ascstremio -f` |
| Docker pelo script | `scripts/docker.sh stop` | `scripts/docker.sh run` | `scripts/docker.sh logs` |
| Compose | `docker compose stop` | `docker compose start` | `docker compose ps` e `docker compose logs -f` |
| Windows | atalho **Parar servico** (pasta "Amigos Share Stremio" do Menu Iniciar) | atalho **Abrir painel**, que sobe o programa se ele estiver parado | `%LOCALAPPDATA%\AscStremio\data\service.log` |
| Manual | `Ctrl+C` | `npm start` | terminal |

Parar interrompe o seed, mas os prazos do tracker continuam correndo. Para trocar a versão, veja [atualizar](manutencao.md#atualizar-e-reiniciar).

## Desinstalar

Desinstalar não apaga os dados nem cancela nenhuma obrigação de seed no ASC. Antes de apagar qualquer coisa, veja se há seed pendente no painel e faça [backup](manutencao.md#backup-e-restauração) se precisar.

- **Linux:** `scripts/install.sh --uninstall` remove só o serviço. Na instalação remota, rode `DATA_DIR="$HOME/.local/share/ascstremio/data" ~/.local/share/ascstremio/app/scripts/install.sh --uninstall`. O código e os dados ficam em `~/.local/share/ascstremio`; apague essa pasta só se não precisar mais deles.
- **Docker / Podman:** `docker compose down` (ou `scripts/docker.sh stop`) para o contêiner e preserva o volume. Não use `-v`. O volume só sai com `docker volume rm ascstremio-data`, quando você tiver certeza.
- **Windows:** remova "Amigos Share · Stremio" em Configurações › Aplicativos. Os dados em `%LOCALAPPDATA%\AscStremio\data` ficam; apague a pasta à mão se quiser.
- Revogue as credenciais de reprodução que não for mais usar (Conta › Addons no painel, ou `credenciais revogar <id>`) e remova o addon no Stremio.

## Problemas na instalação

| Sintoma | O que fazer |
|---|---|
| `faltou o comando tar`, `curl` ou `sha256sum` | Instale o pacote correspondente do sistema e rode de novo |
| `SHA-256 não confere` ou `falha ao baixar o .sha256` | Nada foi instalado. Rode de novo; com repositório privado, use o download pelo `gh` descrito acima |
| A instalação falhou depois de trocar o código | A versão anterior fica em `~/.local/share/ascstremio/app.anterior`; renomeie-a de volta para `app` se quiser voltar |
| `EADDRINUSE` ou porta ocupada | Outra instância usa as portas 7000, 7010 ou 7020. Pare-a, ou use `--replace-manual` se for uma execução manual deste projeto |
| Node ausente ou antigo (Alpine/musl) | O Node oficial baixado pelo instalador não roda em musl: instale um Node 22+ compatível e use `--system-node`, ou use a imagem Docker |
| Sem `systemd --user` (WSL, contêiner) | O instalador instala e testa, mas não cria serviço; rode `npm start` na pasta do código com o `DATA_DIR` desejado |
| O serviço não sobe depois de reiniciar o computador | Veja o linger na saída do instalador; sem ele, o serviço só roda com você logado |

Para falhas depois de instalado, veja o [diagnóstico](manutencao.md#diagnóstico). Siga para [uso](uso.md).
