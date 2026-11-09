# Seed e regras operacionais

Baixar e reproduzir também participa da distribuição BitTorrent. Freeleech reduz o impacto no download contabilizado, mas não elimina upload, obrigações de seed ou outras regras da conta.

Este guia descreve o modelo implementado, baseado no resumo de regras usado pelo projeto. Confira as regras atuais diretamente no ASC; o aplicativo não garante conformidade ou ausência de punições.

## Ciclo de um torrent

1. **Listagem:** consulta os metadados; não cria download nem anúncio BitTorrent.
2. **Reprodução:** o primeiro GET abre o torrent e recebe os trechos pedidos pelo player. HEAD não abre o swarm.
3. **Download parcial:** o tracker já pode registrar atividade; não presuma que manter apenas partes do arquivo quita uma pendência.
4. **Conclusão:** o download completo abre a meta de seed acompanhada pelo cofre.
5. **Conciliação:** o aplicativo consulta a atividade/histórico do ASC. O estado do tracker prevalece sobre o tempo local.
6. **Liberação:** depois da confirmação, aplica `AFTER_SEED`.

O cofre `DATA_DIR/seed-vault.json` sobrevive a reinícios e é salvo periodicamente. A contagem local avança com o torrent ativo e semeando; não é um comprovante de tempo aceito pelo tracker. Pendências são retomadas na inicialização quando os arquivos necessários estão disponíveis.

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

Por padrão, a conclusão automática está desligada. `BACKGROUND_COMPLETE=auto` considera apenas freeleech elegíveis sem atividade há `BACKGROUND_IDLE_MINUTES` (10 por padrão), com verificação de espaço em disco e prioridade baixa. Completar abre a obrigação de seed; não é uma opção para evitar a conclusão.

## O que acontece depois do cumprimento

| `AFTER_SEED` | Seed | Arquivos |
|---|---|---|
| `delete` (padrão) | Encerra | Apaga o armazenamento do torrent |
| `stop` | Encerra | Mantém no disco |
| `keep` | Continua | Mantém no disco |

Reabrir um filme cujos dados foram apagados baixa novamente e pode criar nova obrigação. O aplicativo tenta avisar nas fontes. Não apague manualmente cache, cofre ou torrents pendentes para liberar espaço: isso remove meios de cumprir o seed, sem cancelar a cobrança no ASC.

Existe uma exceção perigosa na API atual: `/cleanup?force=1` ignora a conferência de seed. Ela está sob revisão na [issue #10](https://github.com/msouza10/ascstremio/issues/10) e não deve fazer parte da manutenção normal.

## Suspensão e desligamento

`KEEP_AWAKE=auto` tenta impedir suspensão enquanto há seed pendente ou download. Usa `systemd-inhibit` no Linux, `caffeinate` no macOS e PowerShell no Windows. O bloqueio depende do sistema e termina com o processo; ele não impede desligamento, queda de energia ou interrupção da rede.

No contêiner, cuide da energia do hospedeiro. No Windows, o comando de parar encerra o processo à força, e a contagem local pode perder o intervalo desde o último salvamento. O prazo do tracker continua correndo com o programa parado.
