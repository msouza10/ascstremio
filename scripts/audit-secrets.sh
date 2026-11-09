#!/usr/bin/env bash
# Auditoria de segredos em TODO o histórico (todas as refs) com o gitleaks, em modo local e com
# valores redigidos. Complementa scripts/check-no-secrets.sh, que olha só a árvore e os pacotes.
#   scripts/audit-secrets.sh [--head]   (relatório JSON em dist/audit-secrets.json)
# Sem argumentos varre TODAS as refs (auditoria antes de publicar o repositório). Com --head varre
# só o histórico do commit atual: é o que o CI usa, para a branch de outra pessoa não reprovar o PR.
# A versão do gitleaks e o SHA-256 do binário ficam fixados aqui. Nada é enviado a serviços externos.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

case "${1:-}" in
  "") LOG_OPTS="--all" ;;
  --head) LOG_OPTS="HEAD" ;;
  *) echo "uso: $0 [--head]" >&2; exit 2 ;;
esac

VERSION="8.30.1"
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" # gitleaks_${VERSION}_linux_x64.tar.gz
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ascstremio/gitleaks-$VERSION"

if [ ! -x "$CACHE/gitleaks" ]; then
  [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "Este script baixa o binário linux x64; em outro sistema rode o gitleaks $VERSION à mão." >&2; exit 2; }
  mkdir -p "$CACHE"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/gl.tar.gz" "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_linux_x64.tar.gz"
  echo "$SHA256  $tmp/gl.tar.gz" | sha256sum -c - >/dev/null || { echo "SHA-256 do gitleaks não confere" >&2; exit 1; }
  tar -xzf "$tmp/gl.tar.gz" -C "$CACHE" gitleaks
fi

mkdir -p dist
echo "gitleaks $("$CACHE/gitleaks" version) · SHA $(git rev-parse --short HEAD) · escopo: $LOG_OPTS"
[ "$LOG_OPTS" != "--all" ] || echo "refs: $(git for-each-ref --format='%(refname:short)' | tr '\n' ' ')"
"$CACHE/gitleaks" git . --config .gitleaks.toml --log-opts="$LOG_OPTS" --redact --no-banner \
  --report-format json --report-path dist/audit-secrets.json
echo "ok   nenhum segredo no histórico (relatório sem valores em dist/audit-secrets.json)"
