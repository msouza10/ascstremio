# Componentes e materiais de terceiros

A MIT em `LICENSE` cobre o código próprio do ascstremio. Dependências, binários,
metadados e obras têm termos próprios. Um identificador de licença, crédito ou
aviso não comprova autorização para usar conteúdo remoto.

Este documento registra **fatos lidos nas fontes oficiais** de cada componente, com a
URL e a data da consulta (17/11/2026). Ele não é parecer jurídico nem declara
conformidade: onde aparece "requer revisão", a decisão é de uma pessoa qualificada.

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

Mudou uma dependência, o Node ou o WinSW? Regenere os inventários e revise as seções
abaixo; nada disso exige editar `LICENSE` nem a versão do projeto. Um teste
(`test/license-inventory.test.js`) falha se este documento deixar de citar as versões
fixadas de `node-datachannel` e do WinSW.

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
309 componentes na data de 17/11/2026; muda com as dependências e a plataforma): `node-datachannel`
(copyleft-fraco), `expand-template` e `rc` (licença composta), `sax` (licença
incomum), `limiter` (campo legado) e 15 pacotes sem arquivo de licença, tratados
nas seções seguintes.

## Verificado nas fontes oficiais (17/11/2026)

| Componente | Licença (fonte oficial) | Fonte consultada | Resultado |
|---|---|---|---|
| Fonte Inter | SIL OFL 1.1 | [rsms/inter](https://github.com/rsms/inter) | versão 4.001 (`git-66647c0bb`), ver seção própria |
| Ícones Lucide | ISC, com parte MIT (Feather) | [lucide-icons/lucide LICENSE](https://github.com/lucide-icons/lucide/blob/main/LICENSE) | texto copiado para `src/ui/assets/LUCIDE-LICENSE.txt` |
| `node-datachannel` 0.32.3 | MPL-2.0 | [murat-dogan/node-datachannel](https://github.com/murat-dogan/node-datachannel/tree/v0.32.3) | ver "Código-fonte de componentes copyleft" |
| libdatachannel v0.24.2 | MPL-2.0 | [libdatachannel](https://github.com/paullouisageneau/libdatachannel/tree/v0.24.2) | embutida no binário |
| libjuice | MPL-2.0 | [libjuice](https://github.com/paullouisageneau/libjuice/tree/5948a4162d37bc213d6051b67ee2876ccc5a99a6) | embutida (cadeia de caracteres do binário Windows cita `libjuice`) |
| usrsctp (fork) | BSD-3-Clause | [usrsctp](https://github.com/paullouisageneau/usrsctp/tree/fec583d54493f879d2ae44a743423bf8a04371ab) | embutida |
| libsrtp 2.7.0 | BSD-3-Clause | [cisco/libsrtp](https://github.com/cisco/libsrtp/tree/v2.7.0) | embutida (o binário Linux traz a cadeia `libsrtp2 2.7.0`) |
| plog | MIT | [SergiusTheBest/plog](https://github.com/SergiusTheBest/plog/tree/94899e0b926ac1b0f4750bfbd495167b4a6ae9ef) | embutida (símbolos `plog` nos dois binários) |
| OpenSSL | não identificada | workflow do [node-datachannel (Windows)](https://github.com/murat-dogan/node-datachannel/blob/v0.32.3/.github/workflows/build-win.yml) | ligada estaticamente (triplet `x64-windows-static` no vcpkg do CI); a versão não é fixada pelo projeto nem identificada nas cadeias do binário |
| WinSW v2.12.0 | MIT | [winsw/winsw LICENSE.txt](https://github.com/winsw/winsw/blob/v2.12.0/LICENSE.txt) | SHA-256 do texto confere com `windows/build.sh`; ver seção própria |
| Node.js (Windows e Linux) | MIT, com lista de licenças de componentes internos | [nodejs/node LICENSE](https://github.com/nodejs/node/blob/main/LICENSE) | o `LICENSE` do próprio release é copiado ao lado do binário |
| Imagem `node:22-bookworm-slim` | Dockerfile do [nodejs/docker-node](https://github.com/nodejs/docker-node) sob MIT | [22/bookworm-slim/Dockerfile](https://github.com/nodejs/docker-node/blob/main/22/bookworm-slim/Dockerfile) | Debian bookworm-slim + Node + Yarn 1.22.22 (BSD-2-Clause, [yarnpkg/yarn](https://github.com/yarnpkg/yarn/blob/master/LICENSE)); a tag é móvel |

### Fonte Inter (SIL OFL 1.1)

`src/ui/assets/inter-*.woff2` é a fonte Inter, sob a SIL Open Font License 1.1. O texto
da licença e o aviso "Copyright (c) 2016 The Inter Project Authors
(https://github.com/rsms/inter)" estão em `src/ui/assets/INTER-LICENSE.txt`. O SHA-256
desse arquivo (`262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`) é idêntico ao do `LICENSE.txt` do upstream nos commits
`66647c0bb` e nas tags v4.0 e v4.1 do `rsms/inter`.

Versão e origem, pelo que a tabela `name` dos `.woff2` e os repositórios oficiais mostram:

- Os quatro arquivos declaram `Version 4.001;git-66647c0bb` e o copyright acima. O commit
  `66647c0bb` do `rsms/inter` é de 24/05/2024 ("makefile: make sure dist runs
  googlefonts...").
- Têm 518 glifos. Os `.woff2` dos releases oficiais (v4.0: `Version 4.000;git-a52131595`,
  2926 glifos; v4.1: `Version 4.001;git-9221beed3`, 2937 glifos) são de outro commit e
  conjunto de glifos: **nenhum SHA-256 dos arquivos do repositório coincide** com os
  `web/*.woff2` desses releases.
- O arquivo `latin` servido pelo Google Fonts
  (`fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2`, consultado
  em 17/11/2026) é uma fonte variável com a mesma versão (`4.001;git-66647c0bb`) e os
  mesmos 518 glifos. Instanciada em `wght=400`, tem contornos e avanços iguais aos de
  `inter-400.woff2` nos 518 glifos. Em 500, 600 e 700 os avanços coincidem em 518, 518 e
  512 glifos, mas em cada um desses pesos só 10 glifos têm contornos idênticos (a causa não
  foi investigada; a comparação usou `wght` e nenhum outro eixo).
- Conclusão limitada ao que foi medido: `inter-400.woff2` coincide com a instância 400 do
  subconjunto `latin` do Inter 4.001 do Google Fonts; os pesos 500, 600 e 700 têm a mesma
  versão, o mesmo conjunto de glifos e avanços quase idênticos, sem coincidência de
  contornos. A origem exata (qual download e qual ferramenta de instanciação) **não é
  provada**; o histórico do Git não a registra. Requer confirmação do dono.

### Ícones Lucide (ISC e MIT)

O painel embute ícones em SVG (`<symbol id="i-...">` em `src/ui/index.html`) e o
cabeçalho de `src/ui/style.css` cita "ícones Lucide". Isso não estava no inventário e não
trazia aviso. A licença do [repositório oficial](https://github.com/lucide-icons/lucide/blob/main/LICENSE)
é ISC ("Copyright (c) 2026 Lucide Icons and Contributors"), com uma lista de ícones
derivados do projeto Feather sob MIT ("Copyright (c) 2013-present Cole Bemis"). O texto
integral foi copiado, sem alteração, para `src/ui/assets/LUCIDE-LICENSE.txt` (SHA-256
`b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57`), ao lado da licença da
Inter, e acompanha os artefatos porque fica em `src/` (o teste só confere que o arquivo existe
e traz os dois textos).

Dos 50 ícones do painel, 49 têm geometria idêntica à do repositório oficial em 17/11/2026
(a mudança mais recente entre eles é de 08/09/2026; a última versão publicada era a 1.74.0).
Para `trash-2` a comparação de geometria não foi possível: o arquivo `icons/trash-2.svg` não
existe mais no repositório oficial (provável renomeação), embora o nome conste no texto da
licença. Entre os ícones usados, constam na lista Feather: `calendar`, `check`,
`chevron-down`, `chevron-right`, `arrow-right`, `arrow-up-right`, `clock`, `download`,
`hash`, `log-out`, `search`, `trash-2`, `upload` e `x`. A versão exata do Lucide usada
na origem não é registrada no histórico.

### Pacotes npm sem arquivo de licença no diretório instalado

Para cada pacote, `npm view <pacote>@<versão do lockfile>` (17/11/2026) confirmou a
licença do campo `license` do registro, igual à do `package.json` instalado, e o
repositório oficial foi examinado na revisão (`gitHead`) ou tag da versão, quando o
registro a informa (nos pacotes sem `gitHead`, a revisão examinada foi a tag ou o ramo
principal e pode diferir da publicada). A coluna final diz se o README do pacote
instalado menciona a licença ou se só o campo `license` a declara.

| Pacote | Versão | Licença | Repositório oficial | Arquivo de licença na versão |
|---|---|---|---|---|
| `block-iterator` | 1.1.2 | MIT | [ThaUnknown/block-iterator](https://github.com/ThaUnknown/block-iterator) | nenhum; README diz "MIT" |
| `chunk-store-iterator` | 1.0.4 | MIT | [ThaUnknown/chunk-store-iterator](https://github.com/ThaUnknown/chunk-store-iterator) | nenhum; README diz "MIT" |
| `cookie-signature` | 1.0.7 | MIT | [visionmedia/node-cookie-signature](https://github.com/visionmedia/node-cookie-signature) | nenhum na revisão `432ea0c`; README traz "(The MIT License)". O repositório atual tem `LICENSE` |
| `cross-fetch-ponyfill` | 1.0.3 | MIT | [ThaUnknown/cross-fetch-ponyfill](https://github.com/ThaUnknown/cross-fetch-ponyfill) | nenhum; só o campo `license` |
| `data-uri-to-buffer` | 4.0.1 | MIT | [TooTallNate/node-data-uri-to-buffer](https://github.com/TooTallNate/node-data-uri-to-buffer) | nenhum; README tem seção de licença |
| `default-gateway` | 7.2.2 | BSD-2-Clause | [silverwind/default-gateway](https://github.com/silverwind/default-gateway) | nenhum; README: "© silverwind, distributed under BSD licence" |
| `err-code` | 3.0.1 | MIT | [IndigoUnited/js-err-code](https://github.com/IndigoUnited/js-err-code) | nenhum; README: "Released under the MIT License" |
| `fast-readable-async-iterator` | 2.0.0 | MIT | [ThaUnknown/fast-readable-async-iterator](https://github.com/ThaUnknown/fast-readable-async-iterator) | nenhum; só o campo `license` |
| `ip` | 2.0.1 | MIT | [indutny/node-ip](https://github.com/indutny/node-ip) | nenhum; README: "licensed under the MIT License" |
| `piece-length` | 2.0.1 | MIT | [michaelrhodes/piece-length](https://github.com/michaelrhodes/piece-length) | nenhum; só o campo `license` |
| `random-access-file` | 4.1.2 | MIT | [random-access-storage/random-access-file](https://github.com/random-access-storage/random-access-file) | nenhum; README diz "MIT" |
| `throughput` | 1.0.2 | MIT | [ThaUnknown/throughput](https://github.com/ThaUnknown/throughput) | nenhum; README diz "MIT" |
| `tr46` | 0.0.3 | MIT | [Sebmaster/tr46.js](https://github.com/Sebmaster/tr46.js) | nenhum na revisão `a8009f9`, e o pacote instalado não tem README; o repositório atual tem `LICENSE.md` |
| `uint8-util` | 2.3.2 | MIT | [ThaUnknown/uint8-util](https://github.com/ThaUnknown/uint8-util) | nenhum; só o campo `license` |
| `webrtc-polyfill` | 1.2.2 | MIT | [ThaUnknown/webrtc-polyfill](https://github.com/ThaUnknown/webrtc-polyfill) | nenhum; só o campo `license` |

Fato relevante: os textos-padrão da MIT e da BSD-2-Clause pedem que o aviso de copyright
e o texto da licença acompanhem as cópias. Nesses 15 pacotes o texto não vem em arquivo,
e em parte deles o nome do titular só aparece no campo `author` do `package.json`. Se
isso basta é questão de **revisão humana/jurídica**; este projeto não fabrica avisos
que o upstream não publicou.

### Licenças compostas e incomuns

| Pacote | Declarada | Verificado na fonte oficial |
|---|---|---|
| `expand-template` 2.0.3 | `(MIT OR WTFPL)` | [ralphtheninja/expand-template](https://github.com/ralphtheninja/expand-template/tree/f0c2ecd522fa54b46100555a9bfd0b10680aabd2): `LICENSE` é a MIT, "Copyright (c) 2018 Lars-Magnus Skog" |
| `rc` 1.2.8 | `(BSD-2-Clause OR MIT OR Apache-2.0)` | [dominictarr/rc](https://github.com/dominictarr/rc/tree/a97f6adcc37ee1cad06ab7dc9b0bd842bbc5c664): `LICENSE.BSD`, `LICENSE.MIT` e `LICENSE.APACHE2`, "Copyright (c) 2011 Dominic Tarr" nos dois últimos e "Copyright (c) 2013, Dominic Tarr" no `LICENSE.BSD` |
| `sax` 1.6.1 | `BlueOak-1.0.0` | [isaacs/sax-js](https://github.com/isaacs/sax-js/tree/961ceeefcc5186005466f2085aeb36f31b161e37): `LICENSE.md` traz a Blue Oak Model License 1.0.0, também presente no pacote instalado |
| `limiter` 1.1.5 | campo legado `licenses[]` com `MIT` (o registro npm também expõe `license: MIT`) | [jhurliman/node-rate-limiter](https://github.com/jhurliman/node-rate-limiter/tree/b8a770df02add01e51bcf05c7eb3be861cb2aebd): `LICENSE.txt`, MIT, "Copyright (C) 2011 by John Hurliman" |

### WinSW e Node.js no instalador do Windows

- **WinSW v2.12.0** (`windows/build.sh`, variante NET461): o `LICENSE.txt` da tag v2.12.0
  é MIT ("Copyright (c) 2008-2020 Kohsuke Kawaguchi, Sun Microsystems, Inc., CloudBees,
  Inc., Oleg Nenashev and other contributors") e tem o SHA-256 conferido pelo build. O
  projeto fixa também o SHA-256 do executável (`WINSW_SHA256` em `windows/build.sh`; o
  release publicado em 28/01/2023 tem 655872 bytes). O `WinSW.csproj` da tag mostra que, nas variantes
  `net461`, o executável funde por ILMerge as bibliotecas `log4net` 2.0.12 (Apache-2.0,
  com `NOTICE` "Apache log4net, Copyright 2004-2017 The Apache Software Foundation",
  tag `rel/2.0.12`) e `YamlDotNet` 8.1.2 (MIT, "Copyright (c) 2008-2014 Antoine Aubry and
  contributors", tag v8.1.2). Esses dois avisos **não** acompanham o instalador hoje:
  só o `WinSW-LICENSE.txt` do WinSW. Requer revisão.
- **Node.js**: `windows/build.sh` e `scripts/install.sh` baixam o binário oficial de
  `nodejs.org/dist/latest-v22.x` e conferem o SHA-256 do `SHASUMS256.txt` do mesmo
  servidor. O arquivo `LICENSE` do release é copiado ao lado do `node.exe` no Windows;
  ele é o [LICENSE do projeto Node.js](https://github.com/nodejs/node/blob/main/LICENSE)
  (MIT, com a relação das licenças de componentes internos como V8 e OpenSSL). A versão
  muda a cada release (`latest-v22.x`); o `RUNTIMES-INVENTORY.json` registra a efetiva.
- **Imagem Docker**: `node:22-bookworm-slim` é uma tag móvel. O Dockerfile oficial
  (consultado em 17/11/2026, `NODE_VERSION=22.23.5`) parte de `debian:bookworm-slim`, instala o
  Node de `nodejs.org` e o Yarn 1.22.22. Os textos Debian ficam em `/usr/share/doc` da
  imagem; `DEBIAN-PACKAGES.txt` lista os pacotes. A imagem base não é fixada por
  digest neste projeto, portanto cada build pode diferir.

## Atribuições exigidas

- **Big Buck Bunny** (amostra do `DEMO_MODE`): a [página oficial](https://peach.blender.org/about/)
  (consultada em 17/11/2026) informa que os resultados do projeto Peach estão sob
  [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/),
  exigindo atribuição, e indica para reuso de partes do filme o texto:
  **"(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org"**. Logos e marcas
  do site (inclusive Blender e Creative Commons) ficam fora da licença. O filme não
  está no repositório: `src/addon.js` apenas aponta uma URL externa quando
  `DEMO_MODE=true`. Sobre a fonte:
  - **a URL foi trocada em 17/11/2026.** A anterior (um bucket Google chamado
    `gtv-videos-bucket`, sem fonte que o declare espelho oficial do Blender) respondia
    **403 `AccessDenied`** a requisições anônimas, o que quebrava o `DEMO_MODE`. A atual é a
    versão 480p (`.webm`, VP9) hospedada na [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm);
  - a página do arquivo na Commons, consultada pela API (`extmetadata`) em 17/11/2026, indica
    licença **CC BY 3.0** e autor **Blender Foundation**, e o servidor respondeu 200 com
    `Accept-Ranges: bytes` ao `HEAD`. A descrição da fonte no Stremio traz a atribuição e a
    origem ("via Wikimedia Commons");
  - os arquivos publicados em `download.blender.org/peach/bigbuckbunny_movies/` são `.zip`,
    sem URL de streaming direto verificada, e por isso não foram usados;
  - o exemplo da documentação do SDK Stremio usa outra URL
    (`distribution.bbb3d.renderfarming.net`), não adotada aqui.
- **Inter** e **Lucide**: avisos em `src/ui/assets/INTER-LICENSE.txt` e
  `src/ui/assets/LUCIDE-LICENSE.txt`, descritos acima.
- **Pacotes npm e binários**: os textos presentes nos diretórios instalados acompanham os
  artefatos conforme a seção "Entrega por formato".

## Código-fonte de componentes copyleft (MPL-2.0)

`node-datachannel` 0.32.3 declara `"license": "MPL 2.0"` (sem hífen, fora do identificador
SPDX `MPL-2.0`) e o arquivo `LICENSE` do pacote é o texto da Mozilla Public License 2.0.
O pacote traz binários pré-compilados (a instalação baixa
`node-datachannel-v0.32.3-napi-v8-<plataforma>.tar.gz` do release da mesma tag; o build do
Windows usa `win32-x64`) e, no npm, só o `LICENSE` próprio: **os avisos das bibliotecas
embutidas não acompanham o pacote**.

Onde obter o código-fonte da versão redistribuída (consultado em 17/11/2026):

| Parte | Licença | Código-fonte na versão |
|---|---|---|
| node-datachannel 0.32.3 | MPL-2.0 | [tag v0.32.3](https://github.com/murat-dogan/node-datachannel/tree/v0.32.3), commit `e495b7efad200bca44038609455c06a7f2ea812d`; o tarball npm também inclui `src/` e `CMakeLists.txt` |
| libdatachannel v0.24.2 | MPL-2.0 | [tag v0.24.2](https://github.com/paullouisageneau/libdatachannel/tree/v0.24.2), buscada pelo `CMakeLists.txt` do pacote (`GIT_TAG "v0.24.2"`) |
| libjuice | MPL-2.0 | submódulo da libdatachannel v0.24.2, commit [`5948a41`](https://github.com/paullouisageneau/libjuice/tree/5948a4162d37bc213d6051b67ee2876ccc5a99a6) |
| usrsctp | BSD-3-Clause | submódulo, commit [`fec583d`](https://github.com/paullouisageneau/usrsctp/tree/fec583d54493f879d2ae44a743423bf8a04371ab) ("Copyright (c) 2015, Randall Stewart and Michael Tuexen") |
| libsrtp | BSD-3-Clause | submódulo, commit [`ee1a77c`](https://github.com/cisco/libsrtp/tree/ee1a77c9f9dc02c42bda9901038c500c5efe4cfa) (igual à tag v2.7.0; "Copyright (c) 2001-2017 Cisco Systems, Inc.") |
| plog | MIT | submódulo, commit [`94899e0`](https://github.com/SergiusTheBest/plog/tree/94899e0b926ac1b0f4750bfbd495167b4a6ae9ef) ("Copyright (c) 2022 Sergey Podobry") |
| nlohmann/json | MIT | submódulo, commit [`55f9368`](https://github.com/nlohmann/json/tree/55f93686c01528224f448c19128836e7df245f72) ("Copyright (c) 2013-2025 Niels Lohmann"); presença no binário não confirmada |
| OpenSSL | a verificar pela versão | do vcpkg do CI do upstream; versão não identificada |

Fatos para a revisão: o texto da MPL-2.0 trata o código-fonte dos arquivos cobertos
quando se distribui a forma executável; a interpretação cabe à revisão. O projeto usa o
binário pré-compilado publicado pelo upstream (não o compila) e não foi verificado se
esse binário contém alterações além do código das tags acima. A tabela lista onde o
código-fonte está, mas os artefatos do projeto (instaladores e imagem) **não o oferecem
nem o citam hoje**, e os avisos de copyright das bibliotecas BSD e MIT também não são
incluídos neles. SHA-256 dos arquivos baixados em 17/11/2026 (só valem para esses
downloads):

| Arquivo | SHA-256 |
|---|---|
| `node-datachannel-v0.32.3-napi-v8-win32-x64.tar.gz` | `3bfacc4125b296197fe9e22ebd9a52f05321c50aca9d80b92897507f898c12c3` |
| `node_datachannel.node` extraído (Windows x64) | `9c994ed1262f12313694d34f18a4b8e291b21790360d603a78cd23a4f5539b25` |
| `node-datachannel-v0.32.3-napi-v8-linux-x64.tar.gz` | `4092afc9cd594a3326eb1bd823da452b227b742ea8222689b2cea6f7344cf67a` |
| `node_datachannel.node` extraído (Linux x64) | `1da298b65c65c2d47109708af662ee2a3b92cf1f34881da6455619e14729e7b4` |

**Requer revisão humana/jurídica**: esta seção não afirma conformidade.

## Escolhas de licença

Quando a licença declarada é uma expressão `OR`, a própria expressão permite escolher uma
das opções. As escolhas abaixo são **propostas** a confirmar pelo dono (não são
conselho jurídico e não alteram nada no código).

- `expand-template`: `MIT OR WTFPL`. Proposta: **MIT**, a licença do próprio projeto.
- `rc`: `BSD-2-Clause OR MIT OR Apache-2.0`. Proposta: **MIT**; o pacote traz o texto em
  `LICENSE.MIT`.
- `sax` (BlueOak-1.0.0) e `limiter` (MIT em campo legado) não têm escolha: a licença é única.

## Nomes, marcas e artes

Varredura de `README.md`, `docs/`, `src/ui/`, `windows/`, `Dockerfile`, `docker-compose.yml`,
scripts de instalação e imagens versionadas em 17/11/2026:

- **Não foi encontrado logotipo, ícone de marca, banner ou arte de terceiro versionado.**
  `git ls-files` por extensões de imagem e fonte (`png`, `jpg`, `gif`, `svg`, `ico`,
  `webp`, `ttf`, `otf`, `woff`, `woff2`) lista só as 14 capturas de `docs/imagens/`
  (geradas por `scripts/demo-capturas.js` com títulos fictícios "... — demonstração" e a
  própria interface; uma foi aberta e conferida) e os 4 `.woff2` da Inter; os ícones da
  bandeja do Windows são círculos coloridos desenhados em `windows/bandeja.ps1`, e os
  ícones Lucide estão embutidos em `src/ui/index.html`. Fora Inter e Lucide, não foi
  identificada outra obra de terceiros; a varredura não cobre texto de terceiros colado
  em arquivos.
- **Nomes (uso descritivo/nominativo):** "Stremio" (para dizer com qual programa o addon
  funciona), "Amigos Share"/"ASC" (o tracker cuja conta a pessoa usa), "Cinemeta" (a fonte
  de metadados consultada), "BitTorrent"/"WebTorrent" (protocolo e biblioteca), "IMDb"
  (identificadores de título) e "Prowlarr" (citado só em `docs/permissoes-e-contato.md`). Todos
  aparecem como texto, nunca como logotipo.
- **Nome do produto:** o instalador do Windows (`windows/installer.nsi`), a bandeja
  (`windows/bandeja.ps1`) e o cabeçalho do `Dockerfile` usam "Amigos Share · Stremio" como
  nome de exibição; o painel se chama "Monitor ASC" (`src/ui/index.html`) e usa "Amigos
  Share" na tela de conexão. O `README.md` declara "Projeto independente, sem vínculo,
  afiliação ou endosso do Amigos Share", e `docs/permissoes-e-contato.md` registra que a
  staff pediu para aguardar. O nome de exibição, sem aviso de independência na tela do
  instalador e na bandeja, pode ser lido como vínculo: requer decisão do dono.
- **Identidade visual:** `src/ui/tokens.css` se declara "Tokens do Amigos Share Club —
  extraídos do CSS público do site" e define `--font-brand: "Ethnocentric Rg"` (sem
  `@font-face`: na prática cai para a Inter e nenhum arquivo da fonte é versionado). O
  cabeçalho de `src/ui/style.css` diz que o painel segue "o padrão visual do Amigos
  Share" e que não usa logotipo, banner nem essa fonte. A semelhança visual com o site do
  tracker e o alcance dos termos desse CSS não foram avaliados: requer revisão.
- Nada neste repositório deve sugerir divulgação, aprovação ou parceria com o ASC, com o
  Stremio ou com fornecedores de metadados.

## Entrega por formato

| Formato | Evidência gerada | Textos e limites |
|---|---|---|
| Tarball Linux | `THIRD-PARTY-INVENTORY.json` do lockfile | O pacote contém fontes; `node_modules` é instalado depois. Gerar o modo instalado na instalação para conferir a plataforma efetiva. Node é obtido pelo instalador, não faz parte desse tarball. |
| Windows | `app/THIRD-PARTY-INVENTORY.json` e `RUNTIMES-INVENTORY.json`, caminhos relativos ao diretório que contém cada JSON | Gerado após instalar e filtrar binários. `node/LICENSE` acompanha `node.exe`; os avisos npm permanecem em `app/node_modules`. `WinSW-LICENSE.txt` vem da tag v2.12.0 e tem SHA-256 conferido; a composição do binário exige revisão própria. |
| Docker | `/app/THIRD-PARTY-INVENTORY.json` e `/app/DEBIAN-PACKAGES.txt` | Árvore npm da etapa de dependências e nomes/versões/arquiteturas Debian na imagem final. Textos Debian em `/usr/share/doc`; conferir também avisos Node da imagem base. |

O inventário npm não decompõe bibliotecas incorporadas nos binários de
`node-datachannel`, `utp-native` ou outros componentes (a seção acima faz isso à mão para
`node-datachannel`). A lista Debian não é um parecer sobre licenças nem garante que
todos os textos exigidos estejam presentes. A revisão de um release deve examinar o
artefato de cada arquitetura, incluindo Node e WinSW, seus textos, fontes de distribuição
e obrigações aplicáveis.

## Metadados externos (Cinemeta)

O que o projeto faz, conferido em `src/addon.js`, `src/providers/amigos-share.js` e
`src/meta-cache.js`:

- Em tempo de execução consulta o endpoint público `v3-cinemeta.strem.io`: busca por
  nome (`/catalog/<tipo>/top/search=<título>.json`) para obter a URL do pôster e
  `/meta/<tipo>/<imdb>.json` para obter o nome do título. As respostas ficam só em memória
  (`cinemetaCache` guarda a URL do pôster) e a URL do pôster é repassada ao Stremio; o
  projeto não baixa nem hospeda a imagem.
- `meta-cache.json` **não guarda dados do Cinemeta**: guarda, por IMDb, o `id`, nome,
  tamanho e selos dos releases do próprio ASC (campos de `cleanRelease`).
- O repositório e os artefatos não contêm cópia de dados do Cinemeta; o que sai do projeto
  para o Stremio é a URL do pôster, não a imagem.

Fatos das fontes oficiais (consultadas em 17/11/2026):

- A [documentação do SDK Stremio](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md#getting-metadata-from-cinemeta)
  descreve o Cinemeta como "o addon oficial" para catálogos e metadados por IDs IMDb e mostra
  como outros addons consultam metadados nele.
- O `manifest.json` do Cinemeta (`v3-cinemeta.strem.io/manifest.json`, versão 3.0.14)
  o descreve como "The official addon for movie and series catalogs". Não encontrei
  repositório público do código do Cinemeta na organização Stremio no GitHub (lista de
  repositórios consultada), portanto **não há licença de código verificada**.
- Uma resposta de metadados traz pôster, fundo e logotipo hospedados em
  `images.metahub.space`, domínio que não é do Stremio.
- Os [Termos Gerais do Stremio](https://www.stremio.com/tos) (efetivos desde 30/08/2020)
  definem a "Database" como compilação de metadados de propriedade do provedor (item 1.8),
  proíbem aos usuários monitorar, copiar ou extrair informação da interface ou da Database,
  inclusive por meios automatizados (item 5.4.1), e reservam ao provedor logotipos, marcas e
  domínios (item 7.10). Se a consulta automática do addon se enquadra nesses itens é
  questão de **revisão humana/jurídica**.
- A origem dos dados (por exemplo IMDb ou TMDB) e a licença dos **dados** pertencem aos
  respectivos provedores; este documento não as verificou.

## Pendências que exigem revisão humana

1. **Inter:** confirmar a origem exata dos `.woff2` (compatíveis com o Inter 4.001 do Google
   Fonts, sem prova de origem byte a byte).
2. **Lucide:** versão exata na origem; `trash-2` não foi comparado.
3. **MPL-2.0 / node-datachannel:** decidir como oferecer o código-fonte e os avisos das
   bibliotecas embutidas (libjuice MPL-2.0; usrsctp, libsrtp, plog, OpenSSL; nlohmann/json
   se estiver no binário, o que não foi confirmado) nos instaladores Windows e Linux e na
   imagem Docker; versão do OpenSSL não identificada; se o binário baixado tem alterações
   além das tags citadas.
4. **WinSW:** avisos de `log4net` (Apache-2.0, com NOTICE) e `YamlDotNet` (MIT) fundidos no
   executável não acompanham o instalador.
5. **15 pacotes sem arquivo de licença:** decidir se o campo `license` e o README bastam.
   **Escolhas de licença** (`expand-template`, `rc`): confirmar as propostas pelo dono.
6. **Big Buck Bunny:** resolvido em 17/11/2026 (URL trocada para a Wikimedia Commons, com a
   atribuição na própria fonte). Reconferir se a URL deixar de responder.
7. **Cinemeta e Stremio:** alcance dos termos de uso sobre a consulta automática; licença dos
   dados dos provedores; ausência de código público verificado do Cinemeta.
8. **Nomes:** avaliar aviso de independência na tela do instalador/bandeja, a semelhança
   visual com o site do tracker e o alcance dos termos do CSS de onde os tokens foram extraídos.
9. **Imagem base Docker:** tag móvel, sem digest; revisar avisos da imagem final por
   arquitetura.

A issue #103 continua responsável pela revisão humana de termos e permissões e pela
validação dos artefatos reais de Linux, Windows e Docker. Alterar dependências exige
regenerar os inventários e conferir os avisos; não se altera `LICENSE` nem a versão
manualmente para essa atualização.
