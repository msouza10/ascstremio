#!/usr/bin/env bash
# Barreira de publicação: falha se o que seria distribuído contém dados da conta.
# Procura (sem imprimir valores) por: pastas/arquivos de dados, .torrent e URLs de
# announce com passkey. Roda sobre a árvore atual ou sobre um .tar.gz.
#   scripts/check-no-secrets.sh [diretório | arquivo.tar.gz]   (padrão: .)
set -Eeuo pipefail
TARGET="${1:-.}"
if [ -f "$TARGET" ]; then
  W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; tar -xzf "$TARGET" -C "$W"; TARGET="$W"
fi
cd "$TARGET"
bad=0
report() { echo "BLOQUEADO: $1"; bad=1; }

# git quando existir (respeita .gitignore); senão, a árvore sem node_modules/dist.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then files="$(git ls-files)"
else files="$(find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './private/*' -not -path './docs/*' -not -path './tools/*' -not -path './.git/*' | sed 's#^\./##' | grep -vE '\.md$' ; echo README.md)"; fi

echo "$files" | grep -E '(^|/)private/' | grep -q . && report "arquivos dentro de private/"
echo "$files" | grep -E '\.torrent$|(^|/)(passkey\.txt|bridge-key|admin-key|asc-session\.json|seed-vault\.json|service\.env)$' | grep -q . && report ".torrent, passkey, sessão, cofre ou service.env no pacote"
# announce com token (16+ caracteres alfanuméricos depois de /announce/ ou ?passkey=)
if echo "$files" | tr '\n' '\0' | xargs -0 grep -IlE 'announce/[A-Za-z0-9]{16,}|passkey=[A-Za-z0-9]{16,}' 2>/dev/null | grep -q .; then
  report "URL de announce com passkey em: $(echo "$files" | tr '\n' '\0' | xargs -0 grep -IlE 'announce/[A-Za-z0-9]{16,}|passkey=[A-Za-z0-9]{16,}' 2>/dev/null | tr '\n' ' ')"
fi
# só o README é documentação publicada; docs/ e tools/ ficam locais
echo "$files" | grep -E '^(docs|tools)/' | grep -q . && report "docs/ ou tools/ no pacote (só README, CHANGELOG, AGENTS e CLAUDE são publicados)"
echo "$files" | grep -E '\.md$' | grep -vE '^(README|CHANGELOG|AGENTS|CLAUDE)\.md$' | grep -q . && report "documento .md além de README, CHANGELOG, AGENTS e CLAUDE"
# a passkey real desta máquina (se existir) não pode aparecer em lugar nenhum
for pk in "$OLDPWD/private/passkey.txt" "$HOME/.local/share/ascstremio/data/passkey.txt"; do
  if [ -s "$pk" ] && echo "$files" | tr '\n' '\0' | xargs -0 grep -IlF -- "$(tr -d '\n' < "$pk")" 2>/dev/null | grep -q .; then
    report "a passkey real aparece em arquivos do pacote"
  fi
done
[ "$bad" -eq 0 ] && echo "ok   nenhum dado de conta encontrado"
exit "$bad"
