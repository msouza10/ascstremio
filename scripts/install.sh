#!/usr/bin/env bash
# Instala e valida o Amigos Share · Stremio em qualquer Linux (x64, arm64, armv7;
# glibc). Não precisa de root: se o Node 22+ não existir, baixa o oficial (com
# conferência de SHA-256) para ~/.local/share/ascstremio/node.
#
#   scripts/install.sh              confere tudo, instala o que faltar, roda os testes
#                                   e cria/inicia o serviço (systemd --user)
#   scripts/install.sh --check      só confere; não altera nada
#   scripts/install.sh --no-service instala dependências e testa, sem criar o serviço
#   scripts/install.sh --no-linger  não liga o "linger" (serviço só roda com você logado)
#   scripts/install.sh --replace-manual  encerra com SIGINT (desligamento limpo) um `npm start`
#                                   deste mesmo projeto que esteja ocupando as portas
#   scripts/install.sh --uninstall  para e remove o serviço (os dados ficam)
#   scripts/install.sh --system-node  usa só o Node do sistema (falha se não houver 22+)
#
# Variáveis: DATA_DIR (padrão: <projeto>/private) guarda passkey, sessão, cofre e logs.
# Sem systemd --user (WSL, Alpine, contêiner), instala e testa mas não cria serviço:
# o script mostra o comando para rodar à mão. Idempotente: pode rodar de novo.

set -Eeuo pipefail

NEED_NODE_MAJOR=22
UNIT_NAME="ascstremio.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
NODE_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/ascstremio/node"
PORTS=(7000 7010 7020)

MODE=install
WANT_SERVICE=1
WANT_LINGER=1
SYSTEM_NODE_ONLY=0
REPLACE_MANUAL=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --no-service) WANT_SERVICE=0 ;;
    --no-linger) WANT_LINGER=0 ;;
    --system-node) SYSTEM_NODE_ONLY=1 ;;
    --replace-manual) REPLACE_MANUAL=1 ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opção desconhecida: $arg (use --help)" >&2; exit 2 ;;
  esac
done

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT"
DATA_DIR="$(readlink -m "${DATA_DIR:-$PROJECT/private}")"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s== %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  %s✗%s %s\n' "$R" "$N" "$*"; BLOCKERS=$((BLOCKERS + 1)); }
die()  { printf '\n%s%s%s\n' "$R" "$*" "$N" >&2; exit 1; }
WARNINGS=0
BLOCKERS=0

[ "$(id -u)" -ne 0 ] || die "Não rode como root: o serviço é do seu usuário e usa a sua passkey."

# ---------------------------------------------------------------- desinstalar
if [ "$MODE" = uninstall ]; then
  step "Removendo o serviço"
  if systemctl --user list-unit-files "$UNIT_NAME" >/dev/null 2>&1 && [ -f "$UNIT_FILE" ]; then
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    cp -p "$UNIT_FILE" "$UNIT_FILE.removido-$(date +%Y%m%d-%H%M%S)"
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    ok "serviço parado e removido (cópia da unidade guardada ao lado)"
  else
    ok "o serviço não estava instalado"
  fi
  echo "  Os dados em $DATA_DIR foram mantidos. O linger (se ligado) não foi alterado."
  exit 0
fi

# ------------------------------------------------------------------- sistema
step "Sistema"
[ "$(uname -s)" = Linux ] || die "Este script é para Linux. No Windows use o instalador (windows/); no macOS rode à mão com Node 22+ (npm ci && npm start) ou use Docker."
if [ -r /etc/os-release ]; then
  . /etc/os-release
  ok "${PRETTY_NAME:-Linux} ($(uname -m))"
else
  ok "Linux ($(uname -m))"
fi
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  ok "systemd de usuário disponível"
elif [ "$WANT_SERVICE" -eq 1 ]; then
  warn "systemd --user indisponível (WSL, Alpine, contêiner ou sem sessão de usuário): vou instalar e testar, sem criar o serviço"
  WANT_SERVICE=0
fi
if command -v systemd-inhibit >/dev/null; then ok "systemd-inhibit presente (impede suspensão com seed pendente)"
else warn "systemd-inhibit ausente: o PC pode suspender no meio do seed (KEEP_AWAKE ficará sem efeito)"; fi

