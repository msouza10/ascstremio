# AGENTS.md

Guia para agentes de código e para quem contribui. Leia antes de mexer. O `README.md` é a
documentação do usuário (instalação, uso, regras do tracker); este arquivo é o "como trabalhar aqui".

## O que é

**ascstremio**: addon do [Stremio](https://www.stremio.com/) para o tracker privado Amigos Share
(ASC). Lista fontes do tracker dentro do Stremio e toca o filme por uma **ponte** local que baixa o
`.torrent` real, anuncia só no tracker do ASC e serve o vídeo por HTTP (`Range`). Também monitora
a conta (ratio, hit-and-run, inatividade), cumpre a regra de seed e mostra tudo num painel web.

É um programa **pessoal, de uma pessoa por instalação**: usa a conta e a passkey de quem instalou
(regra 2.2 do ASC). Nunca o transforme em serviço compartilhado nem exponha à internet.

Node.js **22+** (CommonJS, sem build, sem TypeScript). Dependências de produção: `webtorrent`,
`parse-torrent`, `stremio-addon-sdk`, `tough-cookie`. Idioma do código, comentários, logs, UI e
commits em português do Brasil, com acentuação.

## Mapa do código

| Caminho | Papel |
|---|---|
| `src/index.js` | ponto de entrada: lê o ambiente, monta ponte, addon, painel e o vigia de hit-and-run |
| `src/bridge.js` | **ponte** (porta 7010): `/s/<hash>/<idx>` e `/a/<id>` (stream), rotas administrativas, seed e conclusão |
| `src/addon.js`, `src/asc-provider.js`, `src/providers/` | addon Stremio (porta 7000): catálogos, fontes sob demanda, nomes e selos |
| `src/asc-client.js` | cliente HTTP do site do ASC (login, cookies, busca, `.torrent`, atividade) |
| `src/config-server.js`, `src/ui/` | painel e login (porta 7020); UI em JS puro, sem framework |
| `src/seedvault.js`, `src/hnr-guard.js` | cofre de seed e conciliação com o tracker (o tracker sempre vence) |
| `src/safety.js` | loopback, `Host` anti-rebinding, modo contêiner, aviso de inatividade |
| `src/passkey.js` | passkey fora dos `.torrent` (injetada em memória) |
| `src/logger.js` | logs com redação de segredos, buffer, arquivos NDJSON, `/logs` |
| `src/keepawake.js` | bloqueia a suspensão enquanto há seed pendente (Linux, macOS, Windows) |
| `src/stremio-status.js` | catálogo "ASC — status" dentro do Stremio |
| `test/` | testes unitários (`node:test`), sem rede e sem dados reais |
| `scripts/` | instalação, release, fumaça, barreira de segredos, auditoria, checagem de commits |
| `windows/` | instalador NSIS e launcher do Windows |
| `.github/workflows/` | CI (`ci.yml`) e release (`release.yml`) |
| `Dockerfile`, `docker-compose.yml` | imagem e execução em contêiner |

Pastas **locais e não versionadas**: `private/` (dados da conta), `docs/` (notas do mantenedor e
captura do design do site), `tools/` (sondas que usam a conta real). Não dependa delas em código,
testes ou CI.

## Comandos

```bash
npm ci                    # dependências
npm start                 # roda (usa --max-http-header-size=65536, obrigatório: o ASC responde com cabeçalhos grandes)
npm run dev               # com --watch
npm run check             # sintaxe da UI + todos os testes (é o que o CI roda). Também: npm test
node --test test/seed-policy.test.js          # um arquivo só
DATA_DIR=/tmp/x PORT=18000 BRIDGE_PORT=18010 CONFIG_PORT=18020 npm start   # instância de teste sem tocar nos seus dados
scripts/install.sh [--check|--no-service|--uninstall]    # instalador Linux
scripts/docker.sh run|build|logs|passkey|save             # Docker/Podman
scripts/build-release.sh [--base-url URL] [--windows]     # gera dist/
scripts/smoke-install.sh dist && scripts/smoke-container.sh IMAGEM
scripts/check-no-secrets.sh .             # barreira de segredos (rode antes de todo commit)
node scripts/audit-check.js               # npm audit com exceções justificadas
shellcheck -S warning scripts/*.sh windows/build.sh && actionlint .github/workflows/*.yml
```

Portas: addon `7000`, ponte `7010`, painel `7020`, peers `TORRENT_PORT`. A porta do painel de fora
tem de ser igual à de dentro (ele confere `Host: 127.0.0.1:<CONFIG_PORT>`).

## Padrões de desenvolvimento

- **Sem dependências novas sem necessidade.** Cada uma entra no `npm audit` e no instalador do Windows.
- **Teste junto com a mudança.** Testes em `test/*.test.js` com `node:test` e `assert/strict`;
  nada de rede real, de `private/` ou de caminhos absolutos. Torrents e ASC são simulados.
- **Portável.** O código roda em Linux, Windows e contêiner (CI testa Ubuntu e Windows, Node 22 e 24).
  Use `path`, não concatene `/`; não assuma `chmod` (no Windows o modo de arquivo é ignorado: os
  testes de permissão `0600` só valem fora do Windows).
- **Fail-closed.** Quando faltar dado (sessão, tracker, ratio), recuse ou avise; nunca assuma "ok".
  O painel nunca diz "tudo em dia" sem ter lido a conta.
- **Estilo:** comentários em português explicando o *porquê* (muitas vezes citando a regra do
  ASC), sem comentar o óbvio; aspas simples, ponto e vírgula, `const`/`let`, funções pequenas.
  Acompanhe o estilo do arquivo que estiver editando.
- **Logs:** use `logger.child('tag')`; nunca registre passkey, cookie, senha ou a chave `?k=`. O
  `logger.addSecret()` redige valores conhecidos.
- **Shell:** `set -Eeuo pipefail`, passa no `shellcheck -S warning`, mensagens em português.
- **Nomes:** o projeto é `ascstremio` (serviço `ascstremio.service`, imagem `ghcr.io/<dono>/ascstremio`,
  variáveis `ASCSTREMIO_*`, `AscStremio` no Windows). `brazuka-asc` é o nome antigo e só aparece na
  migração do serviço em `scripts/install.sh` e no prefixo de logs antigos em `src/logger.js`.

## Invariantes de segurança (não quebre)

1. **Nada de dados da conta no git.** `private/`, `*.torrent`, passkey, cookies, cofre, logs e
   `bridge-key` ficam fora. O `.gitignore` ignora **por nome exato** (um `passkey*` já escondeu
   `src/passkey.js` por engano). `scripts/check-no-secrets.sh` roda no CI e antes de cada pacote.
2. **Escuta só em `127.0.0.1`** (`BRIDGE_ALLOW_LAN=1` é opt-in; no contêiner, a porta é publicada só
   em `127.0.0.1`). A ponte não tem autenticação de usuário.
3. **Anti DNS rebinding:** addon, ponte e painel recusam `Host` que não seja IP literal, `localhost`
   ou algo em `ALLOWED_HOSTS`/`BRIDGE_PUBLIC_URL`/`ADDON_PUBLIC_URL` (`safety.hostAllowed`).
4. **Chave nas URLs de stream** (`?k=`, `bridge-key` 0600): `/s/…` e `/a/…` sem ela dão 403. Impede
   que uma página web dispare download/snatch com a conta do usuário.
5. **Rotas administrativas** (`/cleanup`, `/status`, `/seed-status`, `/complete`): só da própria máquina
   e nunca com cabeçalho `Origin` (anti-CSRF). O painel exige token CSRF, `Origin` e `Host` exatos.
6. **Regras do ASC mandam:** 72 h de seed ou ratio 1.0 (13.1); 12 dias sem semear é hit-and-run (13.3);
   90 dias sem acessar o site é banimento (2.6). Não encerre seed nem apague arquivo antes de o
   **tracker** confirmar; `HEAD` nunca baixa nem anuncia; listar fontes não baixa `.torrent`.
7. **Contêiner:** sem root, `read_only`, `cap_drop: ALL`, `no-new-privileges`. `ASCSTREMIO_CONTAINER=1`
   só muda a interface de escuta; não afrouxe as outras proteções.

## Commits, versão e release

Os **títulos dos commits seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/)**
e *decidem a versão e o changelog*. Formato: `tipo(escopo opcional): descrição no imperativo, em português`.

