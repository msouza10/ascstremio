// Salvaguardas ligadas às regras do ASC: conta pessoal (2.2) e inatividade (2.6).

const DAY_MS = 86_400_000;
const INACTIVITY_LIMIT_DAYS = 90; // regra 2.6: sem acesso por 90 dias, banimento
const INACTIVITY_WARN_DAYS = 60;

// Dentro de um contêiner (ASC_STREMIO_CONTAINER=1) o processo precisa escutar em
// 0.0.0.0 para a porta publicada chegar nele; quem restringe ao 127.0.0.1 da
// máquina é a publicação da porta (`-p 127.0.0.1:7000:7000`), ver docker-compose.yml.
function inContainer(env = process.env) {
  return env.ASC_STREMIO_CONTAINER === '1';
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLoopbackAddress(address, env = process.env) {
  if (!address) return false;
  const value = String(address).replace(/^::ffff:/i, '');
  if (value === '::1' || /^127\.\d+\.\d+\.\d+$/.test(value)) return true;
  // No contêiner, quem chega pela porta publicada vem do gateway da rede do Docker.
  return inContainer(env) && PRIVATE_V4.test(value);
}

// Rotas administrativas da ponte (/cleanup, /seed-status, /status) só atendem
// quem está nesta máquina. Falha fechada se o socket não puder ser lido.
function isLoopbackRequest(req, env = process.env) {
  return isLoopbackAddress(req?.socket?.remoteAddress, env);
}

// Interface de escuta da ponte. Sem opt-in explícito, só loopback: expor a
// ponte a terceiros é uso compartilhado da conta (regra 2.2).
function bridgeHost(env = process.env) {
  return env.BRIDGE_ALLOW_LAN === '1' || inContainer(env) ? '0.0.0.0' : '127.0.0.1';
}

// Defesa contra DNS rebinding: um site qualquer pode apontar o próprio nome para
// 127.0.0.1 e falar com a ponte como se fosse "mesma origem". Esses pedidos chegam
// com Host = nome DNS. Só aceitamos IP literal, localhost ou hosts listados em
// ALLOWED_HOSTS / BRIDGE_PUBLIC_URL / ADDON_PUBLIC_URL (nome próprio, ex.: um NAS).
function hostAllowed(hostHeader, env = process.env) {
  if (!hostHeader) return false;
  const m = /^(\[[0-9a-f:.]+\]|[^:/\s]+)(?::\d{1,5})?$/i.exec(String(hostHeader).trim());
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (name === 'localhost' || name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  const extra = String(env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const key of ['BRIDGE_PUBLIC_URL', 'ADDON_PUBLIC_URL']) {
    try { if (env[key]) extra.push(new URL(env[key]).hostname.toLowerCase()); } catch { /* URL inválida: ignora */ }
  }
  return extra.includes(name);
}

// Interface do painel de login (porta CONFIG_PORT).
function configHost(env = process.env) {
  return inContainer(env) ? '0.0.0.0' : '127.0.0.1';
}

// Devolve um aviso em texto quando o último login explícito está perto do
// limite de 90 dias (ou é desconhecido); null quando não há o que avisar.
function inactivityNotice(lastLoginAt, now = Date.now()) {
  const last = Date.parse(lastLoginAt ?? '');
  if (!Number.isFinite(last)) {
    return 'Data do último login desconhecida: abra o ASC no navegador e entre de novo para evitar banimento por inatividade (regra 2.6, 90 dias).';
  }
  const idleDays = Math.floor((now - last) / DAY_MS);
  if (idleDays >= INACTIVITY_LIMIT_DAYS) {
    return `Último login há ${idleDays} dias: o limite do ASC é ${INACTIVITY_LIMIT_DAYS} (regra 2.6). Entre no site agora.`;
  }
  if (idleDays >= INACTIVITY_WARN_DAYS) {
    return `Último login há ${idleDays} dias: entre no site do ASC antes de completar ${INACTIVITY_LIMIT_DAYS} dias (regra 2.6).`;
  }
  return null;
}

module.exports = {
  isLoopbackAddress,
  isLoopbackRequest,
  bridgeHost,
  configHost,
  hostAllowed,
  inContainer,
  inactivityNotice,
  INACTIVITY_LIMIT_DAYS,
  INACTIVITY_WARN_DAYS,
};