# --------------------------------------------------------------------- Node.js
step "Node.js ${NEED_NODE_MAJOR}+ e npm"
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }
fetch() { # fetch URL DESTINO
  if have_cmd curl; then curl -fsSL --retry 3 -o "$2" "$1"
  elif have_cmd wget; then wget -q -O "$2" "$1"
  else return 127; fi
}
sha256_of() { if have_cmd sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Node oficial (tar.gz) em ~/.local/share/ascstremio/node, sem root. O checksum vem
# do SHASUMS256.txt do próprio nodejs.org; arquivo que não confere é descartado.
install_portable_node() {
  local arch tmp base file want got
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    ppc64le) arch=ppc64le ;;
    s390x) arch=s390x ;;
    *) fail "arquitetura $(uname -m) sem build oficial do Node; instale Node ${NEED_NODE_MAJOR}+ pelo gerenciador de pacotes"; return 1 ;;
  esac
  if { ldd --version 2>&1 || true; } | grep -qi musl; then
    fail "este Linux usa musl (Alpine): o Node oficial não roda aqui. Use: apk add nodejs npm  (ou o Docker)"; return 1
  fi
  have_cmd tar || { fail "faltou o comando tar"; return 1; }
  have_cmd curl || have_cmd wget || { fail "faltou curl ou wget para baixar o Node"; return 1; }
  have_cmd sha256sum || have_cmd shasum || { fail "faltou sha256sum/shasum para conferir o download"; return 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "${tmp:-}"' RETURN
  base="https://nodejs.org/dist/latest-v${NEED_NODE_MAJOR}.x"
  echo "  Baixando Node ${NEED_NODE_MAJOR} (linux-$arch) de nodejs.org ..."
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || { fail "não consegui baixar $base/SHASUMS256.txt (sem internet?)"; return 1; }
  file="$(awk -v a="linux-$arch.tar.gz" '$2 ~ a"$" {print $2}' "$tmp/SHASUMS256.txt")"
  want="$(awk -v f="$file" '$2==f {print $1}' "$tmp/SHASUMS256.txt")"
  [ -n "$file" ] && [ -n "$want" ] || { fail "o nodejs.org não lista linux-$arch.tar.gz"; return 1; }
  fetch "$base/$file" "$tmp/$file" || { fail "falha ao baixar $file"; return 1; }
  got="$(sha256_of "$tmp/$file")"
  [ "$got" = "$want" ] || { fail "SHA-256 de $file não confere (esperado $want, obtido $got): download descartado"; return 1; }
  rm -rf "$NODE_HOME"; mkdir -p "$NODE_HOME"
  tar -xzf "$tmp/$file" -C "$NODE_HOME" --strip-components=1
  ok "SHA-256 conferido; Node instalado em $NODE_HOME"
}

# Prioridade: Node do sistema (se 22+), depois o portátil já instalado, depois baixa.
if [ "$(node_major)" -ge "$NEED_NODE_MAJOR" ]; then
  ok "node $(node -v) em $(command -v node)"
elif [ -x "$NODE_HOME/bin/node" ] && "$NODE_HOME/bin/node" -e "process.exit(Number(process.versions.node.split('.')[0])>=$NEED_NODE_MAJOR?0:1)" 2>/dev/null; then
  export PATH="$NODE_HOME/bin:$PATH"
  ok "node $(node -v) portátil em $NODE_HOME"
elif [ "$SYSTEM_NODE_ONLY" -eq 1 ]; then
  fail "node ${NEED_NODE_MAJOR}+ não encontrado e --system-node impede o download. Instale pelo seu gerenciador de pacotes ou nvm."
elif [ "$MODE" = check ]; then
  fail "node ${NEED_NODE_MAJOR}+ ausente (rode sem --check para baixar o oficial para $NODE_HOME)"
else
  if install_portable_node; then export PATH="$NODE_HOME/bin:$PATH"; fi
fi
[ "$BLOCKERS" -eq 0 ] || die "Há pendências acima; corrija e rode de novo."
have_cmd npm && ok "npm $(npm -v)" || fail "npm ausente"

[ "$BLOCKERS" -eq 0 ] || die "Há pendências acima; corrija e rode de novo."

# ------------------------------------------------------------------ dependências
step "Dependências do projeto"
if npm ls --depth=0 >/dev/null 2>&1; then
  ok "node_modules em dia"
elif [ "$MODE" = check ]; then
  fail "dependências ausentes ou fora do lock (rode sem --check)"
