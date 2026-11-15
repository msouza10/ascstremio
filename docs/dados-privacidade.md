# Dados, comunicações e ciclo de vida

Inventário da implementação revisto em 15/11/2026, para a issue #101. Não é certificação
jurídica nem auditoria integral de bibliotecas/serviços externos. Não foram usadas contas
ou torrents reais nesta análise.

## Armazenamento da instalação

O processo do aplicativo escreve os dados locais; quem administra a máquina controla
pastas, permissões e backups. O projeto não dispõe de remoção remota. `DATA_DIR` vem do
ambiente ou é `private/` ao lado do código. Instaladores têm caminhos próprios descritos em
[instalação](instalacao.md); no contêiner é `/data`. `ASC_TORRENT_DIR` e `BRIDGE_STORE` podem
ficar fora dela. Arquivos com segredos não são um cofre criptografado: permissões Unix
0600/0700 reduzem acesso; no Windows a proteção depende das permissões da conta/pasta.

Na tabela, nomes são relativos a `DATA_DIR`, salvo indicação. “Sem prazo automático”
descreve a ausência de expiração pelo programa, não uma obrigação de conservar para sempre.

| Arquivo/estado | Origem e finalidade | Retenção/remoção e fonte no código |
|---|---|---|
| `settings.json` | Opções do operador e revisão da configuração | Sem prazo automático. `configurar` altera/remove opções; recuperação isola o arquivo quebrado e conserva cópia. `settings.js`, `config-admin.js`, `panel-settings.js` |
| `service.env` e ambiente | Configuração de partida; podem incluir segredos do operador | Até alteração na origem. Reiniciar se necessário; não apagar como limpeza de logs. Instaladores, `settings.js`, `index.js` |
| `passkey.txt` | Passkey do operador para montar announce em memória | Sem prazo automático; apagar cópia local não revoga no ASC nem remove cópias em torrents/backups. `passkey.js`, `index.js` |
| `asc-session.json` | Cookies da sessão ASC e data de login | Sobrescrito ao salvar; logout local remove o arquivo e limpa sessão em memória, sem prometer revogação de sessões no site. `asc-client.js` |
| `credentials.json` | Verificadores SHA-256, nome/permissão e datas das credenciais de player | Sem prazo automático; revogação mantém registro. Último uso fica só em memória e reinicia com processo. `credentials.js` |
| `admin-key` | Token administrativo gerado pelo aplicativo | Persiste até rotação operacional, independente do player e da passkey. Trocar conforme segurança. `index.js`, ponte e CLIs |
| `panel-admin.json` | Verificador scrypt com sal da senha administrativa | Até alterar/remover pelo CLI administrativo. `admin-auth.js`, `admin-cli.js` |
| Sessões administrativas/cookie | Cookie identificador e estado em memória: verificadores, Host, datas e limites | Expiram conforme configuração, logout, troca/remoção da senha ou reinício. Navegador tem ciclo próprio do cookie. `admin-auth.js`, `config-server.js` |
| `wizard.json` | Modo e datas de conclusão/adiamento do assistente | Sem prazo automático; não comprova ciência contratual/autoral. `panel-settings.js` |
| `torrents/*.torrent` ou `ASC_TORRENT_DIR` | Metadados recebidos do ASC/adicionados localmente; podem conter passkey | Sem prazo geral automático. Remover prejudica retomada e identificação de obrigações; não são os vídeos. `asc-provider.js`, `library.js`, `bridge.js` |
| `cache/` ou `BRIDGE_STORE` | Vídeos/partes recebidos pelo motor para reprodução e seed | Políticas/ações de seed e retenção controlam remoção; `AFTER_SEED=delete` pode excluir após confirmação operacional. `bridge.js`, `seed-actions.js`, `retention-service.js` |
| `seed-vault.json` | Hashes, nomes, caminhos, contadores e observações do tracker | Sem prazo automático; liberar vídeos não apaga necessariamente o histórico. Apagar cofre não cancela obrigação no tracker. `seedvault.js`, `hnr-guard.js` |
| `meta-cache.json` | IMDb, IDs/nomes/tamanhos/selos de releases para apresentação | Até 300 títulos/512 KiB; registros com mais de 90 dias deixam de valer na leitura. Limpeza lógica não garante apagar imediatamente o arquivo antigo; regravação o substitui. Não autoriza download. `meta-cache.js` |
| `alert-webhook.json` ou arquivo externo escolhido | URL secreta e bearer opcional do operador | Remover destino local exige alertas desligados; ambiente/arquivo imposto muda na origem. Não revoga token externo. `alerts.js`, CLI/painel |
| `alerts-state.json` | Datas de aviso/recuperação e último resultado para deduplicação | Sem prazo automático; remover destino não apaga histórico. Fila é só memória e limpa ao trocar/remover destino. `alerts.js`, `loadState`, `saveState` |
| `logs/ascstremio-AAAA-MM-DD.log` e buffer | Eventos/erros, identificadores e possíveis hábitos; segredos conhecidos redigidos | Buffer até 5000 entradas; retenção em disco configurável, padrão 14 dias, limpeza em execução. Exportações/backups independentes. `logger.js`, `config-server.js` |
| `service.log`, journald, logs de contêiner/terminal | Saída do processo coletada pelo launcher/hospedeiro | Retenção não é controlada por `LOG_RETENTION_DAYS`. Verificar o sistema de execução e seus backups |
| `peer-port-status.json` | PID, horário e contagens/estado das conexões, sem lista de IPs de peers | Snapshot atualizado em execução pode sobreviver ao reinício; não prova alcance público. `network.js` |
| `.ascstremio.lock`, travas e temporários | PID, host e marcações para exclusividade/escrita atômica | Trava removida na parada limpa; queda pode deixar arquivo. Confirmar ausência de instância antes de remover. `instance-lock.js` e escritores |
| `.tmp`, `.quebrado-*`, backups e exportações | Recuperação/cópias do programa ou operador | Não há limpeza geral garantida. Inventariar também cópias fora de `DATA_DIR`. `config-admin.js`, manutenção |

