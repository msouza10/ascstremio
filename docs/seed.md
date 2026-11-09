# Seed e regras operacionais

Baixar e reproduzir também participa da distribuição BitTorrent. Freeleech reduz o impacto no download contabilizado, mas não elimina upload, obrigações de seed ou outras regras da conta.

Este guia descreve o modelo implementado, baseado no resumo de regras usado pelo projeto. Confira as regras atuais diretamente no ASC; o aplicativo não garante conformidade ou ausência de punições.

## Upload durante a reprodução

Por padrão o upload não muda quando você assiste. Se definir `BRIDGE_STREAM_UPLOAD_LIMIT`, o upload é reduzido enquanto há reprodução ativa e volta ao normal depois. O tempo de seed (72 h) não depende de bytes enviados, mas o ratio 1.0 depende: por isso o teto reduzido nunca é zero (mínimo 16 KiB/s) e, com seed pendente, não fica abaixo de 64 KiB/s. O cofre e a conciliação com o tracker não são alterados. Detalhes em [configuração](configuracao.md#upload-durante-a-reprodução).

## Ciclo de um torrent

1. **Listagem:** consulta os metadados; não cria download nem anúncio BitTorrent.
2. **Reprodução:** o primeiro GET abre o torrent e recebe os trechos pedidos pelo player. HEAD não abre o swarm.
3. **Download parcial:** o tracker já pode registrar atividade; não presuma que manter apenas partes do arquivo quita uma pendência.
4. **Conclusão:** o download completo abre a meta de seed acompanhada pelo cofre.
5. **Conciliação:** o aplicativo consulta a atividade/histórico do ASC. O estado do tracker prevalece sobre o tempo local.
6. **Liberação:** depois da confirmação, aplica `AFTER_SEED`.

O cofre `DATA_DIR/seed-vault.json` sobrevive a reinícios e é salvo periodicamente. A contagem local avança com o torrent ativo e semeando; não é um comprovante de tempo aceito pelo tracker. Pendências são retomadas na inicialização quando os arquivos necessários estão disponíveis.

### Ordem da retomada

Na partida e depois de cada conciliação com o tracker, os seeds pendentes são abertos por **risco de hit-and-run** (regra 13.3), do mais urgente ao menos:

1. obrigação **confirmada pelo tracker** (ainda não cumprida), pelo prazo mais próximo;
2. obrigação só **local** (o cofre diz que concluiu, o tracker ainda não confirmou);
3. conclusão em segundo plano pedida, sem obrigação correndo;
4. concluído e sem obrigação (cumprido) vem por último. Hoje esses não são reabertos na partida, como antes.

Dentro de cada grupo: prazo mais próximo (prazo vencido vem antes de qualquer futuro), depois mais horas ainda devidas, depois conclusão mais antiga e, por fim, o `infoHash`, para a ordem ser sempre a mesma. O que o tracker informa (prazo, horas restantes, cumprimento) prevalece sobre o cofre. **Dado ausente conta como iminente**: um prazo desconhecido nunca empurra uma obrigação para o fim da fila. Todos os pendentes são abertos; a ordem só decide quem sai primeiro, então ninguém fica sem retomada por causa de outro.

A retomada não pula nenhuma regra: cada torrent passa pela admissão de disco, e obrigação concluída sem o arquivo completo continua sem ser aberta (aparece como "Sem arquivo para semear"; nenhum download novo é criado para completá-la). A falha ou recusa de um não impede os demais. Se a conciliação pedir uma nova retomada enquanto outra ainda roda, ela se junta à em andamento e, ao final, faz uma passada extra com a ordem refeita; nenhum torrent é adicionado duas vezes ao motor.

### Medição do custo da retomada

Abrir um torrent no motor inclui verificar os arquivos em disco; para dezenas de GB isso demora. O snapshot do painel (`resume`) mostra, para a última retomada: pendências na fila, abertos, adiados por disco, falhas, sem arquivo, tempo total, tempo até o primeiro aberto, o mais lento, bytes (tamanho dos torrents abertos, um limite superior do que foi lido), memória residente inicial e de pico, o maior atraso do laço de eventos (indica se a interface travou) e, por torrent, grupo, horas até o prazo, bytes e duração. As passadas extras de uma mesma retomada somam na mesma medição, e uma passada em que tudo já está aberto (como a conciliação horária) não apaga a medição anterior. O mesmo resumo vai ao log (`retomada: …`). Só aparecem hash curto e números: nenhum caminho, nome ou segredo. Não há contador de leitura de disco por processo; para I/O use as ferramentas do sistema durante a retomada.

A verificação continua completa: não há `skipVerify` nem confiança em bitfield salvo, porque anunciar partes inválidas após uma queda é pior que esperar. Um "fast-resume" só deve ser considerado em desenho separado, com invalidação por tamanho, mtime e conteúdo.

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

Reabrir um filme cujos dados foram apagados baixa novamente e pode criar nova obrigação. O aplicativo tenta avisar nas fontes. Não apague manualmente cache, cofre ou torrents pendentes para liberar espaço: isso remove meios de cumprir o seed, sem cancelar a cobrança no ASC.

Não existe atalho para pular a conferência de seed: `/cleanup` sempre consulta o tracker e recusa (409) o que ainda está devido. Se o tracker não puder ser consultado, nada é liberado.

## Suspensão e desligamento

`KEEP_AWAKE=auto` tenta impedir suspensão enquanto há seed pendente ou download. Usa `systemd-inhibit` no Linux, `caffeinate` no macOS e PowerShell no Windows. O bloqueio depende do sistema e termina com o processo; ele não impede desligamento, queda de energia ou interrupção da rede.

No contêiner, cuide da energia do hospedeiro. No Windows, o comando de parar encerra o processo à força, e a contagem local pode perder o intervalo desde o último salvamento. O prazo do tracker continua correndo com o programa parado.