else
  # Os binários nativos vêm do GitHub Releases, que às vezes responde 504: tenta de novo.
  npm_ok=0
  for tentativa in 1 2 3 4; do
    if npm ci --no-audit --no-fund; then npm_ok=1; break; fi
    echo "  npm ci falhou (tentativa $tentativa de 4); aguardando"; sleep $((tentativa * 20))
  done
  [ "$npm_ok" -eq 1 ] || die "npm ci falhou depois de 4 tentativas (sem internet ou GitHub fora do ar?)."
  ok "dependências instaladas (npm ci)"
fi

# ----------------------------------------------------------------------- testes
step "Testes e verificação de sintaxe"
if npm run --silent check 2>&1 | tail -n 8; then
  ok "npm run check passou"
else
  fail "npm run check falhou: não instalo o serviço com testes quebrados"
fi
[ "$BLOCKERS" -eq 0 ] || die "Os testes falharam."

# -------------------------------------------------------------- credenciais/dados
step "Dados e credenciais ($DATA_DIR)"
if [ "$MODE" != check ]; then
  mkdir -p "$DATA_DIR/torrents"
  chmod 700 "$DATA_DIR"
fi
if [ -d "$DATA_DIR" ]; then
  perm="$(stat -c %a "$DATA_DIR")"
  [ "$perm" = 700 ] && ok "$DATA_DIR com permissão 700" || warn "$DATA_DIR está com permissão $perm (esperado 700)"
fi
if [ -f "$DATA_DIR/passkey.txt" ]; then
  perm="$(stat -c %a "$DATA_DIR/passkey.txt")"
  [ "$perm" = 600 ] && ok "passkey.txt presente (600)" || warn "passkey.txt com permissão $perm (esperado 600)"
else
  warn "passkey.txt ausente: torrents privados ficarão sem peers. Crie com: printf '%s' SUA_PASSKEY > $DATA_DIR/passkey.txt && chmod 600 $DATA_DIR/passkey.txt"
fi
if [ -f "$DATA_DIR/asc-session.json" ]; then ok "sessão do ASC salva (confirmada ao abrir o painel)"
else warn "sem sessão do ASC: abra http://127.0.0.1:7020/ e entre depois de subir o serviço"; fi
n_torrents="$(find "$DATA_DIR/torrents" -maxdepth 1 -name '*.torrent' 2>/dev/null | wc -l)"
ok "$n_torrents arquivo(s) .torrent na biblioteca"

ENV_FILE="$DATA_DIR/service.env"
if [ ! -f "$ENV_FILE" ] && [ "$MODE" != check ]; then
  umask 077
  cat > "$ENV_FILE" <<'EOF'
# Variáveis do serviço (lidas por systemd; uma por linha, sem aspas nem "export").
# Depois de editar:  systemctl --user restart ascstremio

# Conclui sozinho, em segundo plano, os freeleech parados há alguns minutos (off|auto)
#BACKGROUND_COMPLETE=off
#BACKGROUND_IDLE_MINUTES=10

# Ao cumprir o limite (72 h ou ratio 1.0) e o tracker confirmar:
#   delete = encerra o seed e apaga os arquivos | stop = encerra e mantém | keep = continua
#AFTER_SEED=delete

# Catálogo "ASC — status" dentro do Stremio (on|off) e endereço dos cartões em outro aparelho
#STATUS_CATALOG=on
#ADDON_PUBLIC_URL=

# Logs (a página /logs e private/logs/): nível mínimo gravado e dias de retenção
#LOG_LEVEL=debug
#LOG_RETENTION_DAYS=14

# Impede a suspensão do PC só enquanto há seed pendente (auto|off)
#KEEP_AWAKE=auto

# Porta fixa de entrada dos peers do torrent (padrão: aleatória)
#TORRENT_PORT=

# Limite de upload da ponte em bytes/s (padrão: sem limite)
#BRIDGE_UPLOAD_LIMIT=

# Teto de upload (bytes/s, mínimo 16384) enquanto há reprodução; padrão: não reduz
#BRIDGE_STREAM_UPLOAD_LIMIT=

# Libera a ponte para a rede local (TV/celular). Sem autenticação: use só em rede confiável.
#BRIDGE_ALLOW_LAN=1
EOF
  ok "criado $ENV_FILE (modelo comentado, permissão 600)"