## Navegador e players

`localStorage` guarda o tema (`monitor.theme`). `sessionStorage` guarda rascunhos do
assistente (`ascstremio.wizard`) e URLs recém-emitidas (`ascstremio.urls`), que contêm
credenciais reutilizáveis. Revogar/substituir pelo painel remove a entrada correspondente
da aba, não cópias em outras abas, clipboard, Stremio ou backups do navegador.

Armazenamento de sessão acompanha a aba; restauração do navegador pode preservá-lo.
Fechar aba/limpar dados de site não revoga credenciais no servidor. Players e sistema
podem guardar URLs, histórico, caches e buffers fora do controle do addon.
Fontes: `src/ui/theme.js`, `app.js`, `settings.js`, `addon-auth.js`, `credentials.js`.

## Comunicações identificadas

| Origem → destino | Dados/finalidade | Quando e controle |
|---|---|---|
| Instalação → ASC | Login, cookies, buscas, IDs e consultas de conta/histórico | Conexão/rotinas da conta. `asc-client.js` limita sua origem HTTP ao ASC; o site controla seus registros |
| Instalação → Cinemeta | Título/IMDb e metadados; IP/metadados da conexão | Catálogo/identificação, `addon.js` e `providers/amigos-share.js` |
| Motor → tracker/peers | Endereço da conexão, identificador do torrent, contadores e partes de arquivos | Download/seed, inclusive retomada. Destinos de metadados/importados seguem na #98; sem anonimato garantido |
| Painel/player → instalação | Requisições locais/LAN e credenciais em URLs | Uso/configuração. HTTP LAN pode expor token na rede; ler segurança |
| Instalação → webhook escolhido | Mensagem; em JSON também formato, ID do evento, tipo, gravidade, situação, horário e contagem opcional | Desligado por padrão. Texto pode incluir contagem; receptor recebe também IP/metadados da conexão |
| Instaladores/gerenciadores → distribuidores | Pedidos de código, imagem, binários/dependências e metadados de conexão | Conforme instalação/atualização: GitHub/GHCR, Node, npm e hosts de componentes, com condições próprias |
| Player/navegador → origens externas de artes/metadados/amostras | Recursos indicados pelo conteúdo/cliente | Depende do player/URL; não implica tráfego centralizado pelo mantenedor |
| Pessoa → suporte escolhido | Material decidido pela pessoa | Envio voluntário, distinto da operação local; não há envio automático de logs ao mantenedor nesta entrega |

