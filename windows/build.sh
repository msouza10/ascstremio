#!/usr/bin/env bash
# Monta o instalador do Windows (dist/AscStremio-Setup-<versão>.exe) a partir do Linux
# (ou macOS/WSL/Git Bash). O .exe contém Node 22 oficial + o app + node_modules; as
# bibliotecas nativas (utp-native, bufferutil) já trazem os binários win32-x64.
#
#   windows/build.sh              baixa o Node (SHA-256 conferido), monta e compila
#   windows/build.sh --stage-only só monta dist/win/stage (sem makensis)
#
# Precisa de: curl, unzip, npm, tar e makensis (Ubuntu/Debian: apt install nsis).
# A CI instala e inicia o pacote em Windows; a reprodução ainda depende do player.

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NODE_MAJOR=22
# Hospedeiro do serviço do Windows (o node.exe sozinho não fala com o gerenciador de serviços).
# Variante NET461: 656 KB, usa o .NET Framework que já vem no Windows 10/11. Licença MIT.
WINSW_VERSION=v2.12.0
WINSW_LICENSE_SHA256=1cdf703c10a70e5973bf3acf2a5eeabe7746237155b92db2034aeae26fdf7802
# O executável do WinSW 2.12.0 (NET461) funde por ILMerge log4net 2.0.12 (Apache-2.0, exige a
# licença e o NOTICE) e YamlDotNet 8.1.2 (MIT, exige o aviso de copyright); ver WinSW.csproj da
# tag. Os textos vêm das tags oficiais e têm SHA-256 fixado, como a licença do próprio WinSW.
LOG4NET_TAG=rel/2.0.12
LOG4NET_LICENSE_SHA256=c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4
LOG4NET_NOTICE_SHA256=14e0ac5d0b985b12b11ac530b2df91e8a8afec56036189b90ce434f0745a75be
YAMLDOTNET_TAG=v8.1.2
YAMLDOTNET_LICENSE_SHA256=daea8b7f1b2bab48ea12ad50b0ce91634669d99d7dd0cb64aed8dffeeef69ed3
WINSW_SHA256=b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f
STAGE_ONLY=0; [ "${1:-}" = "--stage-only" ] && STAGE_ONLY=1
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
OUT=dist/win; STAGE="$OUT/stage"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
for c in curl unzip npm; do command -v "$c" >/dev/null || { echo "faltou: $c" >&2; exit 1; }; done
[ "$STAGE_ONLY" -eq 1 ] || command -v makensis >/dev/null || { echo "faltou makensis (apt install nsis). Use --stage-only para só montar a pasta." >&2; exit 1; }

rm -rf "$STAGE"; mkdir -p "$STAGE/app" "$OUT/cache"
base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
curl -fsSL -o "$OUT/cache/SHASUMS256.txt" "$base/SHASUMS256.txt"
zip="$(awk '$2 ~ /win-x64\.zip$/ {print $2}' "$OUT/cache/SHASUMS256.txt")"
want="$(awk -v f="$zip" '$2==f {print $1}' "$OUT/cache/SHASUMS256.txt")"
[ -f "$OUT/cache/$zip" ] && [ "$(sha "$OUT/cache/$zip")" = "$want" ] || curl -fsSL -o "$OUT/cache/$zip" "$base/$zip"
[ "$(sha "$OUT/cache/$zip")" = "$want" ] || { echo "SHA-256 de $zip não confere" >&2; exit 1; }
unzip -q "$OUT/cache/$zip" -d "$OUT/cache/node-unz"
mkdir -p "$STAGE/node"; cp "$OUT/cache/node-unz"/*/node.exe "$OUT/cache/node-unz"/*/LICENSE "$STAGE/node/"; rm -rf "$OUT/cache/node-unz"

winsw="$OUT/cache/WinSW.NET461-$WINSW_VERSION.exe"
[ -f "$winsw" ] && [ "$(sha "$winsw")" = "$WINSW_SHA256" ] \
  || curl -fsSL -o "$winsw" "https://github.com/winsw/winsw/releases/download/$WINSW_VERSION/WinSW.NET461.exe"
