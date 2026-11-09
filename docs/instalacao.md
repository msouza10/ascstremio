# Instalação

O ASCStremio precisa de uma conta individual válida no ASC, acesso à internet, espaço para os vídeos e uma máquina que permaneça ligada para semear. O Stremio é instalado separadamente. O addon não cria uma conta no tracker.

## Escolha a instalação

| Plataforma | Caminho | Dados persistentes |
|---|---|---|
| Linux glibc | Script local ou pacote de release | `private/` na instalação pelo código; `~/.local/share/ascstremio/data` na instalação remota |
| Docker / Podman | Compose ou `scripts/docker.sh` | Volume em `/data` |
| Windows | `AscStremio-Setup-<versão>.exe` | `%LOCALAPPDATA%\AscStremio\data` |
| macOS / execução manual | Node.js 22+ e npm | `private/` na raiz do projeto |

Não use a mesma pasta de dados simultaneamente em duas instâncias. Não misture os volumes de instalações diferentes.

## Pelo código: Linux e macOS

Na pasta do repositório, com Node.js 22+ e npm:

```bash
npm ci
npm start
```

Mantenha o terminal aberto. `Ctrl+C` encerra o aplicativo e o seed. A retomada ocorre na próxima execução, mas o prazo no tracker continua correndo. O macOS usa execução manual ou contêiner; não há instalador nativo próprio.

## Linux com serviço de usuário

Na pasta do projeto:

```bash
scripts/install.sh --check
scripts/install.sh
```

`--check` confere sem instalar. O instalador executa as verificações e cria `ascstremio.service` quando há `systemd --user`; sem ele, mostra como executar manualmente. O script tenta habilitar o serviço no boot com linger. Consulte a saída para saber se isso funcionou na sua máquina.

Em Linux glibc x64, arm64 ou armv7, se faltar Node 22+, o script baixa o Node oficial e confere seu SHA-256. `--system-node` impede esse download. O binário oficial não serve para musl/Alpine; use um Node compatível ou a imagem do projeto.

| Opção | Uso |
|---|---|
| `--no-service` | Instala dependências e verifica sem criar serviço |
| `--system-node` | Exige Node compatível já instalado |
| `--replace-manual` | Encerra com SIGINT uma execução manual identificada deste projeto que esteja ocupando as portas |
| `--uninstall` | Remove o serviço, preservando os dados |

Estado e logs:

```bash
systemctl --user status ascstremio
journalctl --user -u ascstremio -f
```

Edite `service.env` dentro da pasta de dados e reinicie o serviço para mudar a configuração. Veja [manutenção](manutencao.md).

### Pacote Linux por URL

Use um pacote da [página de releases](https://github.com/msouza10/ascstremio/releases), quando disponível para sua conta. O instalador remoto é gerado junto do pacote; não há uma URL genérica de instalação garantida para qualquer release.

Para uma distribuição preparada pelo mantenedor, substitua `<URL-base>` pelo endereço que contém `install.sh`, `ascstremio-latest.tar.gz` e seu `.sha256`:

```bash
curl -fsSL <URL-base>/install.sh | bash
```

O código é instalado em `~/.local/share/ascstremio/app`; os dados ficam no diretório irmão `data`. O SHA-256 detecta corrupção, mas o hash servido pelo mesmo servidor não comprova a confiabilidade desse servidor. Leia o script e use uma origem confiável.

## Docker / Podman

Com um dos motores já instalado, execute na raiz do projeto:

```bash
scripts/docker.sh run
scripts/docker.sh passkey
```

O segundo comando recebe a passkey sem eco no terminal. Reinicie o contêiner com o comando indicado na saída. `CONTAINER_ENGINE=podman scripts/docker.sh run` escolhe explicitamente o Podman.

Alternativa com Compose:

```bash
docker compose up -d --build
```

**Os volumes têm nomes diferentes:** `scripts/docker.sh` usa `ascstremio-data`; o Compose normalmente acrescenta o nome do projeto ao volume. Não use `scripts/docker.sh passkey` para configurar um volume Compose sem confirmar que é o mesmo volume. Para Compose, uma opção é definir `PASSKEY` em um arquivo de ambiente local protegido e referenciá-la no `environment` do serviço. Nunca versione esse arquivo nem cole a credencial em comandos salvos; variáveis podem ser inspecionadas por quem controla o motor.

As portas HTTP 7000/7010/7020 são publicadas em `127.0.0.1` do host. A porta TCP 7030 de peers é publicada em todas as interfaces. Mantenha o painel e a administração locais; leia [segurança](seguranca.md) antes de mudar a rede.

O contêiner não impede o hospedeiro de suspender. Configure a energia do host conforme suas obrigações de seed.

## Windows

Execute `AscStremio-Setup-<versão>.exe` de uma distribuição confiável. Ele contém Node e dependências e instala por usuário, sem administrador, em `%LOCALAPPDATA%\Programs\AscStremio`.

O Menu Iniciar recebe atalhos para abrir o painel, parar o processo e abrir a pasta de dados. Um atalho na pasta Inicializar sobe o programa ao entrar no Windows. A máquina precisa continuar ligada e a sessão de usuário precisa permitir sua execução. A desinstalação mantém os dados.

O instalador não é assinado; o SmartScreen pode mostrar um aviso. A porta de peers pode provocar uma solicitação do firewall. Os serviços HTTP permanecem em loopback. O comando de parar encerra o processo à força; o cofre é salvo a cada minuto. A CI possui teste de instalação silenciosa e inicialização em Windows; isso não comprova compatibilidade de reprodução com todos os players e codecs.

## Passkey do tracker

A senha autentica a sessão do site; a **passkey** autentica os anúncios BitTorrent. Configure ambas para usar a integração completa. A passkey não é a chave `bridge-key` de reprodução, gerada pelo aplicativo.

Na execução manual ou serviço Linux, guarde sua passkey em `passkey.txt` dentro da pasta de dados, sem espaços extras. No Linux/macOS, uma forma de digitá-la sem incluí-la no histórico é:

```bash
mkdir -p private
chmod 700 private
read -r -s -p 'Passkey do ASC: ' asc_passkey; printf '\n'
(umask 077; printf '%s' "$asc_passkey" > private/passkey.txt)
unset asc_passkey
```

O exemplo é para Bash e para o `DATA_DIR` padrão do código. Em uma instalação remota ou Windows, use a pasta de dados correspondente. Nunca envie a passkey pelo chat ou por uma issue. No Windows, proteja o arquivo pelas permissões da conta de usuário.

`PASSKEY` no ambiente tem precedência sobre o arquivo. A limitação atual de `PASSKEY_FILE` está descrita em [configuração](configuracao.md#credenciais-e-caminhos).

## Primeiro acesso

1. Abra **http://127.0.0.1:7020/** e faça login no ASC. A senha é usada para entrar; a sessão é salva em disco.
2. Mantenha **somente freeleech** ativado até entender as regras de ratio e seed.
3. Instale **http://127.0.0.1:7000/manifest.json** no Stremio.
4. Confira os dados da conta no painel. Se ainda não foram lidos, não interprete a ausência de avisos como regularidade.

Siga para [uso](uso.md) ou [diagnóstico](manutencao.md#diagnóstico).
