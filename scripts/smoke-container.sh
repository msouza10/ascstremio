#!/usr/bin/env bash
# Teste de fumaça da imagem: sobe o contêiner em portas alternativas (só 127.0.0.1),
# confere ponte, addon, painel e rota administrativa, e remove tudo.
#   scripts/smoke-container.sh [imagem]      (padrão asc-stremio:latest; docker ou podman)
set -Eeuo pipefail
IMAGE="${1:-asc-stremio:latest}"
ENGINE="${CONTAINER_ENGINE:-$(command -v docker || command -v podman)}"
NAME="asc-smoke-$$"
P_ADDON=17000; P_BRIDGE=17010; P_PANEL=17020
cleanup() { "$ENGINE" logs "$NAME" 2>&1 | tail -n 30 || true; "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$ENGINE" run -d --name "$NAME" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e PORT=$P_ADDON -e BRIDGE_PORT=$P_BRIDGE -e CONFIG_PORT=$P_PANEL \
  -p 127.0.0.1:$P_ADDON:$P_ADDON -p 127.0.0.1:$P_BRIDGE:$P_BRIDGE -p 127.0.0.1:$P_PANEL:$P_PANEL \
  "$IMAGE" >/dev/null

code() { curl -s -o /dev/null -w '%{http_code}' "$1" || true; }
for _ in $(seq 1 60); do [ "$(code http://127.0.0.1:$P_BRIDGE/health)" = 200 ] && break; sleep 1; done

fail=0
for url in "$P_BRIDGE/health" "$P_BRIDGE/status" "$P_ADDON/manifest.json" "$P_PANEL/"; do
  c="$(code "http://127.0.0.1:$url")"
  if [ "$c" = 200 ]; then echo "ok   $url"; else echo "FALHA $url -> $c"; fail=1; fi
done
uid="$("$ENGINE" exec "$NAME" id -u)"
[ "$uid" != 0 ] && echo "ok   processo sem root (uid $uid)" || { echo "FALHA: contêiner roda como root"; fail=1; }
exit "$fail"
