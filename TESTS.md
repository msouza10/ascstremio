# Mapa de testes

Inventário inicial em 17/11/2026, agrupado por suíte. O foco desta entrega é a
[issue #144](https://github.com/msouza10/ascstremio/issues/144): começar pela
interface consumida pelo Stremio sem login em qualquer serviço externo.

**Objetivo do usuário:** testar o Stremio instalado de verdade, sem entrar na conta
pessoal do Stremio nem fazer login no painel/ASC. A suíte HTTP é apoio, não substitui
o teste do aplicativo real.

## Player instalado: primeira sonda executável

Execute `npm run smoke:stremio:linux` em sessão gráfica Linux, com o Flatpak
`com.stremio.Stremio` instalado e suas dependências Node já disponíveis (`npm ci`).
Feche o Stremio antes: a sonda recusa uma instância existente para não compartilhar
o perfil ou interromper reprodução pessoal. Não exige login em serviço algum.

O comando gera um vídeo sintético de 60 segundos usando o ffmpeg do próprio
Flatpak, abre o Stremio instalado com perfil temporário e usa o player nativo
libmpv. O áudio do vídeo fica mudo. Consulta manifesto, catálogo, meta e stream
do addon real com provedor sintético; o vídeo passa pelo HTTP real da Bridge.
Somente o motor torrent é substituído por leitura do arquivo sintético.

**Limite:** a página de controle de teste substitui a interface web normal via
`--url`. Portanto esta etapa prova o player do aplicativo instalado e a integração
com a ponte, mas não a instalação do addon, navegação, seleção de fonte, controles
visuais, legendas ou próximo episódio pela interface oficial. Não chamar esta
sonda de E2E completo do Stremio. O próximo incremento é controlar a UI oficial
em perfil convidado e reutilizar as evidências do player.

O cliente medido foi Stremio Linux 1.2.2, Flatpak commit
`0496ce1d6d44ee462182b8779a6ff475bf58b2e77a48a528b5542a44fab7ae6c`.
Ele usa GTK/WebKit, não Qt. A integração foi estudada no
[código oficial v1.2.2](https://github.com/Stremio/stremio-linux-shell/tree/2f6efc2252780c8f22a6997b94081d258d81c876/src/app/ipc).
As mensagens IPC são internas, sem garantia de compatibilidade com outras versões;
Windows e o shell Qt antigo exigem adaptadores separados, ainda não implementados.

O isolamento precisa definir HOME e XDG_DATA_HOME/CONFIG_HOME/CACHE_HOME **dentro**
do sandbox, por `--command=env`: nesta instalação, Flatpak sobrescreve XDG_*
recebidos por `--env`. GSettings usa backend em memória. O encerramento usa o ID
da instância criada (`--instance-id-fd`), nunca encerra pelo ID global do aplicativo.

Evidência obtida em 17/11/2026, Linux: contrato consultado; posição avançou a
2,04 s com vídeo 640 pixels; pausa confirmada e posição estável por 1,5 s; retomada
até 3,08 s; seek nativo a 30 s; ponte respondeu GET Range com 206. Sem erros do
player. Seek pode ser atendido pelo buffer: não exigir nova requisição Range para
considerar salto do player. O relatório JSON não contém credenciais ou URL do vídeo.

O runner tem timeout, exit code de falha e saída sanitizada. A verificação por IPC
confirma propriedades e avanço do player; não compara pixels da tela nem garante
reprodução por hardware. A sonda é sob demanda e fica fora do `npm run check`/CI
comum, pois exige Flatpak, sessão gráfica e capacidade de decodificação.

| ID | Estado | Comportamento | Evidência |
|---|---|---|---|
| TEST-STREMIO-008 | covered (Linux 1.2.2) | Player nativo consome ponte, avança, pausa, retoma e faz seek sem conta | `scripts/stremio-linux-smoke.js`, `scripts/stremio-player-smoke.js`; `npm run smoke:stremio:linux`, exit 0 |
| TEST-STREMIO-009 | missing | Instalar addon e selecionar vídeo pela UI oficial convidada | Sem evidência automatizada; navegação convidada observada, automação de foco Flatpak/Wayland limitada |

## Execução e limites

`npm run check`/`npm test` executam a sintaxe da UI, os arquivos `test/*.test.js`
e, no Linux, a suíte da interface oficial em `test/integration/stremio/`.
`npm run check:unit` é a entrada explícita sem aplicativo gráfico; não substitui
a verificação completa antes de entregar mudanças no cliente Linux.
Os testes usam Node 22+, diretórios temporários e fixtures. A credencial de
instalação do ascstremio é gerada localmente: não exige conta Stremio nem ASC.
HTTP dos testes rápidos escuta em `127.0.0.1`, com porta dinâmica; o cenário LAN
abre addon/ponte em interfaces externas somente durante a execução, com credencial efêmera.

A nova suíte roda também com `node --test test/stremio-protocol.test.js`.
Ela usa addon, autenticação e roteador do SDK reais; simula somente a descoberta
remota. Não inicia o aplicativo Stremio, não segue a URL fictícia de vídeo e não
prova reprodução visual. A composição do servidor está em `src/addon-server.js`,
compartilhada com os testes, incluindo a validação de Host.

## Matriz de funcionalidades e regressões no Stremio real

O mapa abaixo define onde integrar testes para proteger funcionalidades. A
execução dos cenários 010–012 está detalhada a seguir; os demais são planejamento.
A referência do bug de rede é a
[issue #120](https://github.com/msouza10/ascstremio/issues/120), encerrada no GitHub.
O cenário protege contra recorrência e deve reproduzir o modo de falha antes de
receber o rótulo de regressão coberta.

Regra para esta suíte: configurar entradas e estado sintéticos, executar a lógica
de produção, observar o consumidor instalado e conferir efeitos na ponte. Não
codificar manualmente na fixture o resultado que queremos verificar. A página
de controle da primeira sonda continua útil para player/ponte, mas não comprova
nenhuma asserção visual desta matriz.

| Prioridade / ID | Funcionalidade e entrada controlada | Código a exercitar | Resultado observável no Stremio e evidência complementar |
|---|---|---|---|
| P0 / TEST-STREMIO-010 | LAN: modo LAN e IPv4 real da interface escolhida | `src/settings.js`, `src/network.js` (`evaluate`), montagem de servidores em `src/index.js`, URLs em `src/bridge.js` | Manifesto instalado pelo IPv4 LAN; catálogo abre, fonte usa esse host e porta, player avança; registrar Host e destinos sanitizados, sem URL montada à mão pela fixture |
| P0 / TEST-STREMIO-011 | Catálogo com títulos de fixture distintos, busca e lista vazia | handlers de `src/addon.js`, catálogo/normalização em `src/asc-provider.js` com cliente ASC falso | Títulos esperados aparecem; busca exclui os demais; nenhum resultado antigo reaparece após atualização; nomes/campos conferidos pela árvore/DOM da UI, não apenas pelo JSON |
| P0 / TEST-STREMIO-012 | Fonte de filme com resolução, tamanho e selos conhecidos | `src/asc-provider.js`, `src/providers/`, handler stream de `src/addon.js` | Nome, descrição e selos exibidos correspondem à fixture; selecionar fonte toca o vídeo esperado na ponte. Provedor e formatação de produção, não stream pré-formatado pela fixture |
| P0 / TEST-STREMIO-013 | Pack com S01E01/S01E02 em ordem de arquivos embaralhada | `src/episodes.js`, `src/asc-provider.js`, `src/addon.js`, rota `/e/` em `src/bridge.js` | Escolher E02 toca vídeo E02, distinguível por padrão visual/metadata; conferir índice/resolvedor e posição do player. Dois vídeos diferentes, não a mesma URL para ambos |
| P0 / TEST-STREMIO-014 | Revogar credencial durante reprodução e tentar reabrir | `src/credentials.js`, `src/addon-auth.js`, sessões em `src/bridge.js` | Conexão é encerrada; novo acesso negado. Player pode continuar pelo buffer por algum tempo: assertar o bloqueio na ponte imediatamente e a falha observável no cliente com prazo documentado |
| P1 / TEST-STREMIO-015 | Status: conta desconhecida, alerta e estado regular simulados | `src/stremio-status.js`, `src/addon.js`, permissão em `src/addon-auth.js` | Catálogo/pôster/aviso correspondem a cada estado; sem dados não aparece “tudo em dia”; credencial sem permissão não recebe status. Não consultar conta real |
| P1 / TEST-STREMIO-016 | ASC indisponível com arquivo local completo e outro parcial | fallback em `src/asc-provider.js`, estado em `src/file-state.js`, handlers em `src/addon.js` | Aviso visível, fonte completa reproduz, parcial não é prometido como offline completo; nenhum login, consulta ou download real disparado |
| P1 / TEST-STREMIO-017 | Arquivo removido e catálogo local atualizado | `localEntries` em `src/index.js`, biblioteca e handlers em `src/addon.js` | Após atualização/reentrada, item removido some; item disponível permanece. Contabilizar cache do cliente para não confundir estado antigo com erro do servidor |
| P1 / TEST-STREMIO-018 | Busca ou descoberta sem resultado, erro e timeout simulados | `src/asc-provider.js`, handler de `src/addon.js`, resposta da ponte | Mensagem correta e recuperação após restaurar fixture; nenhum vídeo errado toca; servidor não fica preso. Timeout externo e sessão expirada são cenários diferentes |
| P1 / TEST-STREMIO-019 | Próximo episódio, filename e bingeGroup | hints em `src/asc-provider.js`/`src/addon.js`, resolução em `src/bridge.js` | UI oferece/seleciona próximo episódio e toca E03 correto. Verificar comportamento real dos hints por versão do Stremio; não deduzir sucesso da presença do campo |
| P2 / TEST-STREMIO-020 | Legenda associada ao episódio | seleção/associação de arquivos e mecanismo de legendas efetivamente suportado | Legenda de E02 aparece no seletor e no tempo esperado, sem legenda de E01. Levantar primeiro qual integração o addon expõe; não assumir suporte por existir SRT no disco |

Os IDs 010–012 têm cobertura inicial no cliente Linux instalado, nos limites
abaixo. Os IDs 013–020 continuam `missing`. Propósitos: proteção do caminho
crítico e de regressão; níveis: integração de serviços e E2E do consumidor real.
Fixtures podem simular conta/ASC, disponibilidade, metadados e motor; o cliente
Stremio, a serialização do SDK, a autenticação e a ponte usados no cenário devem
ser reais. Asserções visuais exigem a UI oficial, além das sondagens HTTP/IPC.

### O que o teste LAN no mesmo computador consegue provar

O Stremio instalado pode acessar o IPv4 LAN deste computador, em vez de
`127.0.0.1`. Isso cobre seleção do endereço anunciado, bind do servidor, portas,
Host/anti-rebinding, prefixo autenticado, URLs absolutas de fonte/pôster e consumo
do vídeo por esse endereço. É uma integração de LAN no próprio host.

Isso **não prova alcance a partir de outro aparelho**: o caminho pode não passar
pelo enlace físico e pelas mesmas regras de firewall de entrada; isolamento Wi-Fi,
roteador, resolução DNS remota e firewall do Windows exigem outra origem.
Para a etapa seguinte, um cliente em namespace/VM com rede e origem distintas pode
testar mais da fronteira, ainda sem provar todas as condições do Wi-Fi doméstico.
O aceite completo de #120 inclui reprodução em segundo aparelho: manter essa
evidência separada. Não expor a instalação pessoal nem abrir firewall global para
executar o teste; usar instância temporária, portas próprias e credencial efêmera.

Testar ainda a variante negativa: em modo local, a mesma instância não deve
ficar acessível pelo IPv4 LAN. Outra asserção: habilitar LAN para addon/ponte não
deve publicar o painel. Sem necessidade de fazer login no painel: verificam-se
bind e recusa das rotas, com configuração fornecida antes da partida.

### Onde colocar e como executar

- `test/stremio-protocol.test.js`: integração HTTP rápida, SDK real, sem aplicativo.
  Complementar com fluxo local e casos de segurança; permanece no `npm run check`.
- `test/network.test.js` e suítes de provedor/status/séries: proteger decisões e
  transformações isoladas. Reutilizar regras/fixtures, evitando duplicar testes.
- `scripts/stremio-player-smoke.js`: fixture atual de addon/ponte e observação IPC;
  extrair a montagem reutilizável quando a segunda suíte precisar dela.
- `scripts/stremio-linux-smoke.js`: adaptador atual de instalação, perfil e ciclo
  de vida. Evoluir o launcher para escolher player-smoke ou UI oficial.
- `test/integration/stremio/`: cenários do cliente real; o runner comum os executa
  no Linux, e `npm run test:stremio:linux` permite rodá-los isoladamente.
- CI: serviços/HTTP em Ubuntu e Windows nos jobs normais; cliente instalado em
  job gráfico próprio com versão fixada e relatório dos testes. A configuração
  está em `.github/workflows/stremio-tests.yml`, reutilizada por CI e release.

Antes de ampliar a suíte, extrair uma montagem de servidor com dependências
injetadas do trecho de `src/index.js` que monta addon/ponte/rede. Produção e fixture
devem chamar a mesma fábrica, mantendo Host, bind e URLs reais. Iniciar o entrypoint
completo atual também sobe vigias/serviços: não usar dados ou processo pessoais.

### Evidência necessária para aprovar cada cenário

Registrar versão do cliente e do projeto, configuração sanitizada, fixture/estado,
pedidos de recurso observados, texto/estado da UI oficial e efeito correspondente
na ponte/player. Usar ID aleatório por execução para correlacionar eventos, nunca
token como identificador público. Não depender somente de screenshot, HTTP 200 ou
comando de abertura aceito. Para regressão, introduzir/reproduzir a falha original
de forma controlada e confirmar que a asserção relevante falha.

### Execução implementada: UI oficial Linux, LAN e transporte

`npm run test:stremio:linux` executa
`test/integration/stremio/ui.test.js` pelo `node:test`. Requer sessão gráfica,
Flatpak Stremio instalado, dependências Node e acesso à interface web pública do
Stremio (carregamento normal do app). Não requer conta, login no painel ou ASC.
Recusa instância Stremio existente; cria perfil e credencial descartáveis e termina
somente a instância iniciada. O vídeo é gerado pelo ffmpeg do Flatpak, sem áudio.

A suíte usa `WEBKIT_INSPECTOR_HTTP_SERVER` em loopback e porta temporária para
acionar controles DOM da **interface oficial**. Nenhuma página de controle substitui
a UI nesta suíte. A comunicação é WebKit Inspector, não CDP. Usa-se o código de
inspeção em `scripts/stremio-webkit.js`; não há dependência nova.

| ID | Evidência executada em 17/11/2026 | Limite |
|---|---|---|
| TEST-STREMIO-010 | UI instala o manifesto pelo IP LAN escolhido por `network.evaluate`; servidores fazem bind LAN; fonte contém host/porta corretos e player consome a ponte por esse host | LAN no próprio computador; não valida segundo dispositivo, firewall remoto, instalador ou parsing de todas as configurações |
| TEST-STREMIO-011 | Dois títulos gerados por `createAscProvider` aparecem como links corretos no catálogo da UI; listar não baixa torrent | Busca filtrada é coberta por HTTP, ainda não pela UI; cache/atualização e lista vazia aguardam expansão |
| TEST-STREMIO-012 | Texto da UI mostra freeleech, 1080p, WEB-DL, 18 seeders e 5,6 GB; fonte produzida pelo provedor carrega arquivo correto; ponte responde 206 e IPC confirma vídeo 640 px com posição > 2 s | Não compara pixels; não usa torrent/ASC real; 5,6 GB é metadado da busca sintética, não tamanho do pequeno vídeo gerado |

Stremio medido: Flatpak commit
`0496ce1d6d44ee462182b8779a6ff475bf58b2e77a48a528b5542a44fab7ae6c`.
Resultado: três subcenários passaram. Como controle de sensibilidade, a geração
de `Bridge.lazyUrl` foi temporariamente alterada para anunciar loopback em LAN:
o subcenário 012 falhou especificamente na comparação de host. O código original
foi restaurado; não ficou flag de mutação em produção. Isso protege essa forma de
falha de URL; não equivale a reproduzir todas as causas históricas da issue #120.

`src/addon-server.js` agora contém a composição compartilhada por `src/index.js`
e pelos testes (SDK, autenticação e anti-rebinding). A fixture
`scripts/stremio-ui-fixture.js` usa o `network.evaluate`, `createAscProvider`, addon,
servidor e Bridge reais. Somente respostas ASC e motor torrent são simulados.
Não há servidor de painel ou vigia de conta na fixture.

No runner comum (`npm run check`), `test/stremio-network.test.js` cobre busca por
HTTP, bind/URLs locais e fonte → ponte com HEAD sem abrir motor, Range/bytes,
416 e revogação. `test/stremio-protocol.test.js` também usa a composição de produção
e recusa Host DNS indevido antes de consultar o provedor. Assim a CI normal recebe
proteção rápida, enquanto o cliente gráfico fica no comando especializado.

O CI chama o workflow reutilizável `.github/workflows/stremio-tests.yml`: prepara
Flatpak em Ubuntu 22.04, fixa o commit do cliente e roda `npm test` sob Xvfb/D-Bus
com renderização por software. Não há skip de aplicativo/sessão ausentes nem
`continue-on-error`. Os jobs de pacotes dependem desse resultado; o release reutiliza
a mesma verificação na revisão da tag. Só o log dos testes é publicado como artefato;
perfis e credenciais temporárias não são enviados.

Validação local do comando de CI: `GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x800x24' npm test` passou com
632 testes compartilhados e quatro testes contabilizados na suíte nativa (pai +
três subcenários). YAML validado por actionlint; execução remota depende da publicação
da branch. Windows, outros clientes/shells e acesso por segundo aparelho continuam
sem validação nativa nesta entrega. Em plataformas diferentes de Linux, o comando
comum informa a limitação do adaptador e executa a parte compartilhada; a barreira
gráfica obrigatória fica no job Linux.

Próxima expansão: busca/atualização/lista vazia pela UI oficial, depois episódios,
status e fallback. Os cenários específicos ainda não implementados não devem ser
considerados cobertos só porque o player ou o catálogo inicial passaram.

## Inventário de suítes

| Grupo | Nível | Localização | Fronteira e dependências |
|---|---|---|---|
| Credenciais e atividade | unit/integration | `test/credentials.test.js`, `test/addon-activity.test.js` | Store temporário; várias requisições/respostas e roteador simulados |
| Catálogo, estado e fallback | unit/integration | `test/offline-fallback.test.js`, `test/file-state.test.js`, `test/status.test.js` | Chamadas diretas ao addon e ASC simulado |
| Identidade e descoberta de séries | unit/integration | `test/episodes*.test.js`, `test/series-discovery.test.js`, `test/series-play.test.js` | Arquivos e respostas sintéticos; nenhum tracker real |
| Reprodução e políticas da ponte | unit/integration | `test/lazy-play.test.js`, `test/play-limit.test.js`, `test/stream-metrics.test.js`, `test/seed-*.test.js` | Motores/HTTP simulados; verificar o limite de cada fixture antes de reutilizar |
| Transporte local real | specialized integration | `scripts/bench-playback.js` | WebTorrent real com swarm local; sob demanda, não faz parte do check |
| Funções do benchmark | unit | `test/bench-playback.test.js` | Não executa o swarm nem valida decodificação |
| Instalação e portabilidade | smoke/unit | `scripts/smoke-install.sh`, `.github/workflows/ci.yml`, `test/portable.test.js`, `test/windows-scripts.test.js` | Pacotes/instalador em jobs próprios; não equivalem ao cliente Stremio reproduzindo |
| Demais regras do produto | unit/integration | Demais `test/*.test.js` | Configuração, rede, logs, disco, retenção, monitor e painel; runner padrão |

## Pontos da primeira etapa

Fonte dos critérios: issue #144. Propósito comum: proteção do caminho crítico.
`covered` abaixo se limita ao comportamento e à fronteira descritos; não atesta
compatibilidade visual com todas as versões do aplicativo ou SO.

| ID | Estado | Entrada e evidência esperada | Nível / arquivo / comando |
|---|---|---|---|
| TEST-STREMIO-001 | covered | Manifesto autenticado anuncia streams/séries e catálogo local vazio; CORS; descoberta não chamada | integration; `test/stremio-protocol.test.js`; `node --test test/stremio-protocol.test.js` |
| TEST-STREMIO-002 | covered | Sem token ou após revogar, recursos dão 403 antes da descoberta | integration; mesmo arquivo e comando |
| TEST-STREMIO-003 | covered | Pedido HTTP de S02E03 chega ao provedor com IMDb, temporada e episódio corretos; resposta contém a fonte sintética | integration; mesmo arquivo e comando |
| TEST-STREMIO-004 | missing | Catálogo com arquivo local → stream; token da credencial em `?k=`, índice e hints corretos; sem `infoHash` delegando torrent ao Stremio | integration; próximo incremento |
| TEST-STREMIO-005 | missing | Seguir a URL da fonte até ponte HTTP: HEAD sem abrir torrent; Range 206 e bytes exatos; 416; revogação | integration; próximo incremento |
| TEST-STREMIO-006 | missing | Montagem do servidor real recusa Host indevido e preserva autenticação | integration; avaliar fábrica pequena para o bloco de `src/index.js` |
| TEST-STREMIO-007 | missing | Duas credenciais simultâneas não misturam contexto nem URLs de vídeo | integration; após fluxo local |

Evidência inicial: os três testes novos passaram em Linux/Node 22. Validação no
Windows depende da execução do CI. Não há schema comum consumidor/provedor nesta
entrega: as asserções verificam exemplos do protocolo através do SDK real, sem
alegar validação completa do contrato oficial.

## Pontos de extensão no código

- `src/addon.js`: `createAddon`, handlers de catálogo/meta/stream e `parseVideoId`.
  Aceita biblioteca local, `bridgeUrl` e provedor remoto injetados.
- `src/addon-auth.js`: `createAddonHandler` remove prefixo autenticado e mantém o
  contexto da credencial durante o roteamento do SDK.
- `src/index.js`: compõe `getRouter`, autenticação e validação de Host. A suíte
  inicial não inicia esse entrypoint, pois ele também monta serviços de produção.
- `src/bridge.js`: `handle` permite testar HTTP com motor simulado sem `start`.
- `src/credentials.js`: `CredentialStore` permite emissão/revogação temporárias.

## Ordem de avanço e dependências escondidas

1. Manifesto/autenticação e identidade de episódio pelo SDK real: implementado.
2. Catálogo e fonte locais com duas credenciais: sem conta, aplicativo ou torrent.
3. Fonte → ponte com bytes conhecidos e motor falso: sem peers ou serviço externo.
4. Swarm local real reutilizando o benchmark: continua sem conta, mas exige motor.
5. Vídeo sintético decodificável no cliente real: exige Stremio e sessão gráfica;
   manter como suíte própria, ainda sem login obrigatório quando o fluxo permitir.

Meta local chama `findPoster` em `src/addon.js`, que consulta Cinemeta: não exige
login, mas exige rede. Antes de incluir meta offline, injetar resolvedor de pôster
ou interceptar explicitamente essa fronteira. `DEMO_MODE` também usa vídeo externo,
portanto não é fixture offline. Bytes pseudoaleatórios do benchmark não são vídeo.

## Recursos ECC escolhidos

- `ecc:ecc-guide`: localizar recursos nos arquivos instalados.
- `ecc:test-collaboration`: organizar ativos, lacunas e evidências neste mapa.
- Agente com perspectiva de `pr-test-analyzer`: mapear cobertura comportamental;
  esta etapa não é revisão de PR.
- `ecc:e2e-testing`: reavaliar quando houver cliente gráfico/web sob automação;
  Playwright não é necessário para HTTP com `node:test`.
- `ecc:contract-first`: não introduzir geração/OpenAPI agora; o protocolo externo
  já existe e esta etapa não altera um contrato entre equipes independentes.