[ "$(sha "$winsw")" = "$WINSW_SHA256" ] || { echo "SHA-256 do WinSW não confere" >&2; exit 1; }
curl -fsSL -o "$STAGE/WinSW-LICENSE.txt" "https://raw.githubusercontent.com/winsw/winsw/$WINSW_VERSION/LICENSE.txt"
[ "$(sha "$STAGE/WinSW-LICENSE.txt")" = "$WINSW_LICENSE_SHA256" ] || { echo "SHA-256 da licença WinSW não confere" >&2; exit 1; }
# Baixa para o cache, confere e só então agrega: um hash que não bate interrompe o build.
curl -fsSL -o "$OUT/cache/log4net-LICENSE" "https://raw.githubusercontent.com/apache/logging-log4net/$LOG4NET_TAG/LICENSE"
[ "$(sha "$OUT/cache/log4net-LICENSE")" = "$LOG4NET_LICENSE_SHA256" ] || { echo "SHA-256 da licença do log4net não confere" >&2; exit 1; }
curl -fsSL -o "$OUT/cache/log4net-NOTICE" "https://raw.githubusercontent.com/apache/logging-log4net/$LOG4NET_TAG/NOTICE"
[ "$(sha "$OUT/cache/log4net-NOTICE")" = "$LOG4NET_NOTICE_SHA256" ] || { echo "SHA-256 do NOTICE do log4net não confere" >&2; exit 1; }
curl -fsSL -o "$OUT/cache/YamlDotNet-LICENSE.txt" "https://raw.githubusercontent.com/aaubry/YamlDotNet/$YAMLDOTNET_TAG/LICENSE.txt"
[ "$(sha "$OUT/cache/YamlDotNet-LICENSE.txt")" = "$YAMLDOTNET_LICENSE_SHA256" ] || { echo "SHA-256 da licença do YamlDotNet não confere" >&2; exit 1; }
{
  echo "Avisos de componentes incorporados ao executável AscStremioServico.exe (WinSW $WINSW_VERSION, NET461)."
  echo "A licença do próprio WinSW está em WinSW-LICENSE.txt. Textos obtidos das tags oficiais abaixo."
  echo
  echo "=== log4net 2.0.12 (Apache-2.0) - https://github.com/apache/logging-log4net/tree/$LOG4NET_TAG - NOTICE ==="
  cat "$OUT/cache/log4net-NOTICE"
  echo
  echo "=== log4net 2.0.12 (Apache-2.0) - LICENSE ==="
  cat "$OUT/cache/log4net-LICENSE"
  echo
  echo "=== YamlDotNet 8.1.2 (MIT) - https://github.com/aaubry/YamlDotNet/tree/$YAMLDOTNET_TAG - LICENSE.txt ==="
  cat "$OUT/cache/YamlDotNet-LICENSE.txt"
} > "$STAGE/THIRD-PARTY-WinSW.txt"
node -e 'const fs = require("node:fs"); const [destino, zip, winsw] = process.argv.slice(1); fs.writeFileSync(destino, JSON.stringify({componentes: [{nome: "Node.js", versao: zip.match(/node-(v[^-]+)/)[1], origem: `https://nodejs.org/dist/${zip.match(/node-(v[^-]+)/)[1]}/${zip}`, texto: "node/LICENSE"}, {nome: "WinSW", versao: winsw, origem: `https://github.com/winsw/winsw/releases/tag/${winsw}`, texto: "WinSW-LICENSE.txt", textosIncorporados: "THIRD-PARTY-WinSW.txt"}], pendencia: "Revisar componentes incorporados nesses binários e suas obrigações."}, null, 2) + "\n");' "$STAGE/RUNTIMES-INVENTORY.json" "$zip" "$WINSW_VERSION"
# O WinSW exige o mesmo nome base para o executável e o XML.
cp "$winsw" "$STAGE/AscStremioServico.exe"
cp windows/servico.xml "$STAGE/AscStremioServico.xml"

cp -R src package.json package-lock.json "$STAGE/app/"
# A aplicação lê a mesma fonte ao lado do package.json, também no layout Windows.
cp LEGAL.md "$STAGE/app/"
# Os binários nativos vêm do GitHub Releases, que às vezes responde 504: tenta de novo.
( cd "$STAGE/app" && for i in 1 2 3 4; do
    npm_config_platform=win32 npm_config_arch=x64 npm ci --omit=dev --no-audit --no-fund && exit 0
    echo "npm ci falhou (tentativa $i); aguardando" >&2; sleep $((i * 20))
  done; exit 1 )
# Só binários do Windows (cabeçalho "MZ") podem ficar. O que o host compilou/baixou para
# outro sistema (ex.: build/Release do bufferutil no Linux) sairia na frente dos prebuilds
# certos, então é removido; node-datachannel não tem alternativa e precisa ser do Windows.
find "$STAGE/app/node_modules" -name '*.node' -print0 | while IFS= read -r -d '' n; do
  [ "$(head -c2 "$n")" = "MZ" ] || rm -f "$n"
done
find "$STAGE/app/node_modules" -type d \( -name 'linux-*' -o -name 'darwin-*' -o -name 'android-*' \) -path '*prebuilds*' -prune -exec rm -rf {} +
[ "$(head -c2 "$STAGE/app/node_modules/node-datachannel/build/Release/node_datachannel.node")" = "MZ" ] \
  || { echo "node-datachannel não é binário do Windows" >&2; exit 1; }
cp windows/bandeja.vbs windows/bandeja.ps1 windows/bandeja-estado.ps1 windows/parar-bandeja.cmd windows/painel-lan.cmd windows/firewall-lan.cmd windows/start.cmd windows/stop.cmd windows/open-panel.cmd windows/configurar.cmd windows/credenciais.cmd "$STAGE/"
node windows/prepare-scripts.js "$STAGE"
cp README.md "$STAGE/LEIA-ME.md"
cp README.md LICENSE AGENTS.md CHANGELOG.md release-please-config.json "$STAGE/"
# Evita empacotar notas privadas que também possam existir em docs/.
while IFS= read -r doc; do
  mkdir -p "$STAGE/$(dirname "$doc")"
  cp "$doc" "$STAGE/$doc"
done < scripts/documentation-files.txt
node scripts/license-inventory.js "$STAGE/app" "$STAGE/app/THIRD-PARTY-INVENTORY.json" --installed
echo "Pasta montada em $STAGE"

[ "$STAGE_ONLY" -eq 1 ] || {
  makensis -V2 -DVERSION="$VERSION" -DSTAGE="$(pwd)/$STAGE" -DOUTFILE="$(pwd)/dist/AscStremio-Setup-$VERSION.exe" windows/installer.nsi
  ( cd dist && (sha256sum "AscStremio-Setup-$VERSION.exe" 2>/dev/null || shasum -a 256 "AscStremio-Setup-$VERSION.exe") > "AscStremio-Setup-$VERSION.exe.sha256" )
  echo "Instalador: dist/AscStremio-Setup-$VERSION.exe"
}
