# Segurança e dados pessoais

A instalação é pessoal e local. Não publique addon, ponte ou painel na internet, nem compartilhe uma conta por um servidor. Os controles existentes reduzem riscos, mas não constituem uma auditoria completa.

## Portas e interfaces

Esta é a tabela única de rede do projeto; os outros guias apontam para cá.

| Serviço | Modo nativo `local` (padrão) | Modo nativo `lan` | Contêiner (imagem e Compose do projeto) | Variáveis que mudam o comportamento |
|---|---|---|---|---|
| Addon HTTP `7000` | `127.0.0.1` | todas as interfaces | `0.0.0.0` interno; publicado em `127.0.0.1:7000` | `PORT`, `ASCSTREMIO_MODE` (ou `BRIDGE_ALLOW_LAN=1`), `ADDON_PUBLIC_URL`, `LAN_ADVERTISE_HOST`, `LAN_INTERFACE`, `ALLOWED_HOSTS` |
| Ponte HTTP `7010` (streaming e rotas administrativas) | `127.0.0.1` | todas as interfaces | `0.0.0.0` interno; publicada em `127.0.0.1:7010` | `BRIDGE_PORT`, `ASCSTREMIO_MODE` (ou `BRIDGE_ALLOW_LAN=1`), `BRIDGE_PUBLIC_URL`, `LAN_ADVERTISE_HOST`, `LAN_INTERFACE`, `ALLOWED_HOSTS` |
| Painel HTTP `7020` | `127.0.0.1` | `127.0.0.1`. Só com a [administração pela LAN](#administração-do-painel-pela-lan) (`CONFIG_ALLOW_LAN`) e em HTTP (`CONFIG_ADMIN_HTTP_CLEAR`), também em um IPv4 da LAN (`CONFIG_BIND_ADDRESS` ou o endereço anunciado). Com `CONFIG_PUBLIC_URL=https://…` (proxy no mesmo computador) continua só em `127.0.0.1` | `0.0.0.0` interno; publicado em `127.0.0.1:7020` (administração pela LAN não existe no contêiner) | `CONFIG_PORT`, `CONFIG_ALLOW_LAN`, `CONFIG_BIND_ADDRESS`, `CONFIG_PUBLIC_URL`, `CONFIG_ADMIN_HTTP_CLEAR` |
| Peers BitTorrent (TCP) | `TORRENT_PORT`; `0` (padrão) deixa o sistema escolher a cada partida | idem | `7030`; o Compose publica `7030:7030` em todas as interfaces do host, conforme o firewall | `TORRENT_PORT` |

Em modo LAN as URLs anunciadas ao Stremio vêm de `LAN_ADVERTISE_HOST`/`LAN_INTERFACE` (ou das URLs públicas explícitas); a escuta, o endereço anunciado e os `Host` aceitos são independentes. No contêiner a escuta interna em `0.0.0.0` é obrigatória para a publicação de portas funcionar; quem limita a exposição é a publicação em `127.0.0.1` do Compose.

As portas podem mudar por configuração. A publicação `7030:7030` abre uma porta TCP de peers em todas as interfaces do host; ela não é a API HTTP, não dá acesso ao addon, à ponte nem ao painel, e sua existência não é, por si, uma vulnerabilidade: é o recebimento de conexões BitTorrent de entrada, limitado pelo firewall e pelo roteador. Remover a publicação de peers reduz a conectividade de entrada; não transforma o cliente em somente download. UPnP e NAT-PMP estão desligados: o aplicativo não abre portas no roteador automaticamente. O diagnóstico `npm run rede -- peers` só prova o que o processo observa (escuta local e conexões de entrada recebidas); não testa alcance pela internet, não contata serviços externos e não vê firewall, roteador, CGNAT nem a publicação do contêiner. Abra, se quiser, somente a porta de peers; nunca addon, ponte ou painel.

## Rede local e contêineres

`BRIDGE_ALLOW_LAN=1` faz addon e ponte nativos escutarem fora do loopback. O painel nativo continua em `127.0.0.1`. As URLs anunciadas precisam ser alcançáveis pelo aparelho com o Stremio; `BRIDGE_PUBLIC_URL` e `ADDON_PUBLIC_URL` ajustam essas referências, sem por si mesmas mudar a escuta. O endereço anunciado, a escuta e os hosts aceitos são independentes; `LAN_ADVERTISE_HOST`/`LAN_INTERFACE` escolhem o endereço e `npm run rede` o diagnostica (veja [configuração](configuracao.md#endereço-anunciado-na-lan)). Escolher um nome DNS inclui só esse nome entre os `Host` aceitos, sem curingas, e não abre o painel pela LAN.

O addon e as URLs de vídeo exigem uma credencial de instalação revogável (veja a próxima seção), mas não há autenticação de usuários nem TLS: o token trafega em HTTP na rede local. O catálogo de status, que expõe ratio, títulos e avisos, só é entregue a credenciais emitidas com `--status`. O link de abrir o painel no catálogo continua apontando para `127.0.0.1`; em uma TV ele aponta para a própria TV.

**Administração no contêiner:** endereço privado (RFC1918) não prova identidade, porque o gateway do Docker e qualquer outro contêiner da rede têm um. As rotas administrativas da ponte exigem, em qualquer modo, o token `X-Admin-Token` (`DATA_DIR/admin-key`), independente da chave de reprodução. Fora do contêiner exigem também origem em loopback. Quem alcança a ponte pela rede, mas não tem o token, recebe 403.

Ainda assim, mantenha as publicações HTTP no loopback do host e não conecte a instância a redes com contêineres não confiáveis: o token protege a administração, não o restante da ponte. 
**TV e celular só precisam do streaming.** Para assistir em outro aparelho basta alcançar o addon (`7000`) e a ponte (`7010`) com uma credencial própria; o painel (`7020`) e a administração não são necessários e devem continuar locais. Não publique o painel nem ative a administração pela LAN para "resolver" a TV. Em instalação nativa use `ASCSTREMIO_MODE=lan` com `LAN_ADVERTISE_HOST` e uma credencial por aparelho. No contêiner o Compose publica só no loopback do host: trocar `127.0.0.1` por outro IP nas linhas 7000/7010 expõe a ponte, que não tem usuário nem TLS, a toda a rede desse IP, e exige informar `ADDON_PUBLIC_URL` e `BRIDGE_PUBLIC_URL`. Esse caminho não é isolado pelo programa (o token administrativo protege só as rotas administrativas) e só vale em rede doméstica confiável; nunca altere a linha do painel.

## Credenciais de instalação do addon

Cada instalação do addon no Stremio (por exemplo, o computador e a TV) usa uma credencial própria, com nome e revogação individual. O modo local não muda de natureza: no mesmo computador, uma credencial só.

**Como funciona.** O Stremio não envia cabeçalhos de autenticação e só propaga a URL base do manifesto para catálogo, meta e stream; por isso o token vai no prefixo do caminho: `http://host:7000/<token>/manifest.json`. As URLs de vídeo que o addon devolve carregam o mesmo token em `?k=`. O token (`ascc_` + 256 bits aleatórios) aparece uma única vez, na emissão; em disco (`credentials.json`, 0600) fica só o SHA-256. Sem credencial ativa, o manifesto e todos os recursos dão 403.

**Emitir, listar, girar e revogar** (com o aplicativo em execução; usam o token administrativo de `admin-key`; na instalação remota Linux, rode na pasta `~/.local/share/ascstremio/app` com `DATA_DIR="$HOME/.local/share/ascstremio/data"`, veja [instalação](instalacao.md#instalar-pelo-github-com-curl)):

```bash
npm run credenciais -- garantir              # emite "Stremio local" só se não houver nenhuma ativa
npm run credenciais -- criar "TV da sala"    # outra instalação; --status libera o catálogo de status
npm run credenciais -- listar                # id, nome, estado e datas (nunca o token)
npm run credenciais -- rotacionar c_1a2b3c4d # emite outra igual e revoga a antiga
npm run credenciais -- revogar c_1a2b3c4d
```

O painel (página Conta, aba Addons) também revoga: o botão **Revogar** pede confirmação na própria linha e vale na hora, igual à CLI. A rota do painel exige sessão do ASC, token CSRF, `Origin` e `Host` exatos. Quem usa a URL revogada perde o addon no Stremio.

A CLI nunca grava `credentials.json`: só o processo que detém a [trava da instância](configuracao.md) escreve nele, e a CLI apenas chama as rotas administrativas. Portas e URL do addon vêm da configuração central (ambiente > `settings.json` > padrão). No contêiner use `scripts/docker.sh credenciais ...`. O instalador Linux emite a primeira credencial ao final (a saída é do terminal, não do log do serviço). A emissão também existe como rota administrativa da ponte ([arquitetura](arquitetura.md#ponte-http)).

**O que a credencial dá e não dá.** Dá catálogo, metadados, fontes e vídeo. Não dá painel, configuração, logs, conta, nem rotas administrativas; o ratio e os avisos da conta só aparecem com `--status`, que é negado por padrão.

**Validade e revogação.** A credencial não expira sozinha: vale até ser revogada. A verificação ocorre em cada GET, HEAD e Range, então uma URL guardada em cache pelo player deixa de funcionar na hora da revogação. Respostas de vídeo já abertas dessa credencial são encerradas; o player pode tentar de novo e receberá 403. A revogação de uma credencial não afeta as outras, nem o seed em andamento.

**Substituição e último uso no painel.** Em Conta › Addons, “Substituir” emite uma credencial com o mesmo nome e permissão e revoga a antiga. Confirme a troca e instale a nova URL no Stremio: vídeos abertos com a antiga são interrompidos. A troca é gravada de uma vez; se a gravação falhar, a credencial antiga é preservada. O último uso mostra pedidos GET autenticados ao addon ou ao vídeo desde o início do serviço. Fica apenas em memória, sem tokens, IPs ou nomes de filmes; reiniciar o serviço apaga esses horários. HEAD e tentativas recusadas pela autenticação não contam. Sem registro não significa que a credencial nunca foi usada.

**Limite do "por dispositivo".** O Stremio sincroniza addons entre os aparelhos da mesma conta: instalar a URL numa conta propaga o token a todos eles. A credencial identifica uma instalação do addon, não um hardware. Para separar aparelhos, use contas/perfis distintos no Stremio ou emita um token por instalação manual e revogue o que vazar.

**Vazamento.** Logs redigem `ascc_…` e `?k=`; o painel e as respostas públicas nunca trazem o token. O `?k=` é uma credencial reutilizável, não um identificador de sessão: quem tiver a URL de reprodução, de uma captura de tela ou de um diagnóstico assiste com a sua instalação até a revogação. Não compartilhe essas URLs. O programa não pressupõe que o player aceite cabeçalhos de autenticação (o Stremio não os envia), por isso a chave viaja na URL. **Perdeu ou vazou a URL:** o token não é recuperável; rode `npm run credenciais -- rotacionar <id>` (emite outra e revoga a antiga) ou `revogar` e `criar`, e reinstale a URL nova no Stremio; o painel também emite credenciais.

**Limite de reproduções.** A quota opcional de reproduções simultâneas (`PLAYBACK_MAX_SESSIONS`, `PLAYBACK_MAX_PER_CREDENTIAL`) é contada por credencial, nunca por IP, e é verificada depois da credencial e antes de qualquer download. O diagnóstico (`GET /playback`) é administrativo e traz só contagens; um aparelho não consulta o histórico de outro. Detalhes em [configuração](configuracao.md#reproduções-simultâneas).

## Administração do painel pela LAN

Opcional, desligada por padrão e **separada** da reprodução na LAN (`ASCSTREMIO_MODE=lan` sozinho não abre o painel). Habilitação e uso: [configuração](configuracao.md#administração-do-painel-pela-lan).

**Três credenciais distintas, com ciclos de vida distintos:** (1) o login do ASC só confirma a conta no tracker e **não autentica** quem fala com este computador; (2) a credencial de instalação do addon dá reprodução e nunca administração; (3) a senha de administração do painel vale só para o painel. O token administrativo da ponte (`admin-key`) nunca é entregue ao navegador e não vale no painel.

**O que muda quando está ativa.** Todas as rotas `/api/*` (inclusive logs, status, configurações, login do ASC e ações), pelo endereço da LAN **e** por `127.0.0.1`, exigem uma sessão de administração. Ficam públicos apenas o shell estático da interface, `/config.js` (só um token de pré-login) e `GET /api/admin/session` (que diz se há sessão). O painel não tem rotas da ponte: `/s/…`, `/a/…`, `/cleanup`, `/credentials`, `/complete` etc. dão 404 por esse caminho, com ou sem sessão.

**Controles.**
- Sessão: identificador aleatório de 256 bits em cookie `HttpOnly; SameSite=Strict; Path=/` (em HTTPS, `__Host-…; Secure`), guardada só em memória (indexada por SHA-256). Inatividade (padrão 30 min) e limite absoluto (12 h) são relógios separados; o id é rotacionado a cada 15 min (o anterior vale 15 s para requisições paralelas) e é sempre novo no login (sem fixação). Fica presa ao `Host` do login. Logout, troca de senha, `revogar-sessoes`, remoção da senha e reinício a encerram.
- Senha: mínimo de 12 caracteres, scrypt (N=32768) com sal, comparação em tempo constante, arquivo `panel-admin.json` 0600; nunca em log, URL ou resposta. A resposta de erro é genérica (`Senha incorreta.`).
- Tentativas: 5 erros por minuto por origem do socket (nunca de cabeçalho encaminhado) e 30 globais; excedido, `429` com `Retry-After`, inclusive para a senha certa. Atraso fixo após erro e no máximo 2 verificações scrypt simultâneas. Não há bloqueio permanente.
- `Host` exato (`<LAN_ADVERTISE_HOST>:<CONFIG_PORT>` ou o host de `CONFIG_PUBLIC_URL`), sem curinga, e `Origin` exata derivada dele; fora disso, `403`. Isso cobre DNS rebinding para o endereço da LAN. O login exige ainda `Origin`, JSON e o token de pré-login (login-CSRF); as demais ações exigem o CSRF **da sessão**.
- O painel só escuta no IPv4 da LAN escolhido (nunca `0.0.0.0`) mais o loopback. Fora do contêiner apenas.

**Transporte e limites honestos.**
- Sem `CONFIG_PUBLIC_URL`, a senha e o cookie trafegam em **HTTP sem criptografia**. Quem vê o tráfego da rede (Wi-Fi compartilhado, aparelho comprometido, ARP spoofing) lê ambos e passa a administrar o host. Por isso o modo exige o aceite explícito `CONFIG_ADMIN_HTTP_CLEAR=true` e o programa não promete nada além de "rede doméstica confiável".
- A opção recomendada é um **proxy reverso com HTTPS no mesmo computador** (Caddy, nginx; certificado de CA local ou de um nome seu) e `CONFIG_PUBLIC_URL=https://…`. O programa não implementa TLS. O proxy deve repassar o `Host` original e conectar a `127.0.0.1:<CONFIG_PORT>`. Cabeçalhos `X-Forwarded-*`/`Forwarded` **nunca** são lidos; a origem pública vem só da configuração. Nesse modo o painel recusa conexões que não venham do loopback; mas, como todos os clientes chegam pelo proxy, o limite de tentativas por origem vira praticamente global.
- Cookies não isolam portas: outro serviço no mesmo host em outra porta recebe o cookie de sessão (ele é `HttpOnly`, mas é enviado). Não rode serviços não confiáveis no mesmo nome.
- Quem tem acesso ao terminal do host (ou ao `DATA_DIR`) administra de qualquer jeito; a senha protege contra a rede, não contra o dono da máquina.
- Um vizinho da rede pode provocar `429` e atrasar o login do dono por até um minuto (negação de serviço breve, não acesso).
- Não expõe à internet: não encaminhe portas nem publique o proxy fora da LAN/VPN pessoal. Não há suporte a hospedagem pública.

## Alertas por webhook

Modelo de ameaça: o operador escolhe o destino; o risco é o aplicativo ser induzido a falar com a rede interna (SSRF) ou a vazar dados da conta.

- A URL do destino é segredo (pode conter token). Fica no ambiente ou em `alert-webhook.json` (0600, fora do controle de versão); não vai ao `settings.json`, ao painel, à CLI, a respostas nem a logs, e é registrada no redator de logs. Erros viram códigos fixos (por exemplo "tempo esgotado"); o corpo da resposta do destino é lido até 4 KiB e nunca registrado.
- Só `http`/`https`, sem usuário, sem fragmento, com host em `ALERT_WEBHOOK_ALLOWED_HOSTS`. Loopback, link-local, metadata de nuvem, multicast, reservados e o próprio addon/ponte/painel são sempre recusados. Rede privada exige `ALERT_WEBHOOK_ALLOW_PRIVATE`; `http://` só vale para rede privada.
- O endereço é validado no momento da conexão (todos os endereços do nome precisam passar), contra DNS rebinding. Sem redirecionamentos, sem cookies, sem proxy do ambiente, timeout de 5 s.
- O conteúdo é texto fixo mais contador. Nunca passkey, cookies, tokens, caminhos, títulos, hashes, ratio ou URLs.
- Configurar e testar só pelo painel local (Host, Origin, CSRF e sessão do ASC) ou pela CLI no host. A falha do destino não interrompe seed, reprodução nem conciliação.
- Limitação: a mensagem atravessa a internet com o sigilo do TLS do destino; o texto genérico reduz o que um destino comprometido aprende.

## Controles atuais

- Addon e ponte validam `Host`, aceitando IP literal, localhost e nomes explicitamente configurados. Isso combate DNS rebinding; não autentica o cliente.
- Todas as rotas do addon e `/a/…`, `/s/…` exigem uma credencial de instalação ativa (prefixo `/<token>/` no addon, `?k=<token>` no vídeo), verificada a cada pedido.
- As rotas administrativas da ponte exigem `X-Admin-Token`, recusam `Origin` e, fora do contêiner, só aceitam loopback.
- O painel exige `Host` exato `127.0.0.1:<CONFIG_PORT>`; ações POST também exigem origem exata, JSON e token CSRF. O token não é uma autenticação de usuário do sistema.
- As rotas de configuração do painel (`/api/settings`, `/api/settings/preview`, `/api/wizard/*`, `/api/credentials`) exigem sessão do ASC confirmada além das proteções acima, não existem na ponte e escrevem pelo único escritor do processo, que recusa a alteração se o arquivo mudou desde a leitura. Segredos (passkey, `ANNOUNCE_BASE`, token administrativo) nunca saem: só "definido". O único segredo devolvido é o token de uma credencial recém-emitida, na resposta da emissão, uma vez, e ele é redigido nos logs. Por padrão o painel continua só em loopback; a administração pela LAN é um opt-in separado (seção própria).
- DHT, LSD, PEX, UPnP e NAT-PMP estão desativados no motor da ponte.
- A imagem roda sem root; as invocações fornecidas usam sistema de arquivos somente leitura, `/tmp` temporário, capabilities removidas e `no-new-privileges`.

## Quais dados ficam no disco

| Dado | Local padrão em `DATA_DIR` | Cuidado |
|---|---|---|
| Sessão do site | `asc-session.json` | Cookies permitem acesso à conta; a senha do formulário não é persistida |
| Passkey | `passkey.txt` ou ambiente | Credencial do tracker; não compartilhar |
| Credenciais de reprodução | `credentials.json` | Só verificadores (SHA-256); o token não é recuperável. Mesmo assim, não publique |
| Chave única antiga | `bridge-key` | Obsoleta e ignorada; pode ser apagada |
| Senha de administração do painel | `panel-admin.json` | Só verificador scrypt com sal (0600); a senha não é recuperável. Quem o copia pode tentar força bruta offline: use senha longa |
| Token administrativo | `admin-key` | Dá acesso às rotas administrativas da ponte; nunca em URL, log ou captura |
| Obrigações de seed | `seed-vault.json` | Histórico local e referências a torrents |
| Metadados de fontes | `meta-cache.json` | Só nome, tamanho e selos de releases por filme; sem cookie, passkey, credencial, URL, seeders ou freeleech. Modo restrito, até 90 dias. Pode ser apagado |
| Biblioteca | `torrents/` | Arquivos `.torrent` recebidos do ASC; podem conter a passkey no announce e não devem ser compartilhados |
| Arquivos recebidos | `cache/` | Conteúdo baixado e partes de vídeos |
| Logs | `logs/` | Eventos e identificadores podem revelar hábitos de uso |

Os `.torrent` obtidos pela integração são salvos como recebidos do ASC e podem conter a passkey no announce. Configurar `PASSKEY` ou `passkey.txt` permite montar o announce do motor em memória, mas não remove a credencial dos arquivos salvos. Trate todos os `.torrent` como pessoais, inclusive os importados por outros meios; não publique a pasta de torrents nem backups dos dados. Os `.torrent` baixados pela integração são gravados com permissão `0600` em sistemas Unix (leitura e escrita somente pelo usuário); no Windows, a proteção depende também das permissões da conta e da pasta.

Não compartilhe URLs de instalação ou de reprodução, capturas com `/<token>/` ou `?k=`, cookies ou backups. Para invalidar uma credencial comprometida, use `revogar` ou `rotacionar` (próxima seção). O token administrativo é outra coisa e funciona assim: para trocá-lo, pare a instância, remova `admin-key` e reinicie; ferramentas que o usavam precisam ler o novo valor. Isso não revoga a passkey nem a sessão do ASC. Se estas vazarem, use os mecanismos do próprio tracker para revogá-las.

## Publicar o código não é expor a aplicação

Publicar o repositório, os releases e a imagem (GitHub, GHCR) distribui o **programa**. Isso não autoriza nem recomenda hospedar uma instância na internet: cada instalação usa a conta e a passkey de uma pessoa, em uma máquina dela, e não deve virar serviço compartilhado nem receber tráfego externo (regra 2.2 do ASC). Não há suporte a VPS, túnel público, encaminhamento de portas nem proxy aberto. O proxy HTTPS citado na administração pela LAN é um recurso para a rede doméstica, no mesmo computador, e não uma forma de hospedagem remota.

## Logs e publicação do código

O logger redige segredos conhecidos e padrões sensíveis antes de gravar, mas revise qualquer exportação antes de enviá-la. Títulos, info hashes, caminhos e horários continuam podendo ser pessoais.

A licença do código ([MIT](../LICENSE)) não dá acesso ao ASC nem direitos sobre conteúdo de terceiros.

`scripts/check-no-secrets.sh` verifica arquivos proibidos e padrões de credenciais na árvore/pacote. Ele não comprova ausência de segredos em todo o histórico; essa auditoria ainda não foi feita. A documentação pública usa uma lista explícita de arquivos e mantém notas privadas fora dos pacotes.

## Relatar um problema

Para defeitos comuns, abra uma [issue](https://github.com/msouza10/ascstremio/issues) com versão, plataforma, forma de instalação, comportamento esperado e trecho de log revisado. Não anexe a pasta de dados nem `.torrent` reais.

Para vulnerabilidades, siga a [política de segurança](../.github/SECURITY.md), que define o relato privado pelo GitHub, o escopo e o que esperar de resposta (melhor esforço, sem prazo garantido). Não envie credenciais nem dados reais na reprodução.