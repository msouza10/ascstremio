#!/usr/bin/env bash
# Instala o pacote de dist/ como um usuário novo (HOME vazio, via install.sh do curl,
# sem serviço), sobe o app e confere a ponte. Não mexe no seu serviço nem em ~/.
#   scripts/smoke-install.sh [pasta-dist]    (padrão: dist; gerada por build-release.sh)
set -Eeuo pipefail
DIST="$(cd "${1:-dist}" && pwd)"
[ -f "$DIST/install.sh" ] || { echo "rode scripts/build-release.sh antes ($DIST/install.sh não existe)" >&2; exit 1; }
FAKE_HOME="$(mktemp -d)"; APP_PID=""
trap '[ -n "$APP_PID" ] && kill -INT "$APP_PID" 2>/dev/null; rm -rf "$FAKE_HOME"' EXIT

env HOME="$FAKE_HOME" PATH="$PATH" ASC_STREMIO_BASE_URL="file://$DIST" bash "$DIST/install.sh" --no-service
APPDIR="$FAKE_HOME/.local/share/asc-stremio"
export PATH="$APPDIR/node/bin:$PATH"
cd "$APPDIR/app"
DATA_DIR="$APPDIR/data" PORT=17000 BRIDGE_PORT=17010 CONFIG_PORT=17020 \
  node --max-http-header-size=65536 src/index.js >"$FAKE_HOME/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:17010/health >/dev/null && { echo "ok   ponte respondeu"; exit 0; }; sleep 1; done
echo "FALHA: a ponte não respondeu"; tail -n 30 "$FAKE_HOME/app.log"; exit 1