elif [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE presente"
fi

# ----------------------------------------------------------------------- serviço
if [ "$WANT_SERVICE" -eq 0 ]; then
  step "Serviço"; ok "não criado. Para rodar à mão: cd $PROJECT && DATA_DIR=$DATA_DIR npm start"
  ok "configuração no terminal (com o aplicativo parado para alterar): cd $PROJECT && DATA_DIR=$DATA_DIR npm run configurar"
  exit 0
fi

step "Serviço systemd (usuário)"
NODE_BIN="$(readlink -f "$(command -v node)")"
service_active() { systemctl --user is-active --quiet "$UNIT_NAME"; }

# Quem está escutando em cada porta do projeto (pid), para distinguir uma instância
# manual deste mesmo projeto (`npm start`) de qualquer outro programa.
port_pids() { have_cmd ss && ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true; }
is_manual_instance() {
  local pid="$1"
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$PROJECT" ] \
    && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'src/index\.js'
}

# Migração do nome antigo (brazuka-asc): para e remove a unidade antiga, guardando uma cópia.
LEGACY_UNIT="$UNIT_DIR/brazuka-asc.service"
if [ -f "$LEGACY_UNIT" ] && [ "$MODE" != check ]; then
  systemctl --user disable --now brazuka-asc.service 2>/dev/null || true
  mv "$LEGACY_UNIT" "$LEGACY_UNIT.removido-$(date +%Y%m%d-%H%M%S)"
  systemctl --user daemon-reload
  ok "serviço antigo brazuka-asc parado e removido (cópia guardada ao lado); o novo é $UNIT_NAME"
elif [ -f "$LEGACY_UNIT" ]; then
  warn "existe o serviço antigo brazuka-asc; rode sem --check para migrar para $UNIT_NAME"
fi

# Portas ocupadas impedem a subida do serviço.
if ! service_active; then
  MANUAL=()
  for p in "${PORTS[@]}"; do
    for pid in $(port_pids "$p"); do
      if is_manual_instance "$pid"; then
        [[ " ${MANUAL[*]:-} " == *" $pid "* ]] || MANUAL+=("$pid")
      else
        fail "a porta $p está em uso por outro programa (pid $pid: $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-70)); encerre-o e rode de novo"
      fi
    done
  done
  if [ "${#MANUAL[@]}" -gt 0 ]; then
    if [ "$REPLACE_MANUAL" -eq 1 ] && [ "$MODE" != check ] && [ "$BLOCKERS" -eq 0 ]; then
      for pid in "${MANUAL[@]}"; do
        echo "  Encerrando a instância manual (pid $pid) com SIGINT; o cofre e o tempo de seed são preservados."
        kill -INT "$pid"
        for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
        kill -0 "$pid" 2>/dev/null && fail "a instância $pid não encerrou em 30 s; feche o terminal do 'npm start' e rode de novo"
      done
      [ "$BLOCKERS" -gt 0 ] || ok "instância manual encerrada de forma limpa"
    elif [ "$REPLACE_MANUAL" -eq 1 ] && [ "$MODE" = check ]; then
      warn "(--check) com --replace-manual o script encerraria o 'npm start' deste projeto (pid ${MANUAL[*]})"
    else
      fail "há um 'npm start' deste projeto rodando (pid ${MANUAL[*]}) nas portas do serviço. Feche-o (Ctrl+C) ou rode: scripts/install.sh --replace-manual"
    fi
  fi
  [ "$BLOCKERS" -eq 0 ] || { [ "$MODE" = check ] || die "Libere as portas acima antes de instalar o serviço."; }
fi

UNIT_CONTENT="[Unit]
Description=Amigos Share · Stremio (ponte, addon e painel de monitoramento)
Documentation=file://$PROJECT/README.md
StartLimitIntervalSec=600
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=$PROJECT
EnvironmentFile=-$ENV_FILE
Environment=DATA_DIR=$DATA_DIR
# Serviço de usuário não enxerga network-online.target: espera a rede aqui.
# O \"-\" deixa subir mesmo sem NetworkManager ou sem internet (a ponte tenta de novo sozinha).
ExecStartPre=-$(command -v nm-online || echo /usr/bin/nm-online) -q -t 90
TimeoutStartSec=120
ExecStart=$NODE_BIN --max-http-header-size=65536 src/index.js
Restart=on-failure
RestartSec=15
TimeoutStopSec=30
KillSignal=SIGINT
# Endurecimento que não depende de namespaces (funciona em qualquer systemd --user)
NoNewPrivileges=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077

[Install]
WantedBy=default.target
"

if [ "$MODE" = check ]; then
  if [ -f "$UNIT_FILE" ]; then
    [ "$(cat "$UNIT_FILE")" = "${UNIT_CONTENT%$'\n'}" ] && ok "unidade $UNIT_NAME em dia" || warn "unidade instalada difere da esperada (rode sem --check para atualizar)"
    service_active && ok "serviço ativo" || warn "serviço instalado, mas parado"
  else
    warn "serviço ainda não instalado"
  fi
  echo; echo "Verificação concluída: $WARNINGS aviso(s), $BLOCKERS pendência(s)."
  [ "$BLOCKERS" -eq 0 ]; exit $?
fi

mkdir -p "$UNIT_DIR"
if [ -f "$UNIT_FILE" ] && [ "$(cat "$UNIT_FILE")" != "${UNIT_CONTENT%$'\n'}" ]; then
  cp -p "$UNIT_FILE" "$UNIT_FILE.bak-$(date +%Y%m%d-%H%M%S)"
  ok "unidade anterior copiada para $UNIT_FILE.bak-*"
fi
printf '%s' "$UNIT_CONTENT" > "$UNIT_FILE"
systemd-analyze --user verify "$UNIT_FILE" 2>&1 | sed 's/^/    /' || true
systemctl --user daemon-reload
ok "unidade escrita em $UNIT_FILE"

if [ "$WANT_LINGER" -eq 1 ]; then
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]; then
    ok "linger já ligado (o serviço sobe no boot, sem precisar logar)"
  elif loginctl enable-linger "$USER" 2>/dev/null; then
    ok "linger ligado: o serviço sobe no boot, sem precisar logar"
  else
    warn "não consegui ligar o linger (precisa de autorização). O serviço só roda com você logado. Tente: loginctl enable-linger $USER"
  fi
