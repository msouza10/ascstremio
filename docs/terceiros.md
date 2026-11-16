# Componentes e materiais de terceiros

A MIT em `LICENSE` cobre o código próprio do ascstremio. Dependências, binários,
metadados e obras têm termos próprios. Um identificador de licença, crédito ou
aviso não comprova autorização para usar conteúdo remoto.

## Inventário reproduzível

Sem instalar dependências, execute:

```bash
node scripts/license-inventory.js . /tmp/inventario-lock.json
```

O resultado enumera candidatos de produção do `package-lock.json`, incluindo
opcionais de outras plataformas. Registra versão, origem e integridade. O
lockfile não traz licença, então nesse modo `licencaDeclarada` vale `desconhecida`
(e o componente entra em `atencao`). Não é uma lista de componentes instalados.

Depois de `npm ci`, acrescente `--installed` para examinar a árvore montada:

```bash
node scripts/license-inventory.js . /tmp/inventario-instalado.json --installed
```

Esse modo lê `name` e licença do `package.json` de cada pacote (`license` string
SPDX, `license` objeto legado ou o campo legado `licenses[]`), filtra pacotes ausentes, localiza textos de licença/avisos dentro de
cada pacote e registra SHA-256 dos arquivos nativos encontrados. Os caminhos são
relativos à raiz examinada. Os textos permanecem junto aos componentes; o JSON
não os substitui. Ausência de texto é uma pendência de revisão, não aprovação.
O comando não acessa a rede nem lê dados da conta.

## Itens que requerem revisão

O JSON traz a lista `atencao` (e o campo `atencao` em cada componente). Regras
simples: só `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0` e `0BSD`
isolados dispensam atenção; todo o resto requer revisão humana. Motivos:
`copyleft-fraco` (MPL, LGPL, EPL, CDDL), `copyleft` (GPL, AGPL etc.),
`licenca-composta` (OR/AND/WITH), `licenca-incomum`, `campo-legado`,
`licenca-desconhecida`, `manifesto-ilegivel` e `sem-texto-de-licenca`
(nenhum LICENSE/NOTICE no diretório instalado). Não é conclusão jurídica: a
ausência de um item não significa aprovação.

Resultado sobre a árvore de produção instalada (`npm ci --omit=dev`, Linux,
309 componentes; varia com a plataforma e com as dependências):

| Componente | Motivo | Observação |
|---|---|---|
| `node-datachannel` 0.32.3 (MPL 2.0) | copyleft-fraco | MPL é copyleft por arquivo: revisar a obrigação de oferecer o código-fonte dos arquivos MPL ao distribuir. |
| `expand-template` (MIT OR WTFPL), `rc` (BSD-2-Clause OR MIT OR Apache-2.0) | licenca-composta | Escolher e registrar a opção adotada. |
| `sax` (BlueOak-1.0.0) | licenca-incomum | Ler os termos. |
| `limiter` | campo-legado | Declara via `licenses[]`; confirmar o texto. |
| 15 a 17 pacotes (entre eles `ip`, `tr46`, `cookie-signature`, `default-gateway`, `err-code`, `uint8-util`, `webrtc-polyfill`) | sem-texto-de-licenca | Sem arquivo LICENSE/NOTICE no diretório; obter o aviso no repositório de origem. |

## Fonte Inter (SIL OFL 1.1)

`src/ui/assets/inter-*.woff2` é a fonte Inter, sob a SIL Open Font License 1.1,
desde a primeira versão do repositório. O texto da licença e o aviso
"Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)"
estão em `src/ui/assets/INTER-LICENSE.txt`, cópia literal do `LICENSE.txt` do
repositório upstream `rsms/inter` (commit `3ac1bd32a473`; o SHA-256 do
arquivo começa com `262481e8` e confere com `sha256sum`). Como
fica dentro de `src/`, acompanha a fonte no tarball, no instalador Windows e na
imagem Docker. Pendente: o histórico não registra a versão do Inter nem a
origem exata dos `.woff2` (download ou subconjunto); confirmar com o dono. Os
arquivos não foram modificados por este PR.

## Entrega por formato

| Formato | Evidência gerada | Textos e limites |
|---|---|---|
| Tarball Linux | `THIRD-PARTY-INVENTORY.json` do lockfile | O pacote contém fontes; `node_modules` é instalado depois. Gerar o modo instalado na instalação para conferir a plataforma efetiva. Node é obtido pelo instalador, não faz parte desse tarball. |
| Windows | `app/THIRD-PARTY-INVENTORY.json` e `RUNTIMES-INVENTORY.json`, caminhos relativos ao diretório que contém cada JSON | Gerado após instalar e filtrar binários. `node/LICENSE` acompanha `node.exe`; os avisos npm permanecem em `app/node_modules`. `WinSW-LICENSE.txt` vem da tag v2.12.0 e tem SHA-256 conferido; a composição do binário exige revisão própria. |
| Docker | `/app/THIRD-PARTY-INVENTORY.json` e `/app/DEBIAN-PACKAGES.txt` | Árvore npm da etapa de dependências e nomes/versões/arquiteturas Debian na imagem final. Textos Debian em `/usr/share/doc`; conferir também avisos Node da imagem base. |

O inventário npm não decompõe bibliotecas incorporadas nos binários de
`node-datachannel`, `utp-native` ou outros componentes. A lista Debian não é um
parecer sobre licenças nem garante que todos os textos exigidos estejam presentes.
A revisão de um release deve examinar o artefato de cada arquitetura, incluindo
Node e WinSW, seus textos, fontes de distribuição e obrigações aplicáveis.

## Materiais externos e pendências

Cinemeta fornece metadados e imagens por serviços externos; esses materiais não
integram automaticamente a licença MIT do projeto. A amostra Big Buck Bunny,
logos, nomes de serviços e eventuais capturas exigem verificação de fonte,
licença e alcance da permissão antes da redistribuição. Não há conclusão de
permissão nesses inventários. Evite afirmar endosso de ASC, Stremio ou fornecedores.

A issue #103 continua responsável pela revisão humana de termos e permissões,
composição dos binários e validação dos artefatos reais de Linux, Windows e
Docker. Alterar dependências exige regenerar os inventários e conferir os avisos;
não se altera `LICENSE` nem a versão manualmente para essa atualização.

## Fontes públicas conferidas em 16/11/2026

- A [documentação oficial do SDK Stremio](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md#getting-metadata-from-cinemeta)
  descreve consultas ao Cinemeta. `src/addon.js` repassa a URL de poster recebida;
  `src/providers/amigos-share.js` consulta nomes. Isso não demonstra licença geral
  para redistribuir imagens. Os [termos Stremio](https://www.stremio.com/tos),
  com data efetiva de 30/08/2020, devem integrar a revisão de alcance da integração.
- A [página oficial de Big Buck Bunny](https://peach.blender.org/about/)
  identifica a obra sob [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/),
  com atribuição, e distingue logos/marcas e materiais de capa/disco. A URL da
  amostra no código usa um bucket Google: a licença da obra não comprova a
  integridade nem os créditos dessa cópia específica. Conferir a cópia e sua
  atribuição antes de considerá-la validada.

Essas fontes identificam evidências para revisão; não encerram as pendências de
permissão, composição dos artefatos ou análise qualificada da issue #103.
