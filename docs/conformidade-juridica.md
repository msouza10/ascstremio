# Matriz de código, legislação e avisos legais

Referência: [LEGAL.md, versão 1](../LEGAL.md), de 14/11/2026. Base de publicação:
`main` em `1476397`, sem os commits de séries. Escopo: leitura estática
do código, documentação, testes e evidências das issues, sem acessar contas, tracker autenticado
ou dados privados. Hipótese jurídica: mantenedor no Brasil e instalações pessoais.
Esta é uma avaliação preliminar de lacunas, não parecer ou certificação de conformidade.

## Resultado da análise

Não é possível declarar o projeto juridicamente blindado. O aviso agora descreve o
comportamento identificado, mas não comprova autorização de integração ou das obras.
Código, documentação e postura do mantenedor precisam permanecer coerentes. Aceite de
aviso, autenticação e tracker privado não legalizam uma transferência não autorizada.

Nesta mudança foram escritos os avisos, incluídos nos caminhos de empacotamento e
ligados ao README/índice. As funcionalidades abaixo permanecem propostas, salvo quando
explicitamente descritas como existentes. Não há novo bloqueio de reprodução ou aceite
obrigatório implementado. As alterações concorrentes de séries não integram esta entrega;
seus testes e fluxos deverão ser incorporados à comparação quando forem publicados.

As prioridades P0/P1/P2 indicam ordem recomendada de tratamento, não determinação legal
de prazo, certeza de infração ou probabilidade de processo. Não há fatos suficientes
para atribuir uma pontuação confiável de probabilidade × impacto.

## Bases e limites da comparação

