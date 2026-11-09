# Contribuindo com o ascstremio

Obrigado por ajudar. Este guia é o caminho curto; os detalhes técnicos (mapa do código,
invariantes de segurança, armadilhas) estão em [`AGENTS.md`](../AGENTS.md) e o uso em
[`README.md`](../README.md).

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
npm run check          # sintaxe da UI + testes (os mesmos do CI)
# instância de teste, sem tocar nos seus dados:
DATA_DIR=/tmp/ascstremio PORT=18000 BRIDGE_PORT=18010 CONFIG_PORT=18020 npm start
```

## Fluxo

1. Crie uma branch a partir da `main` (`feat/…`, `fix/…`).
2. Faça a mudança **com teste** em `test/` (`node:test`, sem rede e sem dados reais).
3. Rode antes de enviar:
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

## Releases

Não crie tags nem edite `CHANGELOG.md`, `.release-please-manifest.json` ou a `version` do
`package.json`: o *release-please* mantém um PR "chore(main): release X.Y.Z" e, ao mergeá-lo, a
esteira publica o pacote Linux, o instalador Windows e a imagem no GitHub Packages.

## Licença

Ao contribuir, você concorda que sua contribuição é licenciada sob a [licença MIT](../LICENSE) do projeto.
