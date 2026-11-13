# Seed e regras operacionais

Baixar e reproduzir também participa da distribuição BitTorrent. Freeleech reduz o impacto no download contabilizado, mas não elimina upload, obrigações de seed ou outras regras da conta.

Este guia descreve o modelo implementado, baseado no resumo de regras usado pelo projeto. Confira as regras atuais diretamente no ASC; o aplicativo não garante conformidade ou ausência de punições.

## Upload durante a reprodução

Por padrão o upload não muda quando você assiste. Com `BRIDGE_STREAM_UPLOAD_LIMIT`, o upload é reduzido durante a reprodução, mas nunca a zero, porque o ratio 1.0 depende dele. Detalhes em [configuração](configuracao.md#upload-durante-a-reprodução).

## Ciclo de um torrent

1. **Listagem:** consulta os metadados; não cria download nem anúncio BitTorrent.
2. **Reprodução:** o primeiro GET abre o torrent e recebe os trechos pedidos pelo player. HEAD não abre o swarm.
3. **Download parcial:** o tracker já pode registrar atividade; não presuma que manter apenas partes do arquivo quita uma pendência.
4. **Conclusão:** o download completo abre a meta de seed acompanhada pelo cofre.
5. **Conciliação:** o aplicativo consulta a atividade/histórico do ASC. O estado do tracker prevalece sobre o tempo local.
6. **Liberação:** depois da confirmação, aplica `AFTER_SEED`.

O cofre `DATA_DIR/seed-vault.json` sobrevive a reinícios e é salvo periodicamente. A contagem local avança com o torrent ativo e semeando; não é um comprovante de tempo aceito pelo tracker. Pendências são retomadas na inicialização quando os arquivos necessários estão disponíveis.

### Ordem da retomada

Na partida e depois de cada conciliação, os seeds pendentes são abertos por **risco de hit-and-run** (regra 13.3): primeiro a obrigação confirmada pelo tracker com o prazo mais próximo, depois a obrigação só local, depois a conclusão em segundo plano. O que já foi cumprido não é reaberto. O que o tracker informa prevalece sobre o cofre, e dado ausente conta como iminente. Todos os pendentes são abertos; a ordem só decide quem sai primeiro.

Cada torrent passa pela admissão de disco, e uma obrigação sem o arquivo completo não é aberta (aparece como "Sem arquivo para semear"; nenhum download novo é criado para completá-la). A falha de um não impede os demais.

Abrir um torrent inclui verificar os arquivos em disco, o que demora para dezenas de GB. O painel mostra o custo da última retomada (`resume`) e o log traz linhas `retomada: …`, só com hash curto e números. A verificação é sempre completa: anunciar partes inválidas após uma queda é pior que esperar.

## Metas e prazos

| Condição acompanhada | Comportamento |
|---|---|
| 72 horas de seed ou ratio 1,0 no torrent | Meta de cumprimento, subordinada à confirmação do tracker |
| 12 dias sem semear | Prazo de risco de hit-and-run acompanhado pelo projeto |
| 90 dias sem acessar o site | Limite de inatividade; semear não substitui acessar o site |
| Último login desconhecido ou com pelo menos 60 dias | Aviso de inatividade |

A conciliação roda na partida e a cada hora. Falhas de acesso na partida geram novas tentativas de 15 segundos até cinco minutos. Antes da limpeza normal, o tracker é consultado novamente. Dados desconhecidos ou falhas não devem ser interpretados como seed cumprido.

A data de login guardada pelo addon é um lembrete local: acesse o ASC no navegador conforme as regras do site e renove também a sessão do addon. Avisos aparecem nos logs, painel e catálogo de status.

## Assistir só um trecho

O player pode baixar apenas as partes que usa. Para concluir o restante, abra o filme no painel e use **Concluir download em segundo plano**. A ação é explícita e pode incluir um release que não seja freeleech, com impacto no ratio.

Por padrão, a conclusão automática está desligada. `BACKGROUND_COMPLETE=auto` considera apenas freeleech elegíveis sem atividade há `BACKGROUND_IDLE_MINUTES` (10 por padrão), com a mesma verificação de espaço em disco (reserva configurável, veja [configuração](configuracao.md#disco)) e prioridade baixa. Completar abre a obrigação de seed; não é uma opção para evitar a conclusão.

## O que acontece depois do cumprimento

| `AFTER_SEED` | Seed | Arquivos |
|---|---|---|
| `delete` (padrão) | Encerra | Apaga o armazenamento do torrent |
| `stop` | Encerra | Mantém no disco |
| `keep` | Continua | Mantém no disco |
| `manual` | Continua até sua decisão | Mantém; você decide no painel |

Para decidir por conteúdo, escolha `AFTER_SEED=manual` em **Configurações** e reinicie o aplicativo quando indicado. Ao confirmar o cumprimento, o painel mostra **Continuar semeando**, **Parar seed e manter arquivos** e **Excluir arquivos e parar seed** na página do filme. A confirmação do botão deixa explícito se os arquivos serão apagados. A aplicação consulta o tracker novamente antes de agir; falhas, obrigação pendente, reprodução ou sessão recente bloqueiam a ação. A decisão é persistida: o modo manual retoma o seed após reiniciar, exceto se você já decidiu parar ou excluir. Você também pode excluir depois os arquivos de um seed que já parou. Se a exclusão falhar parcialmente (por exemplo, arquivo em uso), a parada fica salva e os dados já excluídos não são baixados de novo automaticamente; você pode tentar remover o restante depois. Escolher continuar protege esse conteúdo da liberação automática de `AFTER_SEED`; a retenção por orçamento continua sendo uma operação separada, manual e confirmada.

Excluir afeta os arquivos listados pelo torrent inteiro, não apenas o vídeo em reprodução; não há exclusão por episódio. Arquivos compartilhados com outro torrent ou caminhos inseguros são recusados; cofre, credenciais e `.torrent` são preservados.

Reabrir um filme cujos dados foram apagados baixa novamente e pode criar nova obrigação. O aplicativo tenta avisar nas fontes. Não apague manualmente cache, cofre ou torrents pendentes para liberar espaço: isso remove meios de cumprir o seed, sem cancelar a cobrança no ASC.

### Voltar a semear

Depois de **Parar seed**, a página do filme oferece **Voltar a semear** se os arquivos ainda parecem completos no disco. Confirme para verificar todas as peças do torrent antes de anunciar. A verificação lê o filme inteiro, pode levar minutos e usa a mesma fila limitada da retomada automática, sem bloquear o painel. O motor também mantém sua verificação normal: na retomada explícita, cada peça verificada renova o prazo e apenas cinco minutos sem progresso abortam a abertura.

A aplicação exige confirmação atual do tracker antes e depois da verificação. Arquivos ausentes, incompletos, alterados, compartilhados com outro título ou acessados por links são recusados. Reprodução/sessão recente, operação concorrente e quota global de reproduções cheia também bloqueiam a ação. Os arquivos completos não exigem espaço para um download novo: a reserva de disco segue a política normal de admissão.

No sucesso, a escolha vira **Manter semeando** e vale após reiniciar. Tocar o filme novamente, por si só, não altera a decisão persistida de parar. A opção não recupera arquivos excluídos nem baixa o que faltar; nesses casos, a parada é preservada e o painel informa a recusa.

## Retenção por orçamento (opcional)

`RETENTION_MODE=preview` (padrão `off`) acrescenta uma limpeza **manual e confirmada** por espaço ou número de títulos, que complementa `AFTER_SEED` sem substituí-lo. Só entra na lista o título que o tracker confirmou cumprido, e nunca um título incompleto, com obrigação aberta ou em uso. Reassistir um título removido baixa tudo de novo e abre nova obrigação de 72 h. Se o tracker não puder ser consultado, nada é liberado. As chaves estão em [configuração](configuracao.md#retenção-por-orçamento-opcional) e o uso em [manutenção](manutencao.md#retenção-por-orçamento).

## Suspensão e desligamento

`KEEP_AWAKE=auto` tenta impedir suspensão enquanto há seed pendente ou download. Usa `systemd-inhibit` no Linux, `caffeinate` no macOS e PowerShell no Windows. O bloqueio depende do sistema e termina com o processo; ele não impede desligamento, queda de energia ou interrupção da rede.

No contêiner, cuide da energia do hospedeiro. No Windows, o comando de parar encerra o processo à força, e a contagem local pode perder o intervalo desde o último salvamento. O prazo do tracker continua correndo com o programa parado.