| Tipo | Quando | Versão (hoje, em 0.x) | Changelog |
|---|---|---|---|
| `feat` | funcionalidade nova | menor (0.1.0 → 0.2.0) | Novidades |
| `fix` | correção de bug | correção (0.1.0 → 0.1.1) | Correções |
| `perf` | desempenho | correção | Desempenho |
| `security` | endurecimento/vulnerabilidade | correção | Segurança |
| `refactor` | reestruturação sem mudar comportamento | nenhuma | Refatoração |
| `docs` | README/AGENTS | nenhuma | Documentação |
| `build` | empacotamento, Docker, instalador | nenhuma | Build e empacotamento |
| `ci` | workflows e esteira | nenhuma | Esteira (CI/CD) |
| `test`, `chore`, `style` | testes, manutenção, formatação | nenhuma | oculto |

Quebra de compatibilidade: `feat!: …` ou rodapé `BREAKING CHANGE: …` (em 0.x sobe o menor; depois
da 1.0, o maior). Exemplos: `fix(bridge): recusa Host com nome DNS`, `feat: porta de peers fixa no contêiner`.

- **Autoria:** commits com o autor do dono do repositório (`msouza10`). Não reescreva histórico nem
  faça push forçado sem pedido explícito.
- **Nunca edite à mão** `CHANGELOG.md`, `.release-please-manifest.json` nem a `version` do `package.json`:
  o release-please cuida.
