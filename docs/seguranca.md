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

`BRIDGE_ALLOW_LAN=1` faz addon e ponte nativos escutarem fora do loopback. O painel nativo continua em `127.0.0.1`. As URLs anunciadas precisam ser alcançáveis pelo aparelho com o Stremio; `BRIDGE_PUBLIC_URL` e `ADDON_PUBLIC_URL` ajustam essas referências, sem por si mesmas mudar a escuta.

A chave de reprodução restringe o acesso ao vídeo, mas não há autenticação de usuários. O catálogo de status pode expor ratio, títulos e avisos na rede em que o addon estiver acessível. O link de abrir o painel no catálogo continua apontando para `127.0.0.1`; em uma TV ele aponta para a própria TV.

**Limitação atual do contêiner:** `isLoopbackAddress()` aceita qualquer IP RFC1918 como local. Isso amplia a confiança além do gateway do Docker. Clientes que alcancem diretamente a ponte na rede do contêiner, ou por uma publicação HTTP ampliada, podem acessar a administração sem uma credencial administrativa independente. A [issue #10](https://github.com/msouza10/ascstremio/issues/10) acompanha a correção.

Mantenha as publicações HTTP no loopback do host e não conecte a instância a redes com contêineres não confiáveis. A publicação em loopback não impede, sozinha, acesso direto entre contêineres que compartilhem uma rede. Não exponha o painel para resolver o acesso de TV/celular.

## Controles atuais

- Addon e ponte validam `Host`, aceitando IP literal, localhost e nomes explicitamente configurados. Isso combate DNS rebinding; não autentica o cliente.
- `/a/…` e `/s/…` exigem `?k=`, uma chave aleatória de 128 bits persistida em `DATA_DIR/bridge-key`.
- As rotas administrativas da ponte verificam o endereço de origem e recusam `Origin`; há a limitação de confiança no contêiner descrita acima.
- O painel exige `Host` exato `127.0.0.1:<CONFIG_PORT>`; ações POST também exigem origem exata, JSON e token CSRF. O token não é uma autenticação de usuário do sistema.
- DHT, LSD, PEX, UPnP e NAT-PMP estão desativados no motor da ponte.
- A imagem roda sem root; as invocações fornecidas usam sistema de arquivos somente leitura, `/tmp` temporário, capabilities removidas e `no-new-privileges`.

## Quais dados ficam no disco

| Dado | Local padrão em `DATA_DIR` | Cuidado |
|---|---|---|
| Sessão do site | `asc-session.json` | Cookies permitem acesso à conta; a senha do formulário não é persistida |
| Passkey | `passkey.txt` ou ambiente | Credencial do tracker; não compartilhar |
| Chave de reprodução | `bridge-key` | URLs com `?k=` dão acesso à ponte |
| Obrigações de seed | `seed-vault.json` | Histórico local e referências a torrents |
| Biblioteca | `torrents/` | Metadados dos torrents; manter privados mesmo sanitizados |
| Arquivos recebidos | `cache/` | Conteúdo baixado e partes de vídeos |
| Logs | `logs/` | Eventos e identificadores podem revelar hábitos de uso |

A passkey é removida dos torrents obtidos pela integração e injetada no announce em memória. Isso não torna seguro publicar todo o diretório de dados ou torrents importados por outros meios. Arquivos sensíveis usam modos restritos em sistemas Unix; no Windows, a proteção depende também das permissões da conta e da pasta.

Não compartilhe URLs de reprodução, capturas com `?k=`, cookies ou backups. A chave persiste após reiniciar. Para invalidar URLs de reprodução comprometidas: pare a instância, remova somente `bridge-key` da pasta de dados, reinicie e reabra as fontes no Stremio. A chave é recriada; URLs antigas deixam de funcionar. Isso não revoga a passkey nem a sessão do ASC. Se estas vazarem, use os mecanismos do próprio tracker para revogá-las.

## Logs e publicação do código

O logger redige segredos conhecidos e padrões sensíveis antes de gravar, mas revise qualquer exportação antes de enviá-la. Títulos, info hashes, caminhos e horários continuam podendo ser pessoais.

`scripts/check-no-secrets.sh` verifica arquivos proibidos e padrões de credenciais na árvore/pacote. Ele não comprova ausência de segredos em todo o histórico; essa auditoria está na [issue #11](https://github.com/msouza10/ascstremio/issues/11). A documentação pública usa uma lista explícita de arquivos e mantém notas privadas fora dos pacotes.

## Relatar um problema

Para defeitos comuns, abra uma [issue](https://github.com/msouza10/ascstremio/issues) com versão, plataforma, forma de instalação, comportamento esperado e trecho de log revisado. Não anexe a pasta de dados nem `.torrent` reais.

Para vulnerabilidades, siga a [política de segurança](../.github/SECURITY.md), que define o relato privado pelo GitHub, escopo e prazo de primeira resposta. Não envie credenciais nem dados reais na reprodução. As limitações conhecidas são acompanhadas nas issues, sem promessa de correção já entregue.
