#!/usr/bin/env bash
# Instalação por uma linha (Linux):
#
#   curl -fsSL <URL-base>/install.sh | bash
#   curl -fsSL <URL-base>/install.sh | bash -s -- --no-service
#
# Baixa o pacote, confere o SHA-256, instala em ~/.local/share/ascstremio/app e
# chama scripts/install.sh (Node portátil se faltar, testes, serviço systemd).
# Atualizar = rodar de novo: o código é trocado, os dados em .../data ficam.
#
# ASCSTREMIO_BASE_URL  pasta com ascstremio-latest.tar.gz e .sha256 (http(s):// ou file://)
# ASCSTREMIO_HOME      destino (padrão ~/.local/share/ascstremio)
# Este arquivo é a fonte; scripts/build-release.sh gera dist/install.sh com a URL fixa.

set -Eeuo pipefail

DEFAULT_BASE_URL=""
BASE_URL="${ASCSTREMIO_BASE_URL:-$DEFAULT_BASE_URL}"
HOME_DIR="${ASCSTREMIO_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ascstremio}"

die() { echo "Erro: $*" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || die "não rode como root: o serviço é do seu usuário e usa a sua passkey."
[ "$(uname -s)" = Linux ] || die "este instalador é para Linux (Windows: instalador .exe; outros: Docker)."
[ -n "$BASE_URL" ] || die "defina ASCSTREMIO_BASE_URL (pasta com ascstremio-latest.tar.gz)."
BASE_URL="${BASE_URL%/}"
for c in tar gzip mktemp; do command -v "$c" >/dev/null || die "faltou o comando $c"; done
if command -v curl >/dev/null; then dl() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null; then dl() { wget -q -O "$2" "$1"; }
else die "faltou curl ou wget"; fi
if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "faltou sha256sum ou shasum"; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "Baixando $BASE_URL/ascstremio-latest.tar.gz ..."
dl "$BASE_URL/ascstremio-latest.tar.gz" "$tmp/pkg.tar.gz" || die "falha ao baixar o pacote"
dl "$BASE_URL/ascstremio-latest.tar.gz.sha256" "$tmp/pkg.sha256" || die "falha ao baixar o .sha256"
want="$(cut -d' ' -f1 "$tmp/pkg.sha256")"; got="$(sha "$tmp/pkg.tar.gz")"
[ -n "$want" ] && [ "$want" = "$got" ] || die "SHA-256 não confere (esperado '$want', obtido '$got'): nada foi instalado."

# Só caminhos relativos e sem ".." entram na extração.
if tar -tzf "$tmp/pkg.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "pacote com caminhos suspeitos; abortado."; fi
mkdir -p "$tmp/x"; tar -xzf "$tmp/pkg.tar.gz" -C "$tmp/x" --strip-components=1
[ -f "$tmp/x/scripts/install.sh" ] || die "pacote inválido (sem scripts/install.sh)."

mkdir -p "$HOME_DIR"
if [ -d "$HOME_DIR/app" ]; then rm -rf "$HOME_DIR/app.anterior"; mv "$HOME_DIR/app" "$HOME_DIR/app.anterior"; fi
mv "$tmp/x" "$HOME_DIR/app"
echo "Código em $HOME_DIR/app (dados em $HOME_DIR/data)"
cd "$HOME_DIR/app"
if DATA_DIR="$HOME_DIR/data" bash scripts/install.sh "$@"; then
  rm -rf "$HOME_DIR/app.anterior"
else
  rc=$?
  [ -d "$HOME_DIR/app.anterior" ] && echo "A instalação falhou; a versão anterior está em $HOME_DIR/app.anterior" >&2
  exit "$rc"
fi
