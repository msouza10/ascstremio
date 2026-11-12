#!/usr/bin/env bash
# Auditoria de segredos com o gitleaks, em modo local e com valores redigidos. Complementa
# scripts/check-no-secrets.sh, que olha só a árvore e os pacotes.
#   scripts/audit-secrets.sh [--head]         histórico git (relatório em dist/audit-secrets.json)
#   scripts/audit-secrets.sh --dir PASTA      conteúdo de uma pasta (ex.: instalador .exe extraído)
#   scripts/audit-secrets.sh --image IMAGEM   sistema de arquivos de uma imagem (docker ou podman)
# Sem argumentos varre TODAS as refs (auditoria antes de publicar o repositório). Com --head varre
# só o histórico do commit atual: é o que o CI usa, para a branch de outra pessoa não reprovar o PR.
# --dir e --image cobrem o que sai do repositório (imagem, instalador): o histórico não os alcança.
# A versão do gitleaks e o SHA-256 do binário ficam fixados aqui. Nada é enviado a serviços externos.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

uso() { echo "uso: $0 [--head | --dir PASTA | --image IMAGEM]" >&2; exit 2; }

MODO="historico"; ALVO=""; LOG_OPTS=""
case "${1:-}" in
  "") LOG_OPTS="--all" ;;
  --head) LOG_OPTS="HEAD" ;;
  --dir) [ -d "${2:-}" ] || uso; MODO="pasta"; ALVO="$2" ;;
  --image) [ -n "${2:-}" ] || uso; MODO="imagem"; ALVO="$2" ;;
  *) uso ;;
esac

VERSION="8.30.1"
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" # gitleaks_${VERSION}_linux_x64.tar.gz
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ascstremio/gitleaks-$VERSION"

tmp="$(mktemp -d)"; ctr=""; engine=""
limpa() { [ -z "$ctr" ] || "$engine" rm -f "$ctr" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap limpa EXIT

if [ ! -x "$CACHE/gitleaks" ]; then
  [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "Este script baixa o binário linux x64; em outro sistema rode o gitleaks $VERSION à mão." >&2; exit 2; }
  mkdir -p "$CACHE"
  curl -fsSL --retry 3 -o "$tmp/gl.tar.gz" "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_linux_x64.tar.gz"
  echo "$SHA256  $tmp/gl.tar.gz" | sha256sum -c - >/dev/null || { echo "SHA-256 do gitleaks não confere" >&2; exit 1; }
  tar -xzf "$tmp/gl.tar.gz" -C "$CACHE" gitleaks
fi

mkdir -p dist
REPORT=(--report-format json --report-path dist/audit-secrets.json)

if [ "$MODO" = "historico" ]; then
  echo "gitleaks $("$CACHE/gitleaks" version) · SHA $(git rev-parse --short HEAD) · escopo: $LOG_OPTS"
  [ "$LOG_OPTS" != "--all" ] || echo "refs: $(git for-each-ref --format='%(refname:short)' | tr '\n' ' ')"
  "$CACHE/gitleaks" git . --config .gitleaks.toml --log-opts="$LOG_OPTS" --redact --no-banner "${REPORT[@]}"
  echo "ok   nenhum segredo no histórico (relatório sem valores em dist/audit-secrets.json)"
  exit 0
fi

if [ "$MODO" = "imagem" ]; then
  engine="$(command -v docker || command -v podman)" || { echo "faltou docker ou podman para exportar a imagem" >&2; exit 2; }
  ctr="$("$engine" create "$ALVO")"
  mkdir -p "$tmp/fs"
  # dev/ fica de fora: nós de dispositivo não se extraem sem root e não têm conteúdo a varrer.
  "$engine" export "$ctr" | tar -x -C "$tmp/fs" --exclude='dev/*'
  echo "gitleaks $("$CACHE/gitleaks" version) · SHA $(git rev-parse --short HEAD) · escopo: imagem $ALVO"
  ALVO="$tmp/fs"
else
  echo "gitleaks $("$CACHE/gitleaks" version) · SHA $(git rev-parse --short HEAD) · escopo: pasta $ALVO"
fi
"$CACHE/gitleaks" dir "$ALVO" --config .gitleaks.toml --redact --no-banner "${REPORT[@]}"
echo "ok   nenhum segredo na $MODO (relatório sem valores em dist/audit-secrets.json)"
