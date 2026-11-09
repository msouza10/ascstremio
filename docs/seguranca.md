# Segurança e dados pessoais

A instalação é pessoal e local. Não publique addon, ponte ou painel na internet, nem compartilhe uma conta por um servidor. Os controles existentes reduzem riscos, mas não constituem uma auditoria completa.

## Portas e interfaces

| Serviço | Padrão nativo | Na imagem do projeto | Publicação padrão no host |
|---|---|---|---|
| Addon HTTP `7000` | `127.0.0.1` | `0.0.0.0` interno | `127.0.0.1:7000` |
| Ponte HTTP `7010` | `127.0.0.1` | `0.0.0.0` interno | `127.0.0.1:7010` |
| Painel HTTP `7020` | `127.0.0.1` | `0.0.0.0` interno | `127.0.0.1:7020` |
| Peers BitTorrent | Porta escolhida pelo sistema, recebimento em interfaces de rede | Porta `7030` | TCP `7030` em todas as interfaces, conforme firewall |

As portas podem mudar por configuração. A publicação TCP de peers é distinta dos endpoints HTTP e não fornece acesso direto ao painel. Remover a publicação de peers reduz a conectividade de entrada; não transforma o cliente em somente download. UPnP e NAT-PMP estão desligados: o aplicativo não abre portas no roteador automaticamente.

## Rede local e contêineres

