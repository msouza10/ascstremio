# ASCStremio

Addon independente para usar sua conta do Amigos Share (ASC) no Stremio, com reprodução por uma ponte local e acompanhamento das obrigações de seed.

**Uma conta, uma pessoa, uma instalação.** O projeto não fornece conteúdo nem credenciais. A máquina que executa o ASCStremio baixa e compartilha os arquivos por BitTorrent; ela precisa permanecer ligada durante o seed. Não exponha os serviços HTTP à internet nem ofereça acesso a terceiros.

## O que você encontra

- Busca de filmes no ASC e fontes com informações de qualidade, áudio, tamanho e freeleech.
- Reprodução sob demanda: listar fontes não baixa o `.torrent` nem entra no swarm.
- Painel local para acompanhar conta, downloads, espaço em disco, seed e logs.
- Retomada de torrents pendentes e conciliação com o tracker, que decide se o seed foi cumprido.
- Instalação Linux, Docker/Podman e Windows; execução manual com Node.js 22 ou superior.

A integração online cobre **filmes com um vídeo principal**. Coleções com vídeos de tamanhos parecidos e imagens de disco não são reproduzidas. Veja [compatibilidade e funcionamento das fontes](docs/uso.md).

## Comece aqui

No Linux, instale pelo script do GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/msouza10/ascstremio/main/scripts/install-remote.sh | \
  ASCSTREMIO_BASE_URL=https://github.com/msouza10/ascstremio/releases/latest/download bash
```

Para Docker/Podman, use a imagem pronta **`ghcr.io/msouza10/ascstremio:latest`**, conforme o [guia de instalação](docs/instalacao.md#usar-a-imagem-pronta-do-ghcr). O guia também cobre Windows e acesso autenticado quando o repositório ou pacote são privados.

Para executar a partir do código, com Node.js 22+ e npm disponíveis:

```bash
npm ci
npm start
```

1. Abra o painel em **http://127.0.0.1:7020/** e conecte sua conta individual do ASC. O filtro **somente freeleech** começa ativado.
2. Configure sua passkey conforme o [guia de instalação](docs/instalacao.md#passkey-do-tracker). A senha de login e a passkey têm funções diferentes.
3. Emita a credencial de reprodução com `npm run credenciais -- garantir` (o instalador Linux já faz isso) e instale no Stremio a URL `http://127.0.0.1:7000/<credencial>/manifest.json` que ele mostra, uma única vez. Detalhes em [segurança](docs/seguranca.md#credenciais-de-instalação-do-addon).
4. Em Descobrir → Filmes, abra **ASC — filmes**. Use **ASC — status** e o painel para acompanhar pendências.

Use `npm start`, que inclui a opção de cabeçalhos HTTP exigida pela integração. Se já houver uma instalação em execução, pare-a antes de iniciar outra com as mesmas portas e pasta de dados.

## Antes de assistir

O padrão `AFTER_SEED=delete` **apaga os arquivos de vídeo depois que o tracker confirma o cumprimento do seed**. Use `stop` para manter os arquivos ou `keep` para continuar semeando. Reproduzir um filme removido pode baixar tudo novamente e gerar nova obrigação.

Freeleech não dispensa seed. O aplicativo acompanha a meta de 72 horas ou ratio 1,0 por torrent, o prazo de hit-and-run e a inatividade da conta; isso não garante que sua conta esteja regular. Leia [seed e regras operacionais](docs/seed.md) e confira as regras atuais no ASC.

## Documentação

| Preciso de… | Onde ler |
|---|---|
| Instalar, conectar a conta e configurar a passkey | [Instalação](docs/instalacao.md) |
| Entender fontes, reprodução, painel e status no Stremio | [Uso](docs/uso.md) |
| Alterar portas, diretórios e políticas | [Configuração](docs/configuracao.md) |
| Entender seed, conclusão e liberação dos arquivos | [Seed e regras operacionais](docs/seed.md) |
| Atualizar, fazer backup ou investigar um erro | [Manutenção e diagnóstico](docs/manutencao.md) |
| Entender exposição de rede e proteção dos dados | [Segurança](docs/seguranca.md) |
| Conhecer componentes e rotas | [Arquitetura e interfaces](docs/arquitetura.md) |
| Contribuir, testar ou montar pacotes | [Desenvolvimento e releases](docs/desenvolvimento.md) |

O [índice dos guias](docs/README.md) organiza a leitura por tarefa. O [changelog](CHANGELOG.md) registra as versões.

## Limites atuais

Os serviços HTTP ficam no loopback do host por padrão. O modo LAN é opcional e tem limitações; a administração da ponte exige um token próprio (`admin-key`), separado das credenciais de reprodução, que são individuais e revogáveis. A porta de peers BitTorrent tem exposição diferente dos serviços HTTP. Consulte [segurança e rede](docs/seguranca.md) antes de alterar a instalação.

A auditoria completa do histórico e a validação das regras do ASC para distribuição pública estão pendentes ([#11](https://github.com/msouza10/ascstremio/issues/11), [#14](https://github.com/msouza10/ascstremio/issues/14)). O código é distribuído sob a [licença MIT](LICENSE). O uso de conta individual não equivale a autorização do tracker nem concede direitos sobre conteúdo de terceiros.

Para contribuir, leia o [guia de contribuição](.github/CONTRIBUTING.md) e o [código de conduta](.github/CODE_OF_CONDUCT.md). Vulnerabilidades devem seguir a [política de segurança](.github/SECURITY.md).
