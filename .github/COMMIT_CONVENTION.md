# Padrão de commits e changelog

O projeto usa [Conventional Commits](https://www.conventionalcommits.org/pt-br/). O **título do
commit** decide a próxima versão e em qual seção do `CHANGELOG.md` a mudança aparece. A geração é
automática ([release-please](https://github.com/googleapis/release-please)); a configuração está em
[`release-please-config.json`](../release-please-config.json).

## Formato

```
tipo(escopo opcional): descrição curta no imperativo, em português

corpo opcional explicando o porquê

BREAKING CHANGE: opcional, descreve a quebra de compatibilidade
```

Exemplos: `fix(bridge): recusa Host com nome DNS` · `feat: porta de peers fixa no contêiner` ·
`feat!: remove a variável BRIDGE_PORT` · `ci: cache dos binários nativos`.

## Tipos, versão e seção do changelog

Versão semântica `MAJOR.MINOR.PATCH`. Enquanto estiver em `0.x` (`bump-minor-pre-major`), uma quebra
de compatibilidade sobe o **menor**; a partir da `1.0.0`, sobe o **maior**.

| Tipo | Quando usar | Versão | Seção no changelog |
|---|---|---|---|
| `feat` | funcionalidade nova | menor (0.1.0 → 0.2.0) | Novidades |
| `fix` | correção de bug | correção (0.1.0 → 0.1.1) | Correções |
| `perf` | desempenho | correção | Desempenho |
| `security` | endurecimento ou vulnerabilidade | correção | Segurança |
| `refactor` | reestruturação sem mudar comportamento | nenhuma | Refatoração |
| `docs` | README, AGENTS, guias | nenhuma | Documentação |
| `build` | empacotamento, Docker, instalador | nenhuma | Build e empacotamento |
| `ci` | workflows e esteira | nenhuma | Esteira (CI/CD) |
| `test` | testes | nenhuma | oculto |
| `chore` | manutenção, dependências (`chore(deps)`) | nenhuma | oculto |
| `style` | formatação | nenhuma | oculto |
| `revert` | desfaz um commit | conforme o revertido | — |

`feat!:` ou o rodapé `BREAKING CHANGE:` marcam quebra de compatibilidade em qualquer tipo.
Dependabot usa `chore(deps)`, `ci(deps)` e `build(deps)`.

## Como vira release

1. A cada push na `main`, o release-please atualiza o PR **"chore(main): release X.Y.Z"** com a
   versão nova (`package.json`, lock e `.release-please-manifest.json`) e o `CHANGELOG.md`.
2. **Mergear esse PR lança a versão**: a tag `vX.Y.Z` e o release (rascunho) são criados, a esteira
   testa, monta os pacotes, publica a imagem no GHCR e só então publica o release com as notas.
3. Publicação que falhou pode ser refeita sem versão nova:
   `gh workflow run Release -f tag=vX.Y.Z`.

Forma do `CHANGELOG.md` gerado:

```markdown
## [0.2.0](https://github.com/msouza10/ascstremio/compare/v0.1.1...v0.2.0) (2026-11-20)

### Novidades
* descrição da funcionalidade ([abc1234](…))

### Correções
* descrição do conserto ([def5678](…))
```

## Conferência

`scripts/check-commits.sh [base..head]` valida os títulos (roda nos pull requests; o histórico
anterior à adoção do padrão não é checado). Para alterar tipos, seções ou regras de versão, edite
`release-please-config.json` e atualize esta página.
