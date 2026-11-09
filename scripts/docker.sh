#!/usr/bin/env bash
# Cria e roda a imagem Docker (ou Podman) do Amigos Share · Stremio.
#
#   scripts/docker.sh build            constrói a imagem asc-stremio:<versão> e :latest
#   scripts/docker.sh run              constrói (se faltar) e sobe o contêiner, portas só em 127.0.0.1
#   scripts/docker.sh stop|logs|shell  para, mostra logs, abre um shell
#   scripts/docker.sh passkey          grava a passkey no volume (lê do teclado, sem eco)
#   scripts/docker.sh save [arquivo]   exporta a imagem (padrão dist/asc-stremio-<versão>-image.tar.gz)
#
# Dados no volume nomeado "asc-stremio-data" (/data no contêiner). Usa docker ou podman.

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME=asc-stremio
VOLUME=asc-stremio-data
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
ENGINE="${CONTAINER_ENGINE:-$(command -v docker || command -v podman || true)}"
[ -n "$ENGINE" ] || { echo "Instale docker ou podman (ou defina CONTAINER_ENGINE)." >&2; exit 1; }

build() { "$ENGINE" build -t "$NAME:$VERSION" -t "$NAME:latest" .; }
exists() { "$ENGINE" container inspect "$NAME" >/dev/null 2>&1; }

case "${1:-run}" in
  build) build ;;
  run)
    "$ENGINE" image inspect "$NAME:latest" >/dev/null 2>&1 || build
    exists && "$ENGINE" rm -f "$NAME" >/dev/null
    "$ENGINE" volume create "$VOLUME" >/dev/null
    "$ENGINE" run -d --name "$NAME" --restart unless-stopped --stop-signal SIGINT --stop-timeout 30 \
      --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
      -p 127.0.0.1:7000:7000 -p 127.0.0.1:7010:7010 -p 127.0.0.1:7020:7020 -p 7030:7030 \
      -v "$VOLUME:/data" \
      ${AFTER_SEED:+-e AFTER_SEED="$AFTER_SEED"} ${LOG_LEVEL:+-e LOG_LEVEL="$LOG_LEVEL"} \
      "$NAME:latest" >/dev/null
    echo "Painel: http://127.0.0.1:7020/   Addon: http://127.0.0.1:7000/manifest.json"
    echo "Logs: scripts/docker.sh logs   |   Passkey: scripts/docker.sh passkey" ;;
  stop) "$ENGINE" stop "$NAME" ;;
  logs) "$ENGINE" logs -f --tail 100 "$NAME" ;;
  shell) "$ENGINE" exec -it "$NAME" sh ;;
  passkey)
    read -r -s -p "Passkey do ASC: " pk; echo
    [ -n "$pk" ] || { echo "vazia, nada gravado" >&2; exit 1; }
    printf '%s' "$pk" | "$ENGINE" run --rm -i -v "$VOLUME:/data" --entrypoint sh "$NAME:latest" \
      -c 'umask 077; cat > /data/passkey.txt'
    echo "Gravada em /data/passkey.txt (0600). Reinicie: $ENGINE restart $NAME" ;;
  save)
    out="${2:-dist/$NAME-$VERSION-image.tar.gz}"; mkdir -p "$(dirname "$out")"
    "$ENGINE" save "$NAME:latest" | gzip -9 > "$out"; echo "$out" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