else
  warn "linger não ligado (--no-linger): o serviço só roda com você logado"
fi

systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
if service_active; then
  systemctl --user restart "$UNIT_NAME"
  ok "serviço reiniciado com a unidade atual"
else
  systemctl --user start "$UNIT_NAME"
  ok "serviço iniciado"
fi

# Espera a ponte responder (a primeira partida pode levar um tempo).
up=0
for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:7010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then up=1; break; fi
  service_active || break
  sleep 2
done
if [ "$up" -eq 1 ]; then
  ok "ponte respondendo em http://127.0.0.1:7010/health"
else
  fail "o serviço não respondeu. Veja: journalctl --user -u $UNIT_NAME -n 50 --no-pager"
fi

# Credencial de reprodução: o addon recusa tudo sem uma. Emite a primeira só se não houver
# nenhuma ativa (o token aparece uma vez, aqui no terminal; nunca vai ao log do serviço).
# O DATA_DIR vai explícito: na instalação remota ele não é <projeto>/private, que é o padrão da CLI.
ADDON_LINE="http://127.0.0.1:7000/<credencial>/manifest.json (emita: cd \"$PROJECT\" && DATA_DIR=\"$DATA_DIR\" npm run credenciais -- criar \"Stremio\")"
if [ "$up" -eq 1 ] && [ "$MODE" != check ]; then
  step "Credencial de reprodução"
  if issued="$(DATA_DIR="$DATA_DIR" node "$PROJECT/src/credenciais-cli.js" garantir 2>&1)"; then
    echo "$issued" | sed 's/^/  /'
  else
    warn "não foi possível emitir a credencial agora: $issued"
  fi
fi

step "Pronto"
cat <<EOF
  Painel e login : http://127.0.0.1:7020/
  Addon (Stremio): $ADDON_LINE
  Estado         : systemctl --user status $UNIT_NAME
  Logs           : journalctl --user -u $UNIT_NAME -f
  Configuração   : DATA_DIR="$DATA_DIR" "$NODE_BIN" "$PROJECT/src/configurar-cli.js"  (ou: npm run configurar)
                   variáveis fixas do serviço: $ENV_FILE  (depois: systemctl --user restart $UNIT_NAME)
  Desinstalar    : scripts/install.sh --uninstall
EOF
echo "  $WARNINGS aviso(s), $BLOCKERS pendência(s)."
[ "$BLOCKERS" -eq 0 ]
