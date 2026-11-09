# Desenvolvimento e releases

Leia [AGENTS.md](../AGENTS.md) antes de alterar o código. Ele concentra os padrões de contribuição, invariantes e convenções de commits. Os guias de usuário ficam em [docs/](README.md); tarefas e pendências pertencem às issues.

## Ambiente local

Node.js 22+ e npm, CommonJS, sem build ou TypeScript. A UI usa JavaScript puro e assets locais.

```bash
npm ci
npm run dev
```

`dev` usa watch e a opção `--max-http-header-size=65536`, assim como `start`. Não troque pelo lançamento direto de `src/index.js` sem essa opção. Para uma instância separada, use os [exemplos de configuração](configuracao.md#exemplo-de-instância-separada).

## Verificações

```bash
npm run check
scripts/check-no-secrets.sh .
shellcheck -S warning scripts/*.sh windows/build.sh
actionlint .github/workflows/*.yml
```

`npm test` chama a mesma verificação de sintaxe da UI e testes `node:test`. Os testes não devem usar rede real, conta ASC, `private/` ou caminhos específicos da máquina. Para um arquivo: `node --test test/seed-policy.test.js`.

Mudanças em scripts precisam passar shellcheck; alterações de workflows precisam passar actionlint. `node scripts/audit-check.js` consulta a auditoria de dependências com exceções justificadas no próprio script; essa etapa exige acesso ao registro. Não adicione dependências sem necessidade.

## Documentação pública e notas privadas

`scripts/documentation-files.txt` enumera os guias públicos. O `.gitignore` libera somente esses nomes em `docs/`; outros documentos, imagens, capturas e sondas locais continuam ignorados. Ao adicionar um guia:

1. Crie conteúdo sem dados de conta e registre o caminho na lista pública.
2. Adicione a exceção exata correspondente no `.gitignore`.
3. Inclua um link no índice e confira os links relativos.
4. Execute a barreira de segredos na árvore e no pacote gerado.

O empacotamento Linux e Windows copia somente os guias enumerados. Não use `cp -R docs` nem `git add -f docs`: a pasta pode conter notas privadas antigas. A imagem não inclui documentação local; leia os guias no repositório ou no pacote.

Regras operacionais ficam no guia de seed, configuração no seu próprio guia e decisões pendentes nas issues. Evite copiar tabelas completas para README e AGENTS; prefira links. Não apresente uma correção proposta como comportamento atual.

## Gerar e conferir pacotes

```bash
scripts/build-release.sh --base-url https://example.invalid
scripts/check-no-secrets.sh dist/ascstremio-latest.tar.gz
scripts/smoke-install.sh dist
```

O endereço acima é apenas exemplo: substitua pelo destino real para distribuir. O script gera tarball versionado, cópia `latest`, hashes e instalador remoto. `--windows` também chama o build do instalador, e `--docker` constrói/exporta a imagem. Essas opções podem baixar dependências e precisam das ferramentas correspondentes.

O Windows usa NSIS (`makensis`), Node oficial com hash conferido e dependências nativas win32-x64. `windows/build.sh --stage-only` prepara a árvore sem compilar o instalador. Não use `--ignore-scripts` na instalação de dependências dessa distribuição.

A imagem é validada com `scripts/smoke-container.sh <imagem>`. Os testes de fumaça Linux/contêiner usam portas 17000–17020 para evitar a instalação principal. Não execute fumaça em uma pasta de dados real.

## CI e release

A CI testa Ubuntu e Windows com Node 22 e 24, scripts/workflows, segredos, auditoria, pacote Linux, imagem e instalador Windows. O teste Windows instala em silêncio, inicia e consulta os servidores. Esses testes não usam o tracker real nem validam codecs do player.

Os títulos seguem o [padrão de commits](../.github/COMMIT_CONVENTION.md) em português. `feat` sobe a versão menor em 0.x; `fix`, `perf` e `security` sobem a correção. Consulte AGENTS para os demais tipos e quebras de compatibilidade.

Pushes na main alimentam o PR do release-please. Mesclar esse PR cria um release rascunho; a esteira monta/verifica os artefatos, publica a imagem e só então publica o release. Não edite à mão `CHANGELOG.md`, `.release-please-manifest.json` ou `version` em `package.json`, nem crie tags manualmente. A existência do workflow não comprova que uma execução específica passou: confira a execução no GitHub.