`BRIDGE_ALLOW_LAN=1` faz addon e ponte nativos escutarem fora do loopback. O painel nativo continua em `127.0.0.1`. As URLs anunciadas precisam ser alcançáveis pelo aparelho com o Stremio; `BRIDGE_PUBLIC_URL` e `ADDON_PUBLIC_URL` ajustam essas referências, sem por si mesmas mudar a escuta. O endereço anunciado, a escuta e os hosts aceitos são independentes; `LAN_ADVERTISE_HOST`/`LAN_INTERFACE` escolhem o endereço e `npm run rede` o diagnostica (veja [configuração](configuracao.md#endereço-anunciado-na-lan)). Escolher um nome DNS inclui só esse nome entre os `Host` aceitos, sem curingas, e não abre o painel pela LAN.

O addon e as URLs de vídeo exigem uma credencial de instalação revogável (veja a próxima seção), mas não há autenticação de usuários nem TLS: o token trafega em HTTP na rede local. O catálogo de status, que expõe ratio, títulos e avisos, só é entregue a credenciais emitidas com `--status`. O link de abrir o painel no catálogo continua apontando para `127.0.0.1`; em uma TV ele aponta para a própria TV.

**Administração no contêiner:** endereço privado (RFC1918) não prova identidade, porque o gateway do Docker e qualquer outro contêiner da rede têm um. As rotas administrativas da ponte exigem, em qualquer modo, o token `X-Admin-Token` (`DATA_DIR/admin-key`), independente da chave de reprodução. Fora do contêiner exigem também origem em loopback. Quem alcança a ponte pela rede, mas não tem o token, recebe 403.

Ainda assim, mantenha as publicações HTTP no loopback do host e não conecte a instância a redes com contêineres não confiáveis: o token protege a administração, não o restante da ponte. Não exponha o painel para resolver o acesso de TV/celular.

## Credenciais de instalação do addon

Cada instalação do addon no Stremio (por exemplo, o computador e a TV) usa uma credencial própria, com nome e revogação individual. O modo local não muda de natureza: no mesmo computador, uma credencial só.

**Como funciona.** O Stremio não envia cabeçalhos de autenticação e só propaga a URL base do manifesto para catálogo, meta e stream; por isso o token vai no prefixo do caminho: `http://host:7000/<token>/manifest.json`. As URLs de vídeo que o addon devolve carregam o mesmo token em `?k=`. O token (`ascc_` + 256 bits aleatórios) aparece uma única vez, na emissão; em disco (`credentials.json`, 0600) fica só o SHA-256. Sem credencial ativa, o manifesto e todos os recursos dão 403.

**Emitir, listar, girar e revogar** (com o aplicativo em execução; usam o token administrativo de `admin-key`):

```bash
npm run credenciais -- garantir              # emite "Stremio local" só se não houver nenhuma ativa
npm run credenciais -- criar "TV da sala"    # outra instalação; --status libera o catálogo de status
npm run credenciais -- listar                # id, nome, estado e datas (nunca o token)
npm run credenciais -- rotacionar c_1a2b3c4d # emite outra igual e revoga a antiga
npm run credenciais -- revogar c_1a2b3c4d
```

A CLI nunca grava `credentials.json`: só o processo que detém a [trava da instância](configuracao.md) escreve nele, e a CLI apenas chama as rotas administrativas. Portas e URL do addon vêm da configuração central (ambiente > `settings.json` > padrão). No contêiner use `scripts/docker.sh credenciais ...`. O instalador Linux emite a primeira credencial ao final (a saída é do terminal, não do log do serviço). A emissão também existe como rota administrativa da ponte ([arquitetura](arquitetura.md#ponte-http)).

**O que a credencial dá e não dá.** Dá catálogo, metadados, fontes e vídeo. Não dá painel, configuração, logs, conta, nem rotas administrativas; o ratio e os avisos da conta só aparecem com `--status`, que é negado por padrão.

**Validade e revogação.** A credencial não expira sozinha: vale até ser revogada. A verificação ocorre em cada GET, HEAD e Range, então uma URL guardada em cache pelo player deixa de funcionar na hora da revogação. Respostas de vídeo já abertas dessa credencial são encerradas; o player pode tentar de novo e receberá 403. A revogação de uma credencial não afeta as outras, nem o seed em andamento.

**Limite do "por dispositivo".** O Stremio sincroniza addons entre os aparelhos da mesma conta: instalar a URL numa conta propaga o token a todos eles. A credencial identifica uma instalação do addon, não um hardware. Para separar aparelhos, use contas/perfis distintos no Stremio ou emita um token por instalação manual e revogue o que vazar.

**Vazamento.** Logs redigem `ascc_…` e `?k=`; o painel e as respostas públicas nunca trazem o token. Evite colar a URL em chats, issues ou capturas de tela.

**Migração.** A chave única antiga (`bridge-key`) e o manifesto sem prefixo deixam de funcionar. Emita uma credencial, remova o addon antigo no Stremio e instale a URL nova. Os dados e o seed não são afetados.

## Controles atuais

- Addon e ponte validam `Host`, aceitando IP literal, localhost e nomes explicitamente configurados. Isso combate DNS rebinding; não autentica o cliente.
- Todas as rotas do addon e `/a/…`, `/s/…` exigem uma credencial de instalação ativa (prefixo `/<token>/` no addon, `?k=<token>` no vídeo), verificada a cada pedido.
- As rotas administrativas da ponte exigem `X-Admin-Token`, recusam `Origin` e, fora do contêiner, só aceitam loopback. `POST /cleanup` não tem mais `force=1`.
- O painel exige `Host` exato `127.0.0.1:<CONFIG_PORT>`; ações POST também exigem origem exata, JSON e token CSRF. O token não é uma autenticação de usuário do sistema.
- DHT, LSD, PEX, UPnP e NAT-PMP estão desativados no motor da ponte.
- A imagem roda sem root; as invocações fornecidas usam sistema de arquivos somente leitura, `/tmp` temporário, capabilities removidas e `no-new-privileges`.

## Quais dados ficam no disco

| Dado | Local padrão em `DATA_DIR` | Cuidado |
|---|---|---|
| Sessão do site | `asc-session.json` | Cookies permitem acesso à conta; a senha do formulário não é persistida |
| Passkey | `passkey.txt` ou ambiente | Credencial do tracker; não compartilhar |
| Credenciais de reprodução | `credentials.json` | Só verificadores (SHA-256); o token não é recuperável. Mesmo assim, não publique |
| Chave única antiga | `bridge-key` | Obsoleta e ignorada; pode ser apagada |
| Token administrativo | `admin-key` | Dá acesso às rotas administrativas da ponte; nunca em URL, log ou captura |
| Obrigações de seed | `seed-vault.json` | Histórico local e referências a torrents |
| Metadados de fontes | `meta-cache.json` | Só nome, tamanho e selos de releases por filme; sem cookie, passkey, credencial, URL, seeders ou freeleech. Modo restrito, até 90 dias. Pode ser apagado |
| Biblioteca | `torrents/` | Metadados dos torrents; manter privados mesmo sanitizados |
| Arquivos recebidos | `cache/` | Conteúdo baixado e partes de vídeos |
| Logs | `logs/` | Eventos e identificadores podem revelar hábitos de uso |

A passkey é removida dos torrents obtidos pela integração e injetada no announce em memória. Isso não torna seguro publicar todo o diretório de dados ou torrents importados por outros meios. Arquivos sensíveis usam modos restritos em sistemas Unix; no Windows, a proteção depende também das permissões da conta e da pasta.

Não compartilhe URLs de instalação ou de reprodução, capturas com `/<token>/` ou `?k=`, cookies ou backups. Para invalidar uma credencial comprometida, use `revogar` ou `rotacionar` (próxima seção). O token administrativo é outra coisa e funciona assim: para trocá-lo, pare a instância, remova `admin-key` e reinicie; ferramentas que o usavam precisam ler o novo valor. Isso não revoga a passkey nem a sessão do ASC. Se estas vazarem, use os mecanismos do próprio tracker para revogá-las.

## Logs e publicação do código

O logger redige segredos conhecidos e padrões sensíveis antes de gravar, mas revise qualquer exportação antes de enviá-la. Títulos, info hashes, caminhos e horários continuam podendo ser pessoais.

A licença do código ([MIT](../LICENSE)) não dá acesso ao ASC nem direitos sobre conteúdo de terceiros.

`scripts/check-no-secrets.sh` verifica arquivos proibidos e padrões de credenciais na árvore/pacote. Ele não comprova ausência de segredos em todo o histórico; essa auditoria está na [issue #11](https://github.com/msouza10/ascstremio/issues/11). A documentação pública usa uma lista explícita de arquivos e mantém notas privadas fora dos pacotes.

## Relatar um problema

Para defeitos comuns, abra uma [issue](https://github.com/msouza10/ascstremio/issues) com versão, plataforma, forma de instalação, comportamento esperado e trecho de log revisado. Não anexe a pasta de dados nem `.torrent` reais.

Para vulnerabilidades, siga a [política de segurança](../.github/SECURITY.md), que define o relato privado pelo GitHub, escopo e prazo de primeira resposta. Não envie credenciais nem dados reais na reprodução. As limitações conhecidas são acompanhadas nas issues, sem promessa de correção já entregue.
