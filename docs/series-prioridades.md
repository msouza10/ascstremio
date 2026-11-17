# Séries: conclusão integral, prioridades e estado da entrega

Registro de 16/11/2026, relacionado ao plano [#83](https://github.com/msouza10/ascstremio/issues/83) e à etapa [#88](https://github.com/msouza10/ascstremio/issues/88). Descreve a implementação local e suas verificações. **O gatilho de início da conclusão automática não mudou** (decisão do dono em 16/11/2026: manter a regra atual); muda só a ordem em que o torrent é baixado depois que ela começa; não comprova publicação de release, instalação na instância pessoal ou validação em cliente real.

## Decisão que orienta o download

**O objetivo é completar o torrent inteiro para semear**, independentemente de ele conter um filme, um episódio, uma temporada ou várias temporadas. Episódios disponíveis são estados intermediários; concluir um episódio não abre nem quita uma obrigação independente de seed.

Quando a conclusão começa, a prioridade protege o que a pessoa está assistindo e prepara o que vem depois. **Quando** ela começa segue as regras de sempre: filme depois de `BACKGROUND_IDLE_MINUTES` sem reprodução; pack quando o episódio aberto termina de baixar; nunca com o player assistindo nos demais casos. Começar no meio ou fazer seek muda a ordem do trabalho, sem abandonar os bytes anteriores que faltam. A confirmação de cumprimento continua sendo do tracker, por infoHash.

Esta decisão substitui, para o planejamento, propostas antigas de usar conclusão por episódio ou temporada como objetivo final. Esses itens da #88 precisam ser reconciliados com a conclusão integral; não são funcionalidades entregues por esta alteração.

## Ordem implementada

| Prioridade | Trabalho |
|---|---|
| Streaming | Peças solicitadas pelo iterador do player, com a prioridade própria do WebTorrent |
| Primeira etapa de fundo | Da posição solicitada até o fim do arquivo atual |
| Etapas seguintes | Episódios posteriores, em ordem numérica de temporada e episódio |
| Retorno | Início do arquivo atual que ficou para trás e episódios anteriores |
| Fechamento | Outros arquivos do torrent, inclusive auxiliares, para completar todas as peças |

Exemplo: começar no meio do episódio 4 de uma temporada põe o restante do 4 na frente, depois os episódios 5 em diante, depois o início do 4 e os episódios anteriores, e por fim os auxiliares que ainda faltarem. Num filme, o restante do vídeo vem antes do início que ficou para trás.

A ordenação de episódios usa o índice extraído dos nomes canônicos. Índice físico no `.torrent` não é número de episódio: uma lista embaralhada continua tendo a ordem de reprodução calculada por temporada e episódio. Sem identificação do episódio atual, a ordenação usa a sequência física dos arquivos; isso não acrescenta suporte a conversões de anime ou nomes legados.

Cada etapa de fundo avança somente após suas peças estarem verificadas. Peças já verificadas são puladas. Uma peça que cruza dois arquivos entra uma única vez no plano, na primeira etapa que a necessita; por isso a borda de um arquivo vizinho pode ser baixada antes dele.

Um GET válido com Range atualiza a posição da fila, mesmo quando pede um intervalo curto: o objetivo de fundo continua incluindo o restante do arquivo, não apenas o fim desse Range. O plano segue a última posição solicitada por HTTP; não mede diretamente o relógio de reprodução do cliente. Requisições de sondagem do player também podem alterar essa posição. A validação real precisa observar esse comportamento.

## O que mudou em relação ao código anterior

- **O gatilho de início não mudou.** Nem o GET de vídeo nem o timer iniciam a conclusão antes das condições de antes; o GET só registra a posição e, se a conclusão já estiver ativa, reorganiza a fila.
- O arquivo atual participa da fila: o trecho anterior a um seek não fica esquecido.
- A ordem dos próximos episódios deixa de depender da posição física no torrent.
- A seleção de fundo passa a liberar uma etapa por vez, respeitando a verificação de peças, em intervalos de peças do torrent (e não mais um `select` por arquivo).
- Um seek substitui o plano de fundo; notificações pendentes do plano antigo não podem reativá-lo.
- As seleções do streaming são preservadas ao reorganizar as seleções de fundo.
- Uma recusa do motor ao selecionar não derruba a reprodução nem o timer.
- O teste de exclusão seguido de reprodução aguarda o evento `close` no servidor antes de verificar a liberação do contador de streams; receber o corpo no cliente pode acontecer antes desse evento.

## Implementação e motivo técnico

| Arquivo | Papel na mudança |
|---|---|
| `src/completion-order.js` | Calcula os intervalos de peças, elimina sobreposição e executa a fila de conclusão |
| `src/bridge.js` | Guarda a posição por instância de torrent (mesmo sem iniciar a conclusão), usa-a na ordem da fila quando a conclusão começa pelas regras de sempre e a reorganiza nos GETs de vídeo |

O WebTorrent mescla seleções de fundo sobrepostas **e adjacentes**. Selecionar todos os arquivos de uma vez, na mesma prioridade, não preserva uma fila confiável. A implementação mantém uma etapa selecionada com prioridade zero e libera a próxima quando o bitfield confirma todas as peças dessa etapa.

As notificações do motor são tratadas numa microtarefa, depois da coleta de seleções. O estado do plano é associado ao objeto do torrent por `WeakMap`; a substituição invalida notificações antigas e um torrent destruído não recebe novas seleções. A remoção pela API pública de seleções de fundo preserva as seleções próprias dos iteradores de streaming.

O plano e a posição são mantidos em memória. Após reinício, não se restaura um relógio de reprodução salvo: o motor verifica os dados e o próximo GET pode estabelecer uma nova posição. Sem posição disponível, a fila seleciona o torrent inteiro na ordem física.

## Configuração e proteções preservadas

- `BACKGROUND_COMPLETE=auto` continua sendo o padrão, com o gatilho de sempre; a prioridade do streaming vem antes da fila de fundo.
- `BACKGROUND_COMPLETE=off` preserva a opção de concluir somente por pedido explícito.
- `BACKGROUND_IDLE_MINUTES` continua valendo como antes: é a ociosidade exigida antes de concluir um filme (e um pack sem episódio pronto).
- A conclusão exige admissão de espaço para os dados restantes do torrent. Se não houver espaço ou medida confiável, ela não começa; a reprodução segue a admissão própria e o aviso de falta de espaço é mantido.
- O custo de ratio fora do freeleech continua gerando aviso, sem impedir por si só a conclusão.
- Uma exclusão manual persistida continua bloqueando a conclusão automática. Esta mudança não baixa silenciosamente os arquivos excluídos.
- A escolha de baixar só um episódio ou uma temporada (conclusão parcial, [#114](https://github.com/msouza10/ascstremio/pull/114)) também continua valendo contra a conclusão automática: o pack não é completado sozinho enquanto essa escolha existir (ela fica em memória e some ao reiniciar; depois disso vale de novo o gatilho normal). O pedido explícito de concluir o torrent (**Baixar o que falta**) limpa a escolha parcial e as exclusões, e então a fila integral começa. Concluir parte do pack não abre a obrigação de seed; ela só nasce quando o torrent inteiro fecha.
- Listagem e HEAD continuam sem iniciar download de vídeo nem announce. Credenciais, proteção de Host e controles administrativos seguem exigidos.
- A meta continua sendo do torrent inteiro. Depois de reabrir um pack incompleto, o relógio local não soma seed enquanto o motor ainda está baixando.

A prioridade é uma política de seleção dentro do torrent, não uma garantia de ausência de travamentos nem de reserva de banda entre torrents diferentes. Depende de peers, disco, rede e comportamento do player. Se faltarem peças na etapa atual de fundo, as etapas posteriores aguardam; pedidos urgentes do streaming continuam tendo seleção própria.

## Verificação realizada

Resultado local da portagem sobre a `main` (com a #139), depois da decisão de manter o gatilho: `npm run check` com todos os testes aprovados e a barreira `scripts/check-no-secrets.sh .` aprovada. Esse resultado é local; não representa CI em Windows, pacote, imagem ou reprodução real.

| Teste | Evidência coberta |
|---|---|
| `test/completion-order.test.js` | Filme iniciado no meio; episódios fisicamente embaralhados; ordem numérica entre temporadas; cobertura de todas as peças e bordas compartilhadas |
| `test/completion-order.test.js` | Coleção de seleções usada pelo WebTorrent preserva streaming ao substituir o fundo; avanço só após verificação; invalidação de notificação anterior ao seek |
| `test/series-play.test.js` | Gatilho de sempre com a nova ordem (episódio ainda baixando e player aberto não inicia; parado inicia a partir da posição); modo off; pedido explícito; GET registra a posição sem iniciar a conclusão; Range curto e seek reorganizam a fila ativa; falha de seleção não derruba o vídeo nem o timer |
| `test/seed-policy.test.js` | Teste original da `main` (não conclui com player assistindo, antes do limite ou em modo off), só com o formato da seleção ajustado para ignorar o callback de notificação |
| `test/file-actions.test.js` | Após excluir um episódio, os restantes servem Range sem restaurar o excluído; encerramento de reprodução observado no servidor; o pedido explícito de concluir o pack desfaz o escopo parcial e passa a selecionar intervalos de peças |

O teste da coleção de seleções importa a implementação do WebTorrent instalada, mas não inicia um cliente BitTorrent. Os demais testes usam dados sintéticos e motores simulados; o teste HTTP de exclusão usa arquivos temporários e servidor local. Não houve download de vídeo real, announce ao ASC ou alteração de biblioteca pelo MCP nesta entrega.

Para repetir as verificações:

```bash
node --test test/completion-order.test.js test/series-play.test.js test/seed-policy.test.js test/file-actions.test.js
npm run check
scripts/check-no-secrets.sh .
git diff --check
```

## Suporte por tipo de release

Registro de 17/11/2026 da etapa [#89](https://github.com/msouza10/ascstremio/issues/89). Cada tipo de release da seção 1 da [#83](https://github.com/msouza10/ascstremio/issues/83) tem um comportamento definido quando o Stremio pede um episódio: **toca**, mostra **não suportado** (com mensagem) ou **não oferece** (o release não serve a este pedido). "Não suportado" é **limitação deste projeto**: não é parecer do ASC sobre o release e nada aqui o apresenta como lançamento aprovado pelas regras atuais. O addon não prevê, nesta etapa, confirmação manual de episódio.

A decisão de segurança é a mesma em todos os casos: só toca quando temporada e episódio estão escritos no nome do arquivo (`SxxExx`). Um número solto, como `EP05` ou `05 Título`, **não** é assumido como `S01E05`, porque tocaria o episódio errado sem aviso. Nomes ambíguos (vários identificadores no mesmo nome) continuam sem mapeamento.

| Caso | Exemplo | Comportamento | Teste (`test/series-suporte.test.js`) |
|---|---|---|---|
| Temporada simples na raiz | Breaking Bad S01, `S01E01`..`S01E07` | Toca | temporada simples |
| Pack completo com subpastas por temporada, nomes técnicos | Breaking Bad S01-S05 | Toca | pack completo com subpastas |
| S02 que continua S02 | The Last of Us S02 | Toca no S02; o S01 nem consulta o release (o nome contradiz) | S02 continua sendo S02 |
| Título do episódio depois do identificador | `S01E01.System.mkv` | Toca | título do episódio |
| Raiz `Série (ano)` com `Temporada 01`..`05` | Stranger Things (2016) | Toca (nome da pasta livre) | raiz com pastas |
| Episódio avulso com um só MKV | Dexter: Resurrection S02E03 | Toca no episódio do nome; outro episódio não é oferecido, sem aviso | episódio avulso |
| Episódio de quatro dígitos | One Piece S23E1180 | Toca só se o Stremio pedir `23:1180`; o `23:25` do Cinemeta não é oferecido (sem conversão de numeração) | quatro dígitos |
| Temporada de anime com numeração absoluta | One Piece S34E864..877 | Toca só quando o identificador coincide com o pedido; não oferece o resto | anime S34E864 |
| Caminhos do Windows e ordem embaralhada | `Show\Temporada 02\...` | Toca | barra invertida e embaralhada |
| Pack legado `Temporada N/01 Título.mkv`, com filme e imagens | Breaking Bad + El Camino | **Não suportado**, com mensagem | pack legado |
| Legado `EP01` em subpasta por episódio, com `Legenda/` | Irmãos de Guerra - Completo (id 70) | **Não suportado**, com mensagem | legado EP01 |
| One Pace por saga/arco | `Saga 1/Arco 1/One Pace - Romance Dawn - 01.mkv` | **Não suportado**, mesma mensagem | One Pace |
| Full Disc, ISO, BDMV | `Show.S01.BD50.iso`, `BDMV/STREAM/*.m2ts` | **Não suportado**, mensagem de imagem de disco | Full Disc, BDMV |
| MiXED e nomes ambíguos | `S01E01.S02E01.MiXED.mkv` | **Não suportado**, mesma mensagem dos nomes sem identificação segura | MiXED |
| Dois arquivos dizem ser o mesmo episódio | `S01E01.1080p` e `S01E01.720p` | Não oferece, sem aviso (não escolhe um deles) | conflito |

### O aviso "Releases não suportados"

Quando a busca por IMDb traz releases cuja lista de arquivos foi lida **por inteiro** e que não têm nenhum episódio identificado (há vídeos, ou estrutura de disco, mas nenhum com temporada e episódio claros), e **nenhum outro release serve ao pedido**, a lista de fontes ganha **um** item informativo e não tocável: quantos releases do título existem no ASC e por que o addon não os toca. Tocá-lo abre o painel (ou o site do ASC, quando o status não está liberado), como o aviso de ASC indisponível. O texto não promete suporte futuro e não traz dado da conta.

Decisões:

- **Só quando não sobra fonte tocável.** Com ao menos uma fonte, o aviso seria ruído repetido em todo episódio. Sem nenhuma, é o único jeito de a pessoa saber que a lista não está vazia por falta de releases. Exemplo real: em Band of Brothers, o release 70 (legado `EP01`) não aparece enquanto o 47552 (`S01Exx`) toca; se só o 70 existisse, o aviso apareceria.
- **Agregado.** Um item por pedido, não um por release; os motivos distintos viram linhas.
- **Release de outra temporada ou episódio (o nome contradiz) nunca avisa**, e a página dele nem é lida.
- **Lista incompleta não prova nada.** O release segue como candidato "a confirmar ao tocar", sem aviso. Um release com ao menos um episódio identificado também não gera aviso: só "não traz este episódio".
- **Sem custo extra.** O aviso sai dos dados que a listagem já lê (busca por IMDb e lista de arquivos da página do release); não baixa `.torrent`, não anuncia e não faz consulta nova ao ASC.

### Legendas do pack

As legendas SRT/ASS que vêm no pack (por exemplo a pasta `Legenda/`) **não são expostas pelo addon**: nenhuma fonte leva o campo `subtitles`. É uma limitação documentada do projeto; o Stremio usa os addons de legenda dele. Não há associação de legenda ao episódio, idioma ou *forced*.

## Estado das issues e trabalho restante

O quadro abaixo registra a leitura das issues nesta sessão; os checklists remotos não foram alterados.

| Issue | Estado observado e próximo trabalho |
|---|---|
| [#85 — decisões](https://github.com/msouza10/ascstremio/issues/85) | Aberta. Reconciliar o texto antigo com a decisão de conclusão integral e as escolhas posteriores registradas nos comentários da #88 |
| [#86 — identidade](https://github.com/msouza10/ascstremio/issues/86) | Fechada. Base do índice canônico de episódios |
| [#87 — descoberta e play](https://github.com/msouza10/ascstremio/issues/87) | Fechada. Base da descoberta e reprodução por arquivo |
| [#88 — arquivos, conclusão e seed](https://github.com/msouza10/ascstremio/issues/88) | Aberta. Esta entrega ajusta a política de conclusão; não encerra toda a etapa |
| [#89 — formatos adicionais](https://github.com/msouza10/ascstremio/issues/89) | Aberta. Legado, packs completos, anime, casos ambíguos e legendas externas ainda exigem decisões e validação próprias |
| [#90 — validação](https://github.com/msouza10/ascstremio/issues/90) | Aberta. Exercitar Stremio real, Range/seek, próximo episódio, conclusão do pack, seed, painel e regressões nas plataformas suportadas |
| [#109 — parciais no tracker](https://github.com/msouza10/ascstremio/issues/109) | Aberta. Depende da resposta da staff sobre o vencimento de registros parciais; a conclusão automática não comprova qual é a penalidade |

Já estão na `main` (fora desta entrega): estado por arquivo ([#113](https://github.com/msouza10/ascstremio/pull/113)), exclusão e conclusão parcial por episódio e temporada ([#114](https://github.com/msouza10/ascstremio/pull/114)), verificação de peças sem o motor ([#115](https://github.com/msouza10/ascstremio/pull/115)) e oferta offline do episódio verificado ([#117](https://github.com/msouza10/ascstremio/pull/117)). Esses itens da #88 foram escritos antes da decisão de conclusão integral e precisam ser reconciliados com ela pelo dono; o texto da issue não foi alterado aqui. O cenário de excluir um episódio e reproduzir os restantes tem teste local, mas não foi exercitado no Stremio real.

O suporte já existente inclui estado por arquivo e exclusão individual com as travas do tracker. Num pack com conclusão registrada, excluir exige confirmação atual do cumprimento; um pack nunca concluído segue o tratamento existente. Esta entrega não altera essa regra nem resolve a dúvida da #109.

Antes de considerar o conjunto pronto: reconciliar os critérios das issues com a decisão final, concluir os itens técnicos restantes, validar no cliente e no tracker e executar o CI exigido pelo projeto. Nenhuma issue foi fechada por esta documentação.

## Decisões ainda abertas desta entrega

Em 16/11/2026 o dono decidiu **manter o gatilho atual** de início da conclusão; isso não é mais uma pendência. Restam:

- **Fila etapa a etapa:** se uma peça da etapa atual não existe no swarm, as etapas seguintes aguardam. Em swarms pequenos isso pode atrasar o fim do download; manter duas ou três etapas selecionadas é uma alternativa não implementada.
- **Escolha parcial só em memória:** depois de reiniciar, a escolha de baixar só parte do pack some e vale o gatilho normal (limite já descrito em [seed](seed.md#séries-e-packs-baixar-e-excluir-por-episódio)).
- **Sondas do player:** a posição vem do último GET Range; sondagens de cauda (índices do MKV ou MP4) podem reordenar o prefetch até o GET seguinte.