- Antes de commitar: `npm run check`, `scripts/check-no-secrets.sh .` e, se mexeu em scripts/workflows,
  `shellcheck` e `actionlint`. `scripts/check-commits.sh` confere os títulos (roda nos pull requests).
- Prefira commits pequenos e focados; um assunto por commit.

**Fluxo de release (automático):** a cada push na `main`, o *release-please* mantém um PR
`chore(main): release X.Y.Z` com `CHANGELOG.md` e versão nova. **Mergear esse PR lança a versão**: o
release nasce rascunho; a esteira testa, monta o pacote Linux (`ascstremio-X.Y.Z.tar.gz` +
`install.sh`), o instalador `AscStremio-Setup-X.Y.Z.exe` (instalado e iniciado num Windows real), gera
`SHA256SUMS` e atestado de procedência, publica a imagem no **GitHub Packages**
(`ghcr.io/<dono>/ascstremio`: `X.Y.Z`, `X.Y`, `latest`; amd64 e arm64) e só então publica o release.
Falhou algum passo = o release segue rascunho. Não crie tags à mão.

## CI (`.github/workflows/ci.yml`)

Em push e pull request: testes (Ubuntu e Windows × Node 22 e 24), `shellcheck`, `actionlint`,
barreira de segredos, auditoria de dependências, pacote Linux instalado sem Node no PATH, imagem
Docker com teste de fumaça, instalador Windows compilado e **instalado de verdade** num Windows. Nos
pull requests também confere os títulos dos commits. Todos precisam passar. Dependabot abre PRs de
dependências, actions e imagem base (não suba a imagem base além do Node 22 sem atualizar `engines`).

## Armadilhas conhecidas

- `npm start` precisa de `--max-http-header-size=65536` (use o script, não `node src/index.js` solto).
- Módulos nativos no Windows: `node-datachannel` baixa o binário na instalação (`windows/build.sh` usa
  `npm_config_platform=win32` e remove `.node` de outros sistemas). Não use `--ignore-scripts` ali.
- NSIS: todo `MessageBox` precisa de `/SD` (senão o desinstalador trava em modo silencioso).
- Scripts novos precisam do bit de execução no git (`git update-index --chmod=+x`).
- Teste de fumaça do contêiner e do instalador usam portas 17000–17020; não conflitam com o serviço
  do usuário (7000–7020).
- `release-please` só abre PR se o repositório permitir "Actions criarem pull requests".
- No Docker não há bloqueio de suspensão (é do hospedeiro) e o Windows encerra o processo à força ao
  parar: o cofre grava a cada minuto.

## Onde ler mais

- Uso, instalação, variáveis de ambiente, segurança: [`README.md`](README.md)
- Histórico de versões: [`CHANGELOG.md`](CHANGELOG.md)
- Stremio: [SDK de addons](https://github.com/Stremio/stremio-addon-sdk) ·
  [protocolo](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/README.md) ·
  [defineStreamHandler](https://stremio.github.io/stremio-addon-sdk/api/requests/defineStreamHandler.html)
- WebTorrent: [documentação da API](https://github.com/webtorrent/webtorrent/blob/master/docs/api.md)
- Conventional Commits: https://www.conventionalcommits.org/pt-br/ ·
  [release-please](https://github.com/googleapis/release-please) ·
  [configuração](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- GitHub: [Actions](https://docs.github.com/pt/actions) · [pacotes no GHCR](https://docs.github.com/pt/packages/working-with-a-github-packages-registry/working-with-the-container-registry) ·
  [atestados de procedência](https://docs.github.com/pt/actions/security-for-github-actions/using-artifact-attestations)
- Empacotamento: [NSIS](https://nsis.sourceforge.io/Docs/) · [Docker](https://docs.docker.com/reference/dockerfile/) ·
  [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) ·
  [Node.js 22](https://nodejs.org/docs/latest-v22.x/api/)
- Regras do tracker (§2.2 conta pessoal, §2.6 inatividade, §13 seed/hit-and-run): páginas "Regras" do
  próprio Amigos Share (exigem login); o resumo operacional está no `README.md`.
