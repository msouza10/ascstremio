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
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then files="$(git -c core.quotepath=off ls-files --cached --others --exclude-standard)"
else files="$(find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*' | sed 's#^\./##')"; fi

echo "$files" | grep -E '(^|/)private/' | grep -q . && report "arquivos dentro de private/"
echo "$files" | grep -E '\.torrent$|(^|/)(passkey\.txt|bridge-key|admin-key|panel-admin\.json|alert-webhook\.json|credentials\.json|asc-session\.json|seed-vault\.json|meta-cache\.json|service\.env)$' | grep -q . && report ".torrent, passkey, sessão, cofre ou service.env no pacote"
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

# Imagens públicas (docs/imagens/): só PNG ou WebP, até 200 KiB cada (2 MiB no total), até 1280 px
# de largura e sem metadados (texto, EXIF, XMP), que podem carregar usuário, máquina e caminhos
# de quem gerou a captura. Os blocos são percorridos pela estrutura do arquivo, não por busca de
# texto: assim os bytes de pixels que lembrem "tEXt" não geram falso positivo. Limites do
# `.github/CONTRIBUTING.md`.
IMG_MAX_BYTES=204800
IMG_MAX_TOTAL=2097152
IMG_MAX_WIDTH=1280
# Número (decimal) de n bytes do arquivo a partir de um deslocamento: big-endian ou little-endian.
IMG_MAX_CHUNKS=1000 # capturas reais têm poucas dezenas; o teto evita varrer arquivo hostil
# Os campos e a largura saem do próprio arquivo (sem ImageMagick), sempre falhando fechado: leitura
# que falha devolve -1 e o chamador trata o arquivo como inválido.
img_uint() { # arquivo deslocamento n endian(be|le)
  local bytes v=0 i
  local -a arr
  bytes="$(od -An -v -tu1 -j "$2" -N "$3" "$1")" || { echo -1; return; }
  read -ra arr <<< "$bytes"
  [ "${#arr[@]}" -eq "$3" ] || { echo -1; return; }
  if [ "$4" = le ]; then
    for ((i = ${#arr[@]} - 1; i >= 0; i--)); do v=$((v * 256 + arr[i])); done
  else
    for ((i = 0; i < ${#arr[@]}; i++)); do v=$((v * 256 + arr[i])); done
  fi
  echo "$v"
}
img_tag() { LC_ALL=C dd if="$1" bs=1 skip="$2" count=4 2>/dev/null; } # 4 caracteres ASCII
# Percorre os blocos e escreve "ok:<largura>", "meta:<tipo>" ou "invalido".
img_scan() { # arquivo tamanho
  local f="$1" size="$2" off len tag w=0 n=0 maxw=0 v
  if [ "$size" -ge 33 ] && [ "$(od -An -v -tx1 -N8 "$f" | tr -d ' \n')" = 89504e470d0a1a0a ]; then
    # O primeiro bloco precisa ser o IHDR (13 bytes): dele vem a largura.
    [ "$(img_tag "$f" 12)" = IHDR ] && [ "$(img_uint "$f" 8 4 be)" -eq 13 ] || { echo invalido; return; }
    w="$(img_uint "$f" 16 4 be)"; off=8
    [ "$w" -gt 0 ] || { echo invalido; return; }
    while [ "$off" -lt "$size" ] && [ "$n" -lt "$IMG_MAX_CHUNKS" ]; do
      n=$((n + 1))
      [ $((off + 12)) -le "$size" ] || { echo invalido; return; }
      len="$(img_uint "$f" "$off" 4 be)"; tag="$(img_tag "$f" $((off + 4)))"
      [ "$len" -ge 0 ] || { echo invalido; return; }
      case "$tag" in tEXt|iTXt|zTXt|eXIf) echo "meta:$tag"; return ;; esac
      off=$((off + len + 12))
      if [ "$tag" = IEND ]; then [ "$off" -eq "$size" ] && echo "ok:$w" || echo invalido; return; fi
    done
    echo invalido; return
  fi
  if [ "$size" -ge 20 ] && [ "$(img_tag "$f" 0)" = RIFF ] && [ "$(img_tag "$f" 8)" = WEBP ]; then
    off=12
    while [ "$off" -lt "$size" ] && [ "$n" -lt "$IMG_MAX_CHUNKS" ]; do
      n=$((n + 1))
      [ $((off + 8)) -le "$size" ] || { echo invalido; return; }
      tag="$(img_tag "$f" "$off")"; len="$(img_uint "$f" $((off + 4)) 4 le)"
      [ "$len" -ge 0 ] || { echo invalido; return; }
      case "$tag" in
        'EXIF'|'XMP ') echo "meta:$tag"; return ;;
        VP8X) v="$(img_uint "$f" $((off + 12)) 3 le)"; [ "$v" -ge 0 ] && w=$((v + 1)) || w=0 ;;
        VP8L) v="$(img_uint "$f" $((off + 9)) 4 le)"; [ "$v" -ge 0 ] && w=$(((v & 16383) + 1)) || w=0 ;;
        'VP8 ') v="$(img_uint "$f" $((off + 14)) 2 le)"; [ "$v" -ge 0 ] && w=$((v & 16383)) || w=0 ;;
        *) w=0 ;;
      esac
      [ "$w" -le "$maxw" ] || maxw="$w"
      off=$((off + 8 + len + (len % 2)))
    done
    # Fim exato do arquivo (o último bloco de tamanho ímpar leva 1 byte de enchimento) e largura conhecida.
    { [ "$off" -eq "$size" ] || [ "$off" -eq $((size + 1)) ]; } && [ "$maxw" -gt 0 ] && echo "ok:$maxw" || echo invalido
    return
  fi
  echo invalido
}
img_total=0
while IFS= read -r file; do
  case "$file" in docs/imagens/*) ;; *) continue ;; esac
  [ -f "$file" ] || continue
  case "$file" in
    *.png|*.webp) ;;
    *) report "imagem com extensão fora de png/webp: $file"; continue ;;
  esac
  bytes="$(wc -c < "$file")" || { report "imagem ilegível: $file"; continue; }
  img_total=$((img_total + bytes))
  # Acima do limite não vale a pena varrer os blocos (e arquivo hostil não trava a barreira).
  [ "$bytes" -le "$IMG_MAX_BYTES" ] || { report "imagem acima de 200 KiB: $file"; continue; }
  result="$(img_scan "$file" "$bytes")"
  case "$result" in
    meta:*) report "imagem com metadados (${result#meta:}): $file" ;;
    ok:*) [ "${result#ok:}" -le "$IMG_MAX_WIDTH" ] || report "imagem acima de 1280 px de largura: $file" ;;
    *) report "imagem ilegível ou inválida (PNG/WebP esperado): $file" ;;
  esac
done <<< "$files"
[ "$img_total" -le "$IMG_MAX_TOTAL" ] || report "docs/imagens/ acima de 2 MiB no total"

# a passkey real desta máquina (se existir) não pode aparecer em lugar nenhum
for pk in "$OLDPWD/private/passkey.txt" "$HOME/.local/share/ascstremio/data/passkey.txt"; do
  if [ -s "$pk" ] && echo "$files" | tr '\n' '\0' | xargs -0 grep -IlF -- "$(tr -d '\n' < "$pk")" 2>/dev/null | grep -q .; then
    report "a passkey real aparece em arquivos do pacote"
  fi
done
[ "$bad" -eq 0 ] && echo "ok   nenhum dado de conta encontrado"
exit "$bad"