| ID | Fonte oficial consultada | Uso nesta análise |
|---|---|---|
| L1 | [Lei 9.610/1998](https://www.gov.br/propriedade-intelectual/pt-br/legislacao/direitos-autorais/legislacao-nacional/lei-9610.pdf/@@display-file/file), arts. 29, 31, 46 e 104 | Diferenciar acesso, reprodução e distribuição; verificar autorizações e exceções efetivas |
| L2 | [Código Civil](https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm), arts. 186, 187 e 927 | Analisar conduta, dano e dever de reparação; não presumir exoneração por aviso |
| L3 | [CDC](https://www2.camara.leg.br/legin/fed/lei/1990/lei-8078-11-setembro-1990-365086-normaatualizada-pl.html), arts. 6º, III, 25 e 51 | Informação clara e limites a cláusulas de exoneração, se houver relação de consumo |
| L4 | [LGPD](https://www2.camara.leg.br/legin/fed/lei/2018/lei-13709-14-agosto-2018-787077-normaatualizada-pl.html), arts. 3º, 4º, 6º, 7º, 9º, 15–18 e 46 | Avaliar incidência, finalidade, necessidade, transparência, segurança e ciclo de vida dos dados |
| L5 | [Marco Civil](https://www.gov.br/mj/pt-br/assuntos/sua-protecao/sedigi/LEIN12.965DE23DEABRILDE2014.pdf), arts. 19, § 2º, e 31; [tese final do STF, Tema 987](https://noticias-stf-wp-prd.s3.sa-east-1.amazonaws.com/wp-content/uploads/wpallimport/uploads/2026/06/17180658/MCI_tese.pdf) | Não presumir imunidade por conteúdo de terceiros; avaliar enquadramento da distribuição local e de eventual operação de serviço |
| L6 | [Código Penal](https://presidencia.gov.br/ccivil_03/decreto-lei/del2848compilado.htm), art. 184 | Eventual enquadramento exige fatos e elementos do tipo; não é afastado por disclaimer |
| C1 | [LICENSE](../LICENSE) e licenças dos componentes | Obrigações de redistribuição e preservação da MIT; dependências ainda exigem inventário |
| C2 | Regras e condições vigentes do ASC | Não foram obtidas nesta análise; resumos do projeto não substituem o texto atual nem autorização do tracker |

O STF esclareceu a tese em 17/06/2026. Há regimes e exceções distintos na redação final;
não é correto resumir tudo a “só responde depois de ordem judicial” ou a “sempre responde”.
A classificação do mantenedor deste software não foi decidida por esta análise. Direitos
autorais exigem considerar suas regras específicas. [Comunicado oficial do STF](https://noticias.stf.jus.br/postsnoticias/plataformas-terao-60-dias-para-implementar-medidas-estruturais-decide-stf/).

A possível incidência do CDC depende da relação concreta, inclusive modelo econômico.
O aviso não pressupõe que gratuidade exclua sua aplicação. Na privacidade, a exceção de uso
particular de pessoa natural não pode ser estendida automaticamente ao suporte do mantenedor.
Prazos e papéis de proteção de dados devem ser definidos para cada atividade efetiva.

## Matriz principal

“Parcial” significa que há controle técnico ou aviso, mas ainda falta demonstrar a medida
completa. “Pendente externo” exige evidência ou decisão fora do código.

| ID / prioridade | Código e comportamento observado | Base | LEGAL.md | Lacuna e providência | Estado |
|---|---|---|---|---|---|
| J01 / P0 | [asc-client.js](../src/asc-client.js), `requestInner`, `login`, `download`: automatiza conta e downloads do ASC | L1, L2, L6, C2 | §§ 2–3 | Obter regras atuais e analisar autorização de automação/cliente/distribuição; autorização do tracker não substitui a dos titulares. Avaliar com advogado a integração, divulgação e usos concretos | Pendente externo |
| J02 / P0 | [asc-provider.js](../src/asc-provider.js), `resolve`: obtém fontes pela conta; não verifica cadeia autoral | L1, L6 | §§ 2–3 | Definir como manter exemplos, testes e materiais de divulgação licenciados. Se o modelo exigir comprovação por fonte, projetar fluxo verificável; checkbox genérico não é prova dos direitos | Pendente externo e desenho |
| J03 / P1 | [panel-settings.js](../src/panel-settings.js), `wizardMark`; [settings.js da UI](../src/ui/settings.js), `dismiss`; [credenciais-cli.js](../src/credenciais-cli.js): assistente adiável, emissão também fora do painel | L2, L3 | §§ 2, 4, 6, 9 | Apresentar aviso antes da primeira ativação de transferências; registrar ciência operacional local com versão e data, sem exigir renúncia de direitos. Cobrir CLI e instaladores, não só UI | Parcial: README e aviso; fluxo pendente |
| J04 / P1 | [bridge.js](../src/bridge.js), `start`, `resumePending`, `getTorrent`, `completionTick`: upload, retomada e conclusão de fundo | L1, L2, L3 | §§ 4, 6 | Avisar de forma visível que fechar player/revogar token não para seed; diferenciar retomar obrigação existente de iniciar transferência nova. Planejar migração sem interromper seed pendente | Aviso escrito; fluxo pendente |
| J05 / P1 | [library.js](../src/library.js), `readTorrent`, `loadLibrary`: aceita `.torrent` locais; [bridge.js](../src/bridge.js), `getTorrent`: usa `entry.announceBase` ou metadados originais em `client.add` | L2, L4; C2 | §§ 4–5 | Validar todos os destinos e metadados antes de abrir torrent; verificar flag privada, announces, webseeds e descoberta conforme política explícita. DHT/LSD/PEX desativados já existem, mas não comprovam isolamento de destinos | Parcial; exige teste do motor/dependência |
| J06 / P1 | [asc-provider.js](../src/asc-provider.js), `resolve`: grava bytes do ASC em 0600; [passkey.js](../src/passkey.js): não sanitiza `.torrent`; comentário do construtor da ponte diz “sem token” | L2, L4 | § 5 | Corrigir comentário divergente; avaliar sanitização de metadados fora do dicionário `info`, com reinjeção segura e migração somente após validar info hash/compatibilidade. Nunca prometer proteção já implementada | Proteção de arquivo existente; sanitização pendente |
| J07 / P1 | [providers/amigos-share.js](../src/providers/amigos-share.js) e [addon.js](../src/addon.js): Cinemeta recebe consultas/IDs; [alerts.js](../src/alerts.js), `buildBody`: webhook com evento, contagem e horário | L4 | § 5 | Completar inventário de tráfego incluindo bibliotecas/player; explicar destino e campos antes de habilitar webhook; avaliar opção de reduzir consultas externas e dependências | Parcial: webhook opt-in e dados enxutos |
| J08 / P1 | [logger.js](../src/logger.js), `redact`, `prune`; [settings.js](../src/settings.js): padrão debug e retenção 14 dias; [config-server.js](../src/config-server.js): exporta logs | L2, L4 | § 5 | Revisar mínimo necessário em info/debug, mostrar prévia de exportação e aviso de dados pessoais, cobrir títulos/hashes/caminhos além de segredos. Avaliar padrão menos detalhado com diagnóstico preservado | Parcial: redação e retenção existentes |
| J09 / P1 | [credentials.js](../src/credentials.js), [addon-auth.js](../src/addon-auth.js), [safety.js](../src/safety.js), [admin-auth.js](../src/admin-auth.js): controles de credencial, Host, origem e administração; LAN opcional | L2, L4 | §§ 3–5 | Preservar testes de falha fechada e revogação; a correção administrativa da #10 já foi entregue, sem confiança em RFC1918 como identidade. Não apresentar IP privado, token ou LAN como autorização jurídica de compartilhamento | Controles existentes; validação contínua |
| J10 / P1 | [bridge.js](../src/bridge.js), `releaseSatisfied`; [seed-actions.js](../src/seed-actions.js); [retention-service.js](../src/retention-service.js): exclusão e encerramento têm caminhos distintos | L2, L3; C2 | §§ 3, 6 | Tornar exclusão padrão ostensiva; verificar confirmação recente em cada caminho destrutivo. `releaseSatisfied` usa estado confirmado em cofre; não afirmar releitura imediata em todos os casos. Manter proteções de caminhos e concorrência | Parcial; avaliar atualidade da confirmação automática |
| J11 / P1 | [install.sh](../scripts/install.sh), desinstalação; [installer.nsi](../windows/installer.nsi): mantêm dados; revogar credencial não remove sessão/cofre/backups | L4; C2 | §§ 4–5 | Documentar inventário, localização, finalidade e prazo por arquivo; desenhar prévia de remoção/revogação sem apagar seed pendente silenciosamente. Definir resposta a incidentes e solicitações para dados recebidos pelo mantenedor | Parcial; política completa pendente |
| J12 / P1 | [config-server.js](../src/config-server.js), rotas estáticas limitadas a `src/ui`; [index.html](../src/ui/index.html): sem acesso local ao aviso novo | L3; C1 | § 9 | Servir aviso offline por rota fixa e incluir link no painel/assistente. Preservar Host/CSP e não criar leitor de arquivos arbitrários. Aviso acompanha os pacotes nesta entrega | Distribuição coberta; painel pendente |
| J13 / P1 | [SECURITY.md](../.github/SECURITY.md): canal privado para vulnerabilidade; issues são públicas; nenhum canal jurídico privado específico documentado | L2, L4, L5 conforme enquadramento | § 8 | Mantenedor deve escolher canal privado real, publicar instruções e adotar procedimento de recebimento, análise, evidências mínimas e resposta. Não prometer apagar instalações alheias | Pendente operacional |
| J14 / P2 | [package.json](../package.json), lockfile, empacotadores e imagens incluem componentes de terceiros; Cinemeta fornece metadados e imagens | C1, L1 | §§ 1–2, 5, 7 | Complementar a entrega da #13 com inventário de licenças/avisos por artefato e permissões de metadados, artes, logos e amostras. A MIT e avisos em dependências já são distribuídos | Inventário completo pendente |
| J15 / P2 | README e [LEGAL.md](../LEGAL.md): sem prova de aceite contratual; distribuição sob MIT | L2, L3; C1 | §§ 1, 7, 9 | Revisar alegações de proteção/conformidade na UI e publicidade. Analisar monetização, hospedagem, jurisdições e obrigações antes de mudar modelo; manter histórico dos avisos por release | Aviso compatível; revisão jurídica pendente |

## Issues de execução

O [épico #92](https://github.com/msouza10/ascstremio/issues/92) organiza a execução.
As decisões e os controles pendentes não são considerados concluídos por esta publicação.

| Issue | Escopo | Pontos |
|---|---|---|
| [#93](https://github.com/msouza10/ascstremio/issues/93) | Revisão e publicação dos documentos; esta entrega cobre a primeira versão, com revisão jurídica e artefatos completos ainda pendentes | J12/J15 |
| [#94](https://github.com/msouza10/ascstremio/issues/94) | Permissões e limites de distribuição | J01/J02/J15 |
| [#95](https://github.com/msouza10/ascstremio/issues/95) | Canal jurídico privado | J11/J13 |
| [#96](https://github.com/msouza10/ascstremio/issues/96) | Avisos offline no painel | J12 |
| [#97](https://github.com/msouza10/ascstremio/issues/97) | Avisos antes de novas transferências | J03/J04 |
| [#98](https://github.com/msouza10/ascstremio/issues/98) | Destinos dos torrents | J05/J09 |
| [#99](https://github.com/msouza10/ascstremio/issues/99) | Persistência de passkeys | J06/J09 |
| [#100](https://github.com/msouza10/ascstremio/issues/100) | Confirmação recente antes da liberação automática | J09/J10 |
| [#101](https://github.com/msouza10/ascstremio/issues/101) | Inventário e ciclo de vida dos dados | J07/J11 |
| [#102](https://github.com/msouza10/ascstremio/issues/102) | Logs e exportações | J08 |
| [#103](https://github.com/msouza10/ascstremio/issues/103) | Licenças e materiais de terceiros | J14 |

## Implementação proposta e critérios de conclusão

Estas tarefas são recomendações de engenharia para reduzir riscos identificados. Não são
uma lista de obrigações legais automaticamente aplicáveis a qualquer instalação.

### Etapa 1 — permissões e limites do produto (J01–J02, J13, J15)

- Responsável: mantenedor, com advogado para enquadramento autoral/digital.
- Evidências: regras atuais do tracker obtidas legitimamente, permissões pertinentes,
  modelo de distribuição/receita/suporte e limites de atuação documentados sem segredos.
- Definir canal privado de contato e responsável pelo acompanhamento. Não enviar nada
  ao tracker ou a terceiros automaticamente como parte desta análise.
- Conclusão: decisão fundamentada sobre integração e distribuição; mera ausência de
  resposta não vale como autorização. Se não houver base para um uso, ajustar esse uso;
  nenhuma redação resolve essa falta por si só.

### Etapa 2 — avisos acessíveis e ciência operacional (J03–J04, J10, J12)

- Proposta: módulo de aviso único, versão identificável e cópia offline nos artefatos.
  Rota GET fixa no painel; link antes de conectar/ativar nova transferência; caminho
  equivalente na CLI e instalações silenciosas. Não presumir ciência por concluir wizard.
- Persistência, se adotada: versão/digest do aviso e data local, escrita atômica 0600;
  sem CPF, IP, assinatura remota ou envio de prova ao mantenedor por padrão.
- Separar informação/ciência de upload de eventual fundamento para tratamento de dados.
  Não chamar toda confirmação de “consentimento LGPD” nem exigir renúncia de direitos.
- Testes necessários: instalação nova, wizard pulado, CLI, atualização, arquivo de ciência
  ausente/corrompido, mudança material do aviso e acesso offline. Provar que o aviso aparece
  antes dos novos efeitos definidos no desenho, incluindo anúncio e conclusão em fundo.
- Migração: não suspender obrigações já iniciadas nem apagar dados como consequência
  automática de faltar nova ciência; definir tratamento explícito de pendências existentes.
- Critério: fluxo coberto em todos os pontos de entrada e texto igual ao empacotado.
  A decisão de exigir um bloqueio técnico ainda depende desse desenho; não foi implementado.

### Etapa 3 — destinos, segredos e segurança (J05–J06, J09)

- Antes de `client.add`, analisar metadados em memória e definir política para fontes
  baixadas e importadas. Validar hostname exato, esquema, porta, caminho e todos os announces;
  não usar comparação por sufixo ingênua. Avaliar comportamento de webseeds/trackers padrão
  da versão instalada do WebTorrent com evidência, sem presumir que sobrescrever `announce`
  elimina toda comunicação original.
- Testes com torrents sintéticos e motor simulado: tracker estranho, lista mista, URL com
  userinfo, redirecionamentos, webseed, flag privada ausente, arquivo malformado, sem passkey
  e retomada. Recusar o que estiver fora da política antes de abrir conexão ou anunciar.
- Se sanitizar persistência, comprovar info hash idêntico e anúncio correto, tratar importados
  e backups antigos, testar recuperação/migração. Manter falha fechada e não gravar token em logs.
- Preservar regressões de CSRF/Host, credenciais revogadas, HEAD sem efeitos, catálogo sem
  `.torrent`, caminhos de arquivo e execução sem root no contêiner. Não reduzir seed para
  ocultar tráfego ou contornar regras do tracker.
- Critério: política de rede testada no limite anterior aos efeitos; não somente uma alegação
  no `LEGAL.md`. Auditoria específica do motor ainda é necessária para comprovar isolamento.

### Etapa 4 — dados, disco e suporte (J07–J08, J10–J11, J13)

- Inventário por arquivo/fluxo: dado, origem, finalidade, destino, persistência, remoção e
  responsável. Separar instalação pessoal dos dados voluntariamente enviados ao suporte.
- Para atividade do mantenedor sujeita à LGPD, definir fundamento, atendimento, retenção e
  resposta a incidentes proporcionais. Não criar telemetria nem recolher documentos por padrão.
- UI de webhook deve mostrar exatamente os campos de `buildBody`; exportação deve alertar
  sobre hábitos e identificadores. Redação automática não autoriza enviar logs sem revisão.
- Revisar exclusão automática quanto a confirmação do tracker e disputa com reprodução;
  testar erro/revogação de confirmação, dados incompletos, falta de disco, links e concorrência.
  Proposta conservadora: exigir leitura recente antes da exclusão automática, se compatível
  com o contrato operacional validado, sem mexer manualmente nos números do tracker.
- Documentar o que desinstalação, logout e cada revogação fazem e deixam de fazer. Remoção
  de dados deve ter prévia e tratar pendências; não virar um botão para burlar seed.
- Critério: instruções compatíveis com testes e ciclos reais, sem promessa de apagar backups
  ou registros de terceiros. Canal e procedimento definidos pelo mantenedor.

### Etapa 5 — redistribuição, licenças e revisão final (J12, J14–J15)

- `LEGAL.md` entra na lista explícita usada por Linux e Windows, e no COPY do Docker;
  nenhum empacotador deve copiar `docs/` inteira. Matriz pública também é listada por nome.
- Validar artefatos reais de cada plataforma e preservar MIT/avisos exigidos por componentes.
  Hashes e procedência de release ajudam integridade; não conferem direitos sobre conteúdo.
- Inspecionar exemplos e capturas com dados fictícios e obras com permissões verificadas.
  Preservar as auditorias de refs e artefatos para novas revisões. A #11 já registra auditorias
  concluídas, inclusive GHCR v0.2.0; isso não comprova ausência de segredos em toda versão futura.
- Revisão jurídica do texto versus operação efetiva, especialmente autorizações, limites
  de responsabilidade e enquadramento do mantenedor. Sem foro/indenização genéricos importados.
- Critério: nenhum controle pendente anunciado como concluído; registrar verificações efetivas
  e revisar a matriz quando houver novas funcionalidades ou alterações jurídicas relevantes.

## Cobertura de testes a preservar ou ampliar

| Área | Arquivos existentes para orientar a implementação |
|---|---|
| Publicação e avisos | `test/documentacao-publica.test.js`, `test/windows-scripts.test.js` |
| Assistente, configuração e CLI | `test/panel-settings.test.js`, `test/configurar-cli.test.js`, `test/credentials.test.js` |
| Fontes e ausência de efeitos em sondagens | `test/asc-provider.test.js`, `test/lazy-play.test.js`; testes de séries a incorporar com a entrega correspondente |
| Retomada e seed | `test/seed-resume.test.js`, `test/seed-policy.test.js`, `test/seed-actions.test.js`, `test/upload-policy.test.js` |
| Limpeza e segurança | `test/retention.test.js`, `test/disk-policy.test.js`, `test/network.test.js`, `test/admin-painel.test.js` |
| Logs e comunicação opcional | `test/logger.test.js`, `test/alerts.test.js` |

A existência desses arquivos não comprova que todos os cenários propostos estejam cobertos.
Os testes desta entrega verificam as mudanças documentais e os caminhos declarados de
empacotamento. Nenhum teste técnico comprova autorização de titulares ou eficácia jurídica.

Verificação da branch de publicação, baseada na `main` em `1476397`:

- `npm run check`: 507 testes aprovados, além da verificação sintática da UI, fora do
  sandbox para permitir os servidores locais usados pelos testes.
- `scripts/check-no-secrets.sh .`: aprovado para a árvore distribuível; não equivale a
  nova auditoria de todas as refs ou dos binários publicados.
- Links locais dos avisos, matriz, README e índice: destinos existentes.
- `scripts/build-release.sh`: pacote Linux gerado; presença de `LEGAL.md`, `LICENSE` e
  matriz conferida no tarball. A nota local anterior não foi incluída.
- Barreira de segredos aplicada ao tarball Linux; `git diff --check` aprovado.
- Builds completos de Docker e do instalador Windows não foram executados nesta entrega;
  os testes conferem os caminhos declarados de inclusão, e o CI valida os demais formatos.

## Risco residual e próxima decisão

Mesmo após as etapas técnicas, permanecem a autorização das obras, condições do tracker,
conduta concreta do projeto, eventuais falhas e aplicação da lei por autoridades competentes.
Pode ser necessário restringir funcionalidades, demonstrações ou o modelo de distribuição
se a avaliação jurídica apontar ausência de base para usos pretendidos. Isso deve resultar
de fatos verificados; não se conclui aqui que o projeto ou uma obra específica sejam ilícitos.

Método: skill [legal-risk-assessment](https://github.com/anthropics/knowledge-work-plugins/tree/main/legal/skills/legal-risk-assessment),
adaptada a um projeto pessoal. Não há relação advogado-cliente ou sigilo profissional
criado por esta nota. Regras do ASC, permissões, enquadramento internacional e auditoria
integral de dependências/tráfego continuam fora do que foi comprovado nesta entrega.
