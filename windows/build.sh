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
mkdir -p "$STAGE/node"; cp "$OUT/cache/node-unz"/*/node.exe "$STAGE/node/"; rm -rf "$OUT/cache/node-unz"

cp -R src package.json package-lock.json "$STAGE/app/"
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
cp windows/launcher.vbs windows/start.cmd windows/stop.cmd windows/open-panel.cmd "$STAGE/"
cp README.md "$STAGE/LEIA-ME.md"
cp README.md LICENSE AGENTS.md CHANGELOG.md release-please-config.json "$STAGE/"
# Evita empacotar notas privadas que também possam existir em docs/.
while IFS= read -r doc; do
  mkdir -p "$STAGE/$(dirname "$doc")"
  cp "$doc" "$STAGE/$doc"
done < scripts/documentation-files.txt
echo "Pasta montada em $STAGE"

[ "$STAGE_ONLY" -eq 1 ] || {
  makensis -V2 -DVERSION="$VERSION" -DSTAGE="$(pwd)/$STAGE" -DOUTFILE="$(pwd)/dist/AscStremio-Setup-$VERSION.exe" windows/installer.nsi
  ( cd dist && (sha256sum "AscStremio-Setup-$VERSION.exe" 2>/dev/null || shasum -a 256 "AscStremio-Setup-$VERSION.exe") > "AscStremio-Setup-$VERSION.exe.sha256" )
  echo "Instalador: dist/AscStremio-Setup-$VERSION.exe"
}