O payload atual do webhook não contém títulos, hashes, caminhos, ratio, cookies ou
credenciais. URL/bearer autenticam a entrega: o destino deve ser confiável mesmo sem
segredos na mensagem. Os campos exibidos no painel vêm do conjunto permitido no servidor;
formato texto envia só mensagem. Testar envia mensagem sintética, mas faz requisição real
ao destino e exige habilitação. Remover o destino não remove mensagens já recebidas.

Limite: não foi inspecionado todo o tráfego transitivo de dependências, navegadores e serviços
externos. Desabilitar DHT/PEX não comprova ausência de outros destinos nos metadados.

## Efeitos das ações

| Ação | Efeito local | O que não faz |
|---|---|---|
| Logout ASC | Descarta cookies/conta em memória e remove `asc-session.json` | Não revoga passkey, URLs do player, sessões no site ou obrigações existentes |
| Sair da administração | Encerra sessão administrativa correspondente | Não sai da conta ASC, revoga players ou apaga arquivos |
| Revogar/substituir player | Invalida token antigo e derruba streaming; registro permanece | Não encerra seed, revoga passkey ou apaga cópias externas da URL |
| Desligar alertas | Impede entregas pelo gerenciador; destino permanece | Não apaga mensagens entregues nem revoga token do serviço receptor |
| Remover destino com alertas desligados | Remove arquivo local e fila em memória | Não apaga `alerts-state.json`, arquivo imposto pelo ambiente ou registros do receptor |
| Limpar vídeos por ação suportada | Aplica as condições operacionais daquele caminho | Não remove automaticamente torrents, histórico, backups ou registro no tracker |
| Desinstalar Linux/Windows ou remover contêiner sem apagar volume | Retira serviço/programa conforme instalador | Dados separados/volumes permanecem. Excluir volume explicitamente pode impedir seed |

Não existe nesta entrega função de apagar todos os dados ou garantia de apagamento seguro
de SSD, backups e registros remotos.

## Desenho de uma futura prévia de limpeza

Antes de remoção geral, a prévia deve listar categorias/caminhos resolvidos, origem/volume,
finalidade e alcance, sem imprimir segredos. Separar logs/cache recriável, credenciais,
histórico de seed, vídeos e backups, mostrando pendências/revogações externas. Dado
desconhecido não pode ser considerado livre. Execução futura exige seleção e confirmação,
revalidação de instância/uso, contenção de caminhos e rejeição de links indevidos.
Não apagar seed pendente silenciosamente nem destruir cofre para “resolver” obrigação.
Nenhuma remoção geral foi implementada pela #101.

## Suporte

Prefira exemplos sintéticos e o mínimo de dados após revisão. Dados voluntariamente
recebidos pelo mantenedor precisam de finalidade, acesso, retenção e atendimento próprios,
conforme a avaliação aplicável à atividade. A exceção de uso particular do operador não
decide automaticamente o enquadramento do suporte. O canal jurídico segue na #95;
não envie dados sensíveis em issues públicas.

Veja [segurança](seguranca.md), [manutenção](manutencao.md), [avisos legais](../LEGAL.md)
e [matriz de execução](conformidade-juridica.md).
