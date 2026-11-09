#!/usr/bin/env bash
# Gera os pacotes de distribuição em dist/:
#   brazuka-asc-<versão>.tar.gz (+ .sha256)  código para o instalador curl (install-remote.sh)
#   brazuka-asc-latest.tar.gz  (+ .sha256)   cópia com nome fixo, o que o curl baixa
#   install.sh                               install-remote.sh com a URL de download embutida
#
#   scripts/build-release.sh --base-url https://exemplo.com/brazuka   (onde os arquivos ficarão)
#   scripts/build-release.sh --windows       também monta o instalador .exe (precisa de makensis)
#   scripts/build-release.sh --docker        também exporta a imagem Docker
#
# Sem --base-url, o install.sh gerado exige BRAZUKA_BASE_URL no ambiente.
# Nunca entra nada de private/ nem node_modules/ no pacote.

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BASE_URL=""; WANT_WIN=0; WANT_DOCKER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:?--base-url precisa de um valor}"; shift ;;
    --windows) WANT_WIN=1 ;;
    --docker) WANT_DOCKER=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
NAME="brazuka-asc-$VERSION"
rm -rf dist/stage; mkdir -p dist/stage/"$NAME"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

cp -R src scripts windows package.json package-lock.json README.md Dockerfile docker-compose.yml .dockerignore dist/stage/"$NAME"/
cp -R test dist/stage/"$NAME"/
find dist/stage -name '__pycache__' -prune -exec rm -rf {} +

tar --owner=0 --group=0 --numeric-owner -C dist/stage -czf "dist/$NAME.tar.gz" "$NAME"
cp "dist/$NAME.tar.gz" dist/brazuka-asc-latest.tar.gz
( cd dist && sha "$NAME.tar.gz" > "$NAME.tar.gz.sha256" && sha brazuka-asc-latest.tar.gz > brazuka-asc-latest.tar.gz.sha256 )
sed "s#^DEFAULT_BASE_URL=.*#DEFAULT_BASE_URL=\"${BASE_URL}\"#" scripts/install-remote.sh > dist/install.sh
chmod +x dist/install.sh
rm -rf dist/stage
echo "Pacote: dist/$NAME.tar.gz ($(du -h "dist/$NAME.tar.gz" | cut -f1))"
[ -n "$BASE_URL" ] && echo "Instalação: curl -fsSL $BASE_URL/install.sh | bash" || echo "Aviso: sem --base-url; quem instalar precisará definir BRAZUKA_BASE_URL."

[ "$WANT_WIN" -eq 0 ] || bash windows/build.sh
[ "$WANT_DOCKER" -eq 0 ] || { scripts/docker.sh build; scripts/docker.sh save; }
