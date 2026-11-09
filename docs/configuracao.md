# Configuração

As variáveis são lidas na inicialização. Reinicie a instância depois de alterar o ambiente. A aplicação não carrega `.env` automaticamente.

## Precedência e arquivo persistente

Cada opção vem de uma de três origens, da mais forte para a mais fraca:

1. **Ambiente** (shell, `service.env`, Compose): sempre vence e nunca é sobrescrito por outra origem.
2. **Arquivo `DATA_DIR/settings.json`** (modo `0600`, gravado de forma atômica, com `version` e `revision`): usado pelas interfaces de configuração que vierem (terminal e painel). Não precisa existir e não é criado na partida; quem usa só variáveis de ambiente continua exatamente como antes.
3. **Padrão** do esquema (tabelas abaixo).

Regras que valem para qualquer origem:

- Variável vazia conta como ausente.
- Valor inválido, arquivo corrompido ou de versão mais nova, e combinação insegura **recusam a partida** com a lista de problemas; nada cai silenciosamente em padrão (`AFTER_SEED=delete` apaga arquivos).
- Segredos (`PASSKEY`, `ANNOUNCE_BASE`) e `DATA_DIR`, `PASSKEY_FILE`, `BRIDGE_ALLOW_LAN` e `ASCSTREMIO_CONTAINER` existem **só no ambiente**; o arquivo não os aceita e nenhuma leitura sanitizada os devolve. Senhas do ASC não são persistidas.
- Alterar uma opção que o ambiente define é recusado (a origem exibida é `env`); edite o `service.env`/Compose.
- Alterações exigem a revisão lida (`expectedRevision`); se outro processo gravou antes, a alteração é recusada e nada muda. Uma alteração inválida não toca o disco.
- Quase todas as opções só valem após reiniciar; `LOG_LEVEL` é a exceção. `ASC_TORRENT_DIR` e `BRIDGE_STORE` não movem arquivos já baixados.

### Modos local e LAN

`ASCSTREMIO_MODE` aceita `local` (padrão: addon e ponte escutam só em `127.0.0.1`) ou `lan` (escutam em todas as interfaces, para os outros aparelhos da mesma pessoa). Ele só escolhe a interface de escuta; não desliga nenhuma proteção (Host, chave `?k=`, token administrativo, painel local). `BRIDGE_ALLOW_LAN=1` continua valendo e equivale a `lan`. São recusados: `BRIDGE_ALLOW_LAN=1` com `ASCSTREMIO_MODE=local`, portas repetidas entre `PORT`, `BRIDGE_PORT`, `CONFIG_PORT` e `TORRENT_PORT`, `lan` em contêiner sem `BRIDGE_PUBLIC_URL` e `ADDON_PUBLIC_URL`, URLs com usuário/senha e `ALLOWED_HOSTS` com curinga ou porta. Voltar de `lan` para `local` não apaga seed nem dados.

- Execução manual: exporte as variáveis no terminal antes de `npm start`.
- Serviço Linux: edite `DATA_DIR/service.env`, uma variável por linha, e reinicie `ascstremio.service`.
- Compose: use `environment` no serviço; recrie o contêiner para aplicar mudanças. Um `.env` do Compose só interpola o YAML quando referenciado.
- `scripts/docker.sh run` repassa diretamente apenas `AFTER_SEED` e `LOG_LEVEL`, além dos padrões da imagem; outras opções exigem ajustar a invocação ou usar Compose.
- Windows: não há carregamento de `service.env` pelo launcher; configure o ambiente herdado pelo processo e reinicie-o.

## Credenciais e caminhos

