## O que muda

<!-- Resumo curto e o porquê. Link para a issue, se houver: "Fecha #123". -->

## Tipo

<!-- O título do PR/commit segue o padrão (.github/COMMIT_CONVENTION.md): feat, fix, perf, security, refactor, docs, build, ci, test, chore. -->

## Checklist

- [ ] O título segue [Conventional Commits](COMMIT_CONVENTION.md) (decide a versão e o changelog)
- [ ] Testes novos ou ajustados em `test/` (sem rede e sem dados reais)
- [ ] `npm run check` passa
- [ ] `scripts/check-no-secrets.sh .` passa (nenhuma passkey, cookie, `.torrent` ou `private/`)
- [ ] Funciona em Linux, Windows e contêiner (sem caminhos fixos, sem `chmod` obrigatório)
- [ ] Não enfraquece as proteções locais (127.0.0.1, `Host`, chave `?k=`, `Origin`)
- [ ] Atualizei o `README.md`/`AGENTS.md` se mudou comportamento, comando ou variável

## Como testei

<!-- Comandos executados e o resultado; prints sem dados da conta. -->
