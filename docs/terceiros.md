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
opcionais de outras plataformas. Registra versão, origem, integridade e licença
declarada. Não é uma lista de componentes efetivamente instalados.

Depois de `npm ci`, acrescente `--installed` para examinar a árvore montada:

```bash
node scripts/license-inventory.js . /tmp/inventario-instalado.json --installed
```

Esse modo filtra pacotes ausentes, localiza textos de licença/avisos dentro de
cada pacote e registra SHA-256 dos arquivos nativos encontrados. Os caminhos são
relativos à raiz examinada. Os textos permanecem junto aos componentes; o JSON
não os substitui. Ausência de texto é uma pendência de revisão, não aprovação.
O comando não acessa a rede nem lê dados da conta.

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
