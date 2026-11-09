// Decide se a administração do painel pela LAN (issue #24) pode ficar ativa e com quais
// endereços. Função pura: sem rede, sem disco. Quem usa: index.js (partida), config-server.js
// e o terminal (npm run admin-painel -- status/ativar).
//
// Fail-closed: qualquer pré-condição faltando = `enabled: false` com a lista de problemas. Isso
// desliga SÓ a administração remota; o painel local e o motor de seed seguem normalmente.
//
// Não há curinga: o Host aceito é exatamente o endereço configurado (IP ou nome) com a porta do
// painel, ou o host da CONFIG_PUBLIC_URL. Cabeçalhos encaminhados (X-Forwarded-*, Forwarded) nunca
// são lidos: o proxy precisa repassar o Host original e a origem pública vem da configuração.

const os = require('os');

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Ok(text) {
  const m = IPV4.exec(String(text ?? ''));
  return Boolean(m) && m.slice(1).every((x) => Number(x) <= 255);
}

function ownsAddress(interfaces, address) {
  return Object.values(interfaces ?? {}).flat().some((i) => i && i.family !== 'IPv6' && i.address === address);
}

// values: valores efetivos da configuração; net: cfg.derived.network (src/network.js).
function plan({ values, mode, container = false, net, credentialConfigured = false, interfaces = null, port }) {
  const requested = values.CONFIG_ALLOW_LAN === true;
  const out = {
    requested, enabled: false, problems: [], transport: null, secureCookie: false,
    bind: [], hosts: [], origins: [], publicHost: null,
    idleMs: values.CONFIG_SESSION_IDLE_MINUTES * 60_000,
    maxMs: values.CONFIG_SESSION_MAX_HOURS * 3_600_000,
  };
  if (!requested) return out;
  const p = out.problems;
  if (container) p.push('não há administração pela LAN no contêiner (a porta do painel é publicada só em 127.0.0.1 do host).');
  if (mode !== 'lan') p.push('exige ASCSTREMIO_MODE=lan.');
  if (!credentialConfigured) p.push('falta a senha de administração (npm run admin-painel -- definir).');

  const advertised = net?.host;
  const explicit = net && (net.hostSource === 'config');
  if (!advertised || !explicit) p.push('exige um endereço anunciado explícito e válido (LAN_ADVERTISE_HOST); o automático pode mudar com o DHCP.');

  const publicUrl = values.CONFIG_PUBLIC_URL;
  if (publicUrl) {
    let u = null;
    try { u = new URL(publicUrl); } catch { /* validado abaixo */ }
    if (!u || u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      p.push('CONFIG_PUBLIC_URL deve ser uma origem https exata, sem caminho (ex.: https://painel.casa.lan).');
    } else {
      out.transport = 'https-proxy';
      out.secureCookie = true;
      out.publicHost = u.host.toLowerCase();
      out.hosts.push(out.publicHost);
      out.origins.push(u.origin);
      out.bind = ['127.0.0.1']; // o proxy roda neste computador; nada de escuta na LAN
      if (values.CONFIG_BIND_ADDRESS) p.push('CONFIG_BIND_ADDRESS não se combina com CONFIG_PUBLIC_URL: com proxy o painel escuta só em 127.0.0.1.');
    }
  } else {
    out.transport = 'http-clear';
    if (values.CONFIG_ADMIN_HTTP_CLEAR !== true) {
      p.push('sem CONFIG_PUBLIC_URL https a senha trafegaria em HTTP sem criptografia; para aceitar esse risco na sua rede, defina CONFIG_ADMIN_HTTP_CLEAR=true.');
    }
    const bindAddr = values.CONFIG_BIND_ADDRESS || (net?.hostKind === 'ipv4' ? advertised : null);
    if (!ipv4Ok(bindAddr) || /^(127\.|0\.)/.test(bindAddr ?? '')) {
      p.push('não há IPv4 de LAN para escutar: defina CONFIG_BIND_ADDRESS com um IPv4 deste computador (nunca 0.0.0.0).');
    } else if (interfaces !== false && !ownsAddress(interfaces ?? safeInterfaces(), bindAddr)) {
      p.push(`${bindAddr} não pertence a nenhuma interface deste computador agora.`);
    } else out.bind = ['127.0.0.1', bindAddr];
    if (advertised) {
      const name = String(advertised).toLowerCase();
      const host = `${name.includes(':') ? `[${name}]` : name}:${port}`;
      out.hosts.push(host);
      out.origins.push(`http://${host}`);
    }
  }
  out.enabled = p.length === 0;
  if (!out.enabled) { out.bind = []; out.hosts = []; out.origins = []; }
  return out;
}

function safeInterfaces() {
  try { return os.networkInterfaces(); } catch { return {}; }
}

module.exports = { plan, ipv4Ok };
