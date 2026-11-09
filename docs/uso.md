# Uso no Stremio e no painel

Com a instalação concluída, faça login no painel **http://127.0.0.1:7020/** e instale no Stremio a URL `http://127.0.0.1:7000/<credencial>/manifest.json`, emitida por `npm run credenciais -- garantir` (veja [credenciais](seguranca.md#credenciais-de-instalação-do-addon)). Se mudar a porta, use os endereços correspondentes da sua [configuração](configuracao.md).

## Login e busca

O login salva cookies da sessão e a escolha do filtro freeleech, sem persistir a senha do formulário. Se a sessão expirar, conecte novamente. Desafios do site e autenticação adicional podem exigir ação no navegador; o programa não tenta contorná-los. Sair pelo painel remove a sessão local, mas não encerra outras sessões no site nem torrents ativos.

Em Descobrir → Filmes, **ASC — filmes** permite buscar no tracker. Abrir filmes de catálogos com ID IMDb também consulta fontes ASC. A busca considera até 96 releases por consulta e oferece até doze fontes em buscas IMDb. Não há paginação online nem seleção de episódios de packs.

O filtro **somente freeleech** começa ativado; para mudar, faça login novamente com a opção desejada. O filtro é conferido também no momento do play, inclusive para URLs antigas. Um release sem confirmação de freeleech não é baixado com o filtro ligado.

## Como ler as fontes

```text
Nome                  Descrição
🆓 4K                 HDR10 · H.265
REMUX                 🇧🇷🇺🇸 TrueHD
                      👤 4 seeders · 💾 48,6 GB · ✅ 60
```

O nome mostra freeleech, resolução e origem. A descrição reúne vídeo, idioma/áudio, peers, tamanho e quantidade de downloads completos. Avisos incluem **Não é freeleech**, **ISO** e **Baixa de novo (72 h)**.

As bandeiras derivam dos selos do ASC e do idioma original obtido na página de um release. Elas não verificam as faixas do arquivo: Dual Áudio indica português + idioma original, Dublado indica português, Legendado indica idioma original + legenda. Se a consulta falhar, pode aparecer 🌐. Campos não fornecidos pelo tracker são omitidos.

Releases com seeders e sem imagem de disco aparecem primeiro; maior número de seeders tem preferência e freeleech desempata. ISO e fontes sem seeders continuam visíveis no fim.

## O que acontece ao reproduzir

Listar fontes consulta metadados, mas não baixa o `.torrent` nem anuncia no swarm. O primeiro `GET` da reprodução baixa o torrent e abre a ponte. Sondagens `HEAD` não baixam nem anunciam. O início pode demorar enquanto o arquivo é obtido, verificado e os peers respondem.

A ponte serve vídeo por HTTP com suporte a `Range`, usando o motor BitTorrent local. O computador executando o addon precisa ficar ligado durante a reprodução e o seed. O player ainda precisa suportar o contêiner e os codecs de áudio/vídeo; o addon não transcodifica.

