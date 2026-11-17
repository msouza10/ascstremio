# Contribuindo com o ascstremio

Obrigado por ajudar. Este guia é o caminho curto; os detalhes técnicos (mapa do código,
invariantes de segurança, armadilhas) estão em [`AGENTS.md`](../AGENTS.md) e o uso em
[índice de documentação](../docs/README.md). O [guia de desenvolvimento](../docs/desenvolvimento.md)
explica ambiente, verificações e empacotamento.

## Antes de começar

- É um programa **pessoal**: usa a conta e a passkey de quem instalou (regra 2.2 do Amigos Share).
  Não aceitamos mudanças que o tornem um serviço compartilhado, exponham a ponte à internet ou
  enfraqueçam as proteções locais (veja "Invariantes de segurança" no `AGENTS.md`).
- **Nunca** coloque em issue, PR, log ou commit: passkey, cookies, `.torrent`, conteúdo de `private/`
  ou capturas do site logado. Vulnerabilidades: não abra issue pública; avise o dono do repositório
  em privado.

## Preparar o ambiente

```bash
git clone https://github.com/msouza10/ascstremio.git && cd ascstremio
npm ci                 # Node 22+
npm run check          # sintaxe da UI + documentação + testes (os mesmos do CI)
# instância de teste, sem tocar nos seus dados:
DATA_DIR=/tmp/ascstremio PORT=18000 BRIDGE_PORT=18010 CONFIG_PORT=18020 npm start
```

## Fluxo

1. Crie uma branch a partir da `main` (`feat/…`, `fix/…`).
2. Faça a mudança **com teste** em `test/` (`node:test`, sem rede e sem dados reais).
3. Rode antes de enviar (o `npm run check` também confere a documentação com `scripts/check-docs.js`;
   se falhar, corrija o texto conforme a mensagem `arquivo:linha: [regra]`, veja o
   [guia de desenvolvimento](../docs/desenvolvimento.md#verificações)):
   ```bash
   npm run check
   scripts/check-no-secrets.sh .
   shellcheck -S warning scripts/*.sh windows/build.sh     # se mexeu em shell
   actionlint .github/workflows/*.yml                      # se mexeu em workflows
   ```
4. Abra o pull request. O CI roda testes em Ubuntu e Windows (Node 22 e 24), lint, auditoria,
   pacote, imagem Docker e o instalador do Windows instalado de verdade. Tudo precisa passar.
5. Os **títulos dos commits** seguem o [padrão de commits e changelog](COMMIT_CONVENTION.md): eles
   decidem a versão e as notas do release.

## Estilo

Código e comentários em português do Brasil (com acentuação), comentários explicando o *porquê*,
aspas simples e ponto e vírgula; siga o arquivo que estiver editando. Sem dependências novas sem
necessidade. O código precisa funcionar em Linux, Windows e contêiner.

## Capturas para a apresentação

As capturas em `docs/imagens/` mostram a interface real com dados fictícios. Nunca capture
uma conta real. Antes de adicionar uma imagem, revise visualmente usuário, credenciais,
caminhos, títulos e logs. Use PNG sem metadados textuais/EXIF, largura máxima de 1280 px,
até 200 KiB por imagem e até 2 MiB na pasta. Toda imagem precisa de texto alternativo.
`scripts/check-no-secrets.sh` barra, em `docs/imagens/`, extensão fora de `png`/`webp`, tamanho e
largura acima desses limites e blocos de metadados (`tEXt`, `iTXt`, `zTXt`, `eXIf` no PNG; `EXIF`
e `XMP ` no WebP).

Capturas do Stremio saem de um addon de demonstração (`scripts/demo-stremio.js`): ele usa o addon
real com um ASC falso, títulos de domínio público ou licença aberta (Night of the Living Dead,
`tt0063350`, e Pioneer One, `tt1748166`) e releases inventados. Nenhuma conta, `private/` ou
credencial real é lida, e as URLs de vídeo apontam para `127.0.0.1:1`, onde nada escuta.

```bash
node scripts/demo-stremio.js            # imprime a URL do manifesto (credencial efêmera)
node scripts/demo-stremio.js --status   # inclui o catálogo "ASC — status" com dados fictícios
DEMO_STREMIO_PORT=18030 node scripts/demo-stremio.js   # porta fixa (padrão: efêmera)
```

Instale a URL impressa no Stremio (Addons > instalar por URL), abra o filme e a série (S01E01 mostra
as fontes; S01E06, o aviso de release não suportado) e fotografe. Desinstale o addon depois; Ctrl+C
apaga a pasta temporária.

`docs/imagens/social-preview.png` (1280x640) é a imagem de pré-visualização do repositório. O
GitHub não tem API para ela: quem tem permissão de administrador a envia em Settings > Social
preview. É montada a partir de uma captura do painel em tema escuro, sem logotipos de terceiros.

Libere cada nome exato no `.gitignore` (depois de `*.png`) e em
`scripts/documentation-files.txt`. As imagens acompanham o tarball Linux e o instalador
Windows para manter os links relativos do README disponíveis offline; a imagem Docker
continua sem os guias de `docs/`.

Para regenerar, com Node.js 22+ e um Chrome instalado:

```bash
node scripts/demo-capturas.js
# Em outro terminal; CHROME_BIN permite indicar o executável do Chrome:
node scripts/capturar-telas.js dist/capturas
```

A demonstração usa as portas locais 18020 e 18022 e uma pasta temporária, sem conectar ao
ASC ou iniciar torrents. Encerre-a com Ctrl+C. Confira as novas imagens antes de substituir
os arquivos públicos; a captura não os sobrescreve automaticamente. Atualize a versão e a
data indicadas no README conforme a interface capturada, sem alterar a versão do pacote.

## Releases

Não crie tags nem edite `CHANGELOG.md`, `.release-please-manifest.json` ou a `version` do
`package.json`: o *release-please* mantém um PR "chore(main): release X.Y.Z" e, ao mergeá-lo, a
esteira publica o pacote Linux, o instalador Windows e a imagem no GitHub Packages.

## Licença

Ao contribuir, você concorda que sua contribuição é licenciada sob a [licença MIT](../LICENSE) do projeto.
