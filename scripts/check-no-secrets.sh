#!/usr/bin/env bash
# Barreira de publicação: falha se o que seria distribuído contém dados da conta.
# Procura (sem imprimir valores) por: pastas/arquivos de dados, .torrent e URLs de
# announce com passkey. Roda sobre a árvore atual ou sobre um .tar.gz.
#   scripts/check-no-secrets.sh [diretório | arquivo.tar.gz]   (padrão: .)
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DOCS="$SCRIPT_DIR/documentation-files.txt"
TARGET="${1:-.}"
if [ -f "$TARGET" ]; then
  W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; tar -xzf "$TARGET" -C "$W"; TARGET="$W"
  # O pacote de release tem uma única pasta raiz; validar nomes relativos a ela.
  mapfile -t roots < <(find "$W" -mindepth 1 -maxdepth 1 -print)
  if [ "${#roots[@]}" -eq 1 ] && [ -d "${roots[0]}" ]; then TARGET="${roots[0]}"; fi
fi
cd "$TARGET"
bad=0
report() { echo "BLOQUEADO: $1"; bad=1; }

# git quando existir (respeita .gitignore); senão, a árvore sem node_modules/dist.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then files="$(git ls-files --cached --others --exclude-standard)"
else files="$(find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*' | sed 's#^\./##')"; fi

echo "$files" | grep -E '(^|/)private/' | grep -q . && report "arquivos dentro de private/"
echo "$files" | grep -E '\.torrent$|(^|/)(passkey\.txt|bridge-key|admin-key|credentials\.json|alert-webhook\.json|asc-session\.json|seed-vault\.json|meta-cache\.json|service\.env)$' | grep -q . && report ".torrent, passkey, sessão, cofre ou service.env no pacote"
# announce com token (16+ caracteres alfanuméricos depois de /announce/ ou ?passkey=)
if echo "$files" | tr '\n' '\0' | xargs -0 grep -IlE 'announce/[A-Za-z0-9]{16,}|passkey=[A-Za-z0-9]{16,}|ascc_[A-Za-z0-9_-]{43}' 2>/dev/null | grep -q .; then
  report "URL de announce com passkey ou credencial em: $(echo "$files" | tr '\n' '\0' | xargs -0 grep -IlE 'announce/[A-Za-z0-9]{16,}|passkey=[A-Za-z0-9]{16,}|ascc_[A-Za-z0-9_-]{43}' 2>/dev/null | tr '\n' ' ')"
fi
# A lista é explícita: nunca publicar notas/capturas antigas só por estarem em docs/.
while IFS= read -r file; do
  case "$file" in
    tools/*) report "tools/ no pacote" ;;
    README.md|CHANGELOG.md|AGENTS.md|CLAUDE.md) ;;
    .github/*.md) ;;
    docs/*|*.md)
      if ! grep -Fxq -- "$file" "$PUBLIC_DOCS"; then
        report "documento ou arquivo local não autorizado: $file"
      fi ;;
  esac
done <<< "$files"
# a passkey real desta máquina (se existir) não pode aparecer em lugar nenhum
for pk in "$OLDPWD/private/passkey.txt" "$HOME/.local/share/ascstremio/data/passkey.txt"; do
  if [ -s "$pk" ] && echo "$files" | tr '\n' '\0' | xargs -0 grep -IlF -- "$(tr -d '\n' < "$pk")" 2>/dev/null | grep -q .; then
    report "a passkey real aparece em arquivos do pacote"
  fi
done
[ "$bad" -eq 0 ] && echo "ok   nenhum dado de conta encontrado"
exit "$bad"