| Release | Resultado |
|---|---|
| Filme com um vídeo principal | Reproduz o arquivo selecionado |
| Filme e extras pequenos | Aceito se o vídeo principal representar pelo menos 70% da soma dos vídeos e for pelo menos quatro vezes o segundo vídeo |
| Coleção, trilogia ou partes de tamanhos parecidos | Recusado no play com 422 |
| `.iso`, BDMV e imagens de disco | Não há vídeo reproduzível pela ponte; o formato pode ser recusado antes ou durante o play |
| Sem seeders | O play online é recusado com 503 antes do download; dados locais completos ainda podem tocar |
| Não freeleech com filtro ativo | Recusado com 409 |
| Primeiro trecho sem chegar em 60 s | Resposta 504; veja [diagnóstico](manutencao.md#diagnóstico) |

Torrents com flag privada ou não privada usam a mesma ponte, com descoberta pública de peers desativada. O formato completo pode ser descoberto somente depois de obter o `.torrent`; um release recusado deixa de ser oferecido nas próximas listas dessa execução.

## Painel

Os caminhos abaixo são relativos a `http://127.0.0.1:7020`. São páginas locais da sua instalação, não links para compartilhar a conta.

| Página | Conteúdo |
|---|---|
| `/` | Avisos, indicadores, obrigações, downloads, tráfego e conta |
| `/filmes` | Biblioteca por situação, busca e andamento |
| `/filmes/<infoHash>` | Seed, prazo, dados do tracker e ação de concluir download |
| `/trafego` | Download/upload e composição do disco; gráfico com tabela equivalente |
| `/logs` | Logs ao vivo, filtros, arquivos e exportação |
| `/conta` | Sessão, conta ASC, serviço e resumo das regras |
| `/configuracoes` | Todas as opções do esquema por assunto, com valor em uso, origem, bloqueios e aviso de reinício |
| `/assistente` | Configuração guiada: modo local ou LAN, endereço, seed e disco, instalação no Stremio |
| `/entrar` | Login |

O painel atualiza a cada cinco segundos e oferece temas claro e escuro. O monitor exige sessão confirmada; os logs continuam acessíveis localmente sem login no ASC para permitir diagnóstico. As ações de login, logout, conclusão e alteração do nível de log exigem as proteções CSRF do painel.

### Assistente e Configurações

Depois do **primeiro login** bem-sucedido o painel abre o assistente uma vez (dá para "Pular por enquanto"; ele continua em `/assistente` e em *Configurações → Abrir o assistente*). No modo local, os valores seguros já vêm preenchidos e o passo de seed mostra o efeito de `AFTER_SEED=delete` (apagar os arquivos depois que o tracker confirmar o seed). No modo LAN o assistente pede o endereço deste computador, explica o que fica acessível, que o tráfego é HTTP e que cada aparelho recebe uma credencial própria (a senha do ASC não é usada pelos aparelhos nem dá acesso administrativo ao aplicativo). O último passo cria a credencial e mostra a URL do addon **uma única vez**; se houver reinício pendente de rede, a URL só é oferecida depois dele.

A página **Configurações** usa a mesma validação da partida e do terminal: mostra a prévia das alterações e quais exigem reinício antes de gravar, preserva o que você digitou se algo falhar ou se a configuração mudou em outra aba (conflito de revisão), e explica por que uma opção é somente leitura (definida pelo ambiente, segredo ou pasta de dados, que só se troca pelo terminal com o aplicativo parado). Sair da sessão do ASC ou atualizar o programa não refaz o assistente: a conclusão fica em `DATA_DIR/wizard.json`, separada da sessão e do `settings.json`. Se a sessão do ASC expirar, as telas pedem novo login; o terminal (`npm run configurar`) continua funcionando.

**Concluir download em segundo plano** pede confirmação e baixa o restante do torrent. Isso consome disco/rede e, ao completar, abre a obrigação de seed. Consulte [seed](seed.md) antes de confirmar.

## ASC — status

Esse catálogo mostra resumo, avisos, conta e filmes em andamento dentro do Stremio. Por expor ratio e avisos da conta, ele só aparece para credenciais emitidas com `--status` (`credenciais criar "Nome" --status`); as demais não o veem. Abrir um item oferece a ação de abrir o painel. Avisos críticos também podem aparecer no topo das fontes de um filme.

Se o catálogo não aparecer, remova e instale o addon novamente: o Stremio pode ter guardado o manifesto antigo. `STATUS_CATALOG=off` desliga o recurso. Os cartões são SVG; clientes sem suporte ainda podem mostrar o texto.

Em outro aparelho, `127.0.0.1` aponta para esse aparelho. Alterar as URLs requer configuração de rede, e o link do painel continua local. Veja as [limitações de LAN](seguranca.md#rede-local-e-contêineres).

## Biblioteca local e demonstração

A biblioteca local lê `.torrent` em `DATA_DIR/torrents`; sua presença não significa que o vídeo esteja baixado ou que seja freeleech. Não compartilhe esses arquivos ou importe credenciais alheias.

`DEMO_MODE=true npm start` adiciona uma fonte externa para **Big Buck Bunny (2008)**. Ela depende de um servidor público e não valida login, tracker privado, seed ou reprodução pela ponte. A integração online continua voltada a filmes, mesmo que o parser aceite identificadores de episódios.

Para consultar ou mudar portas, modo local/LAN e políticas sem o painel, use a [configuração pelo terminal](configuracao.md#configuração-pelo-terminal).