| Variável | Padrão | Comportamento |
|---|---|---|
| `DATA_DIR` | `private/` na raiz do código | Sessão, passkey, credenciais de reprodução, cofre, torrents, cache e logs |
| `ASC_TORRENT_DIR` | `DATA_DIR/torrents` | Biblioteca local de `.torrent` |
| `BRIDGE_STORE` | `DATA_DIR/cache` | Arquivos de vídeo e dados recebidos |
| `PASSKEY` | ausente | Credencial do tracker em memória; precede a leitura do arquivo |
| `PASSKEY_FILE` | ver limitação abaixo | Opção do leitor de passkey; não altera o arquivo na inicialização atual |
| `ANNOUNCE_BASE` | Base de announce do ASC definida em `src/passkey.js` | Base usada para injetar a passkey em memória |

**Limitação de `PASSKEY_FILE`:** `src/index.js` chama o leitor passando explicitamente `DATA_DIR/passkey.txt`, e esse argumento prevalece sobre `PASSKEY_FILE`. Para o programa principal, use esse arquivo ou `PASSKEY`. Não há necessidade de definir `ANNOUNCE_BASE` em uma instalação normal.

Caminhos relativos fornecidos por variável são interpretados a partir do diretório de trabalho do processo. Prefira caminhos absolutos em serviços e instalações separadas do código.

## Rede e Stremio

| Variável | Padrão na execução manual | Comportamento |
|---|---|---|
| `PORT` | `7000` | Servidor do addon |
| `BRIDGE_PORT` | `7010` | Ponte de vídeo |
| `CONFIG_PORT` | `7020` | Painel; use sempre `http://127.0.0.1:<porta>` |
| `TORRENT_PORT` | Porta livre escolhida pelo sistema | Entrada de peers; a imagem fixa `7030` |
| `ASCSTREMIO_MODE` | `local` | `local` ou `lan`; ver acima |
| `BRIDGE_ALLOW_LAN` | desligado | `1` faz addon e ponte escutarem em todas as interfaces; não muda o painel nativo |
| `ASCSTREMIO_CONTAINER` | desligado | `1` faz os três servidores escutarem em `0.0.0.0` dentro do contêiner; a imagem já define |
| `BRIDGE_PUBLIC_URL` | Calculada a partir da interface e da porta | URL da ponte nas fontes; não muda sozinha a interface de escuta |
| `ADDON_PUBLIC_URL` | Calculada a partir da interface e da porta | Base das imagens do catálogo de status; não muda sozinha a interface de escuta |
| `ALLOWED_HOSTS` | vazio | Nomes DNS adicionais aceitos por addon/ponte, separados por vírgula |
| `STATUS_CATALOG` | `on` | `off` remove o catálogo de status e seus alertas das fontes |
| `DEMO_MODE` | desligado | `true` adiciona uma fonte de demonstração externa |

`PORT`, `BRIDGE_PORT` e `CONFIG_PORT` devem ser inteiros entre 1 e 65535. `ALLOWED_HOSTS` não muda o Host exato exigido pelo painel. Alterar a porta interna do contêiner exige ajustar a publicação da mesma porta no host para o painel. Os nomes em `BRIDGE_PUBLIC_URL`/`ADDON_PUBLIC_URL` também entram na lista de hosts aceitos por addon/ponte.

Consulte [segurança e rede](seguranca.md) antes de habilitar LAN. Não use essas opções para hospedar uma conta compartilhada.

## Seed, energia e transferência

| Variável | Padrão | Comportamento |
|---|---|---|
| `AFTER_SEED` | `delete` | Depois da confirmação do tracker: `delete` encerra e apaga arquivos; `stop` encerra e preserva; `keep` continua semeando |
| `BACKGROUND_COMPLETE` | `off` | `auto` conclui automaticamente apenas freeleech elegíveis parados |
| `BACKGROUND_IDLE_MINUTES` | `10` | Inatividade antes da conclusão automática; número ≥ 1 |
| `SEED_REQUIRED_HOURS` | `72` | Meta local; não altera a obrigação imposta pelo tracker |
| `KEEP_AWAKE` | `auto` | `off` desliga o bloqueio de suspensão; no contêiner o bloqueio não é usado |
| `BRIDGE_UPLOAD_LIMIT` | `-1` (sem limite) | Limite de upload em bytes/s |

