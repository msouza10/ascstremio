#!/usr/bin/env bash
# Confere se os títulos dos commits seguem Conventional Commits, que é o que decide a versão:
#   feat: ...          -> versão menor (0.1.0 -> 0.2.0)     fix:/perf:/security: -> correção (0.1.0 -> 0.1.1)
#   feat!: ... ou rodapé "BREAKING CHANGE:" -> versão maior (em 0.x conta como menor)
#   docs: refactor: build: ci: test: chore: style: -> entram no changelog (ou não) sem subir versão
#   scripts/check-commits.sh <base>..<head>     (padrão: origin/main..HEAD)
set -Eeuo pipefail
RANGE="${1:-origin/main..HEAD}"
RE='^(feat|fix|perf|security|refactor|docs|build|ci|test|chore|style|revert)(\([a-z0-9._/-]+\))?!?: .{3,}'
bad=0
while IFS=$'\t' read -r sha subject; do
  if ! [[ "$subject" =~ $RE ]]; then echo "fora do padrão: $sha $subject"; bad=1; fi
done < <(git log --no-merges --format='%h%x09%s' "$RANGE")
if [ "$bad" -eq 0 ]; then echo "ok   commits no padrão Conventional Commits"
else echo "Use: tipo(escopo opcional): descrição  (tipos: feat fix perf security refactor docs build ci test chore style revert)"; exit 1; fi