Não reduza a meta local como forma de contornar as regras do ASC. A conciliação continua subordinada ao tracker. Veja [seed](seed.md) para os efeitos de assistir só parte de um filme e de concluir o download.

## Disco

| Variável | Padrão | Comportamento |
|---|---|---|
| `DISK_RESERVE_GIB` | `2` | Reserva absoluta de espaço livre, em GiB (número ≥ 0; `0` desliga esta parte) |
| `DISK_RESERVE_PERCENT` | `0` (desligado) | Reserva em percentual do tamanho do volume, de 0 a 90 |

A reserva vale para o volume de `BRIDGE_STORE` (inclusive disco externo ou montagem; se a pasta ainda não existe, mede o volume onde ela será criada). Quando as duas coexistem, **vale a maior**. Se o percentual está ligado e o sistema não informa o tamanho do volume, a reserva não pode ser honrada e o estado é "desconhecido".

A mesma política decide **todo novo download**: streaming sob demanda (`/s` e `/a`), conclusão em segundo plano (automática ou `POST /complete`) e retomada na partida. Um download novo só é aprovado se `livre - reserva - o que outros downloads em curso ainda vão gravar >= o que ele precisa`. A conta é feita de uma vez só, então dois filmes abertos juntos não usam a mesma folga duas vezes. Para o streaming, o necessário é o tamanho do torrent menos o que já ocupa disco (blocos alocados, pois o arquivo é esparso), porque o player pode seguir até o fim ou pular para o final; no Windows, sem arquivos esparsos garantidos, isso também cobre a escrita fora de ordem. Não se promete que 2 GiB bastem para qualquer vídeo: um filme de 40 GiB exige 40 GiB mais a reserva.

- **Recusa antes de qualquer efeito:** sem folga, o player recebe `507` e o painel mostra o motivo, sem baixar o `.torrent` (snatch), abrir o torrent nem anunciar. Em `/a/<id>` o tamanho vem da listagem; sem ele, exige ao menos a reserva livre e confere o tamanho real ao abrir o torrent.
- **Falha na medição (`statfs`):** o estado é "desconhecido" e novos downloads são recusados (`503`, com `Retry-After`), nunca tratados como espaço infinito. O que já está completo em disco continua abrindo e semeando, e nenhum torrent existente é encerrado por isso.
- **`HEAD` e listagem de fontes** continuam sem efeito: não medem para reservar, não baixam `.torrent` nem anunciam.
- **Nada é apagado** por esta política. Liberar espaço continua sendo `AFTER_SEED` e a retenção prevista na issue #27.
- O painel (e o catálogo "ASC — status") mostra livres, reserva efetiva, espaço comprometido e disponível; o alerta de bloqueio tem histerese (entra ao esgotar a folga e só sai quando sobra a maior de 256 MiB ou 10% da reserva).

## Logs

| Variável | Padrão | Comportamento |
|---|---|---|
| `LOG_LEVEL` | `debug` | Mínimo registrado: `debug`, `info`, `warn` ou `error` |
| `LOG_RETENTION_DAYS` | `14` | Retenção dos arquivos diários |

A página `/logs` permite mudar o nível durante a execução; para preservar a escolha depois de reiniciar, altere o ambiente. Consulte [manutenção](manutencao.md#logs).

## Exemplo de instância separada

Em Bash, para testar sem usar as portas HTTP e os dados da instalação principal:

```bash
DATA_DIR=/tmp/ascstremio-teste PORT=18000 BRIDGE_PORT=18010 CONFIG_PORT=18020 npm start
```

A pasta precisa ser exclusiva dessa instância. Não copie a conta real para testes automatizados. Essa configuração não simula o ASC: sem sessão e passkey, a integração autenticada continua indisponível.
