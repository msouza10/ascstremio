// Endereço anunciado aos clientes da LAN (issue #21).
//
// Três coisas diferentes, que este módulo mantém separadas:
//   1. BIND: em que interface addon e ponte escutam (settings: derived.bindHost);
//   2. ENDEREÇO ANUNCIADO: o que entra nas URLs que o Stremio de OUTRO aparelho vai usar
//      (aqui: LAN_ADVERTISE_HOST, LAN_INTERFACE, BRIDGE_PUBLIC_URL, ADDON_PUBLIC_URL);
//   3. HOSTS ACEITOS: o que o cabeçalho Host pode ser (safety.hostAllowed, anti DNS rebinding).
//
// Tudo é função pura sobre uma lista de interfaces injetada (os.networkInterfaces simulado
// nos testes). Validar que o endereço pertence a uma interface local NÃO prova que a TV
// chega até ele (roteador, firewall, isolamento de Wi-Fi): o alcance pelo cliente é sempre
// 'desconhecido'. Não há teste de URL arbitrária (evita SSRF).

const net = require('net');
const os = require('os');

// Interfaces que existem só dentro do host (contêiner, VM, WSL): o endereço delas não é
// alcançável pelos outros aparelhos da rede doméstica.
const VIRTUAL_RE = /(docker|^br-[0-9a-f]|^veth|virbr|vboxnet|virtualbox|vmnet|vmware|lxcbr|lxdbr|^cni|flannel|^cali|^kube|podman|weave|vethernet|hyper-v|vpnkit|^wsl)/i;
// VPN/overlay: só alcança quem está na mesma VPN. Pode ser o desejado, mas só por escolha explícita.
const VPN_RE = /(tailscale|wireguard|zerotier|openvpn|nordlynx|proton|ipsec|vpn|^wg\d|^tun\d|^tap\d|^utun|^ppp\d|^zt)/i;

const MAX_IFNAME = 64;

function firstHextet(ipv6) {
  return parseInt(ipv6.split(':')[0] || '0', 16);
}

// Faixas que nunca servem de endereço para outro aparelho. Devolve o motivo ou null.
function unusableReason(address, family) {
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 127) return 'loopback (só este computador)';
    if (a === 0) return 'endereço não especificado';
    if (a === 169 && b === 254) return 'link-local (sem DHCP; só o mesmo segmento)';
    if (a >= 224) return 'multicast/reservado';
    return null;
  }
  const h = address.toLowerCase();
  if (h === '::1') return 'loopback (só este computador)';
  if (h === '::') return 'endereço não especificado';
  if ((firstHextet(h) & 0xffc0) === 0xfe80) return 'link-local (exige escopo de interface; não serve em URL)';
  if ((firstHextet(h) >> 8) === 0xff) return 'multicast';
  if (h.startsWith('::ffff:')) return 'IPv4 mapeado em IPv6 (use o endereço IPv4)';
  return null;
}

const inCgnat = (address) => {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

function familyOf(net_) {
  return net_.family === 4 || net_.family === 'IPv4' ? 4 : 6;
}

// Interfaces do sistema sem quebrar quando o ambiente restringe a consulta (sandbox).
function systemInterfaces() {
  try { return os.networkInterfaces(); } catch { return {}; }
}

// Lista candidatos com a classificação e a justificativa. Nunca inclui MAC.
//   usable: pode ser escolhido como endereço anunciado;
//   auto:   elegível para escolha automática (VPN só por seleção explícita).
function listCandidates(interfaces = systemInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const addr of list ?? []) {
      if (!addr?.address) continue;
      const family = familyOf(addr);
      const address = String(addr.address);
      const base = { interface: name, address, family: family === 4 ? 'IPv4' : 'IPv6' };
      const bad = addr.internal ? 'loopback (só este computador)' : unusableReason(address, family);
      if (bad) { out.push({ ...base, kind: 'excluido', usable: false, auto: false, reason: `Excluído: ${bad}.` }); continue; }
      if (VIRTUAL_RE.test(name)) {
        out.push({ ...base, kind: 'virtual', usable: false, auto: false, reason: 'Excluído: interface virtual (contêiner/VM/WSL); os outros aparelhos da LAN não a alcançam.' });
        continue;
      }
      if (VPN_RE.test(name) || (family === 4 && inCgnat(address))) {
        out.push({ ...base, kind: 'vpn', usable: true, auto: false, reason: 'VPN/overlay (ou faixa 100.64.0.0/10): só alcança aparelhos na mesma VPN. Use só se for o desejado, escolhendo-a explicitamente.' });
        continue;
      }
      const ula = family === 6 && (firstHextet(address) & 0xfe00) === 0xfc00;
      const priv = family === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
      let reason = 'Rede local.';
      if (family === 6 && !ula) reason = 'IPv6 global: pode mudar (extensões de privacidade/prefixo do provedor); prefira um nome estável.';
      else if (family === 4 && !priv) reason = 'IPv4 público ou fora das faixas privadas: confira se é mesmo o endereço da LAN.';
      out.push({ ...base, kind: ula ? 'ula' : priv ? 'privado' : 'outro', usable: true, auto: true, reason });
    }
  }
  return out;
}

// IPv6 com colchetes para formar URL.
const urlHost = (host) => (host.includes(':') ? `[${host}]` : host);

function hostLabelsOk(name) {
  return name.length <= 253
    && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(name);
}

// Sintaxe do endereço escolhido: IPv4, IPv6 ou nome DNS, sem esquema, porta, caminho ou curinga.
// Devolve { host, kind } (host normalizado, IPv6 sem colchetes) ou { error }.
function parseHost(text) {
  if (typeof text !== 'string') return { error: 'deve ser texto.' };
  let t = text.trim().toLowerCase();
  if (!t) return { error: 'não pode ser vazio.' };
  if (/[\s\u0000-\u001f]/.test(t)) return { error: 'não pode ter espaços.' };
  if (t.includes('://')) return { error: 'informe só o endereço, sem http:// ou https://.' };
  if (/[/?#@]/.test(t)) return { error: 'informe só o endereço, sem caminho, query ou usuário.' };
  if (t.includes('*')) return { error: 'curinga não é aceito.' };
  const bracketed = /^\[(.*)\]$/.exec(t);
  if (bracketed) t = bracketed[1];
  if (t.includes('%')) return { error: 'IPv6 com escopo de interface (%) não serve em URL.' };
  const fam = net.isIP(t);
  if (fam === 0 && /^[^:]+:\d+$/.test(t)) return { error: 'informe só o endereço, sem porta (as portas vêm de PORT e BRIDGE_PORT).' };
  if (fam === 4 || fam === 6) {
    let host = t;
    if (fam === 6) {
      try { host = new URL(`http://[${t}]`).hostname.slice(1, -1); } catch { return { error: 'IPv6 inválido.' }; }
    }
    const bad = unusableReason(host, fam);
    if (bad) return { error: `${host} não serve para outros aparelhos: ${bad}.` };
    return { host, kind: fam === 4 ? 'ipv4' : 'ipv6' };
  }
  if (t.includes(':')) return { error: 'IPv6 inválido.' };
  if (t === 'localhost' || t.endsWith('.localhost')) return { error: 'localhost só aponta para o próprio aparelho.' };
  if (!hostLabelsOk(t)) return { error: 'não é um nome DNS válido.' };
  if (/^[0-9.]+$/.test(t) || /^\d+$/.test(t.split('.').pop())) return { error: 'não é um IPv4 nem um nome DNS válido.' };
  return { host: t, kind: 'dns' };
}

// Nome de interface: texto livre curto (Windows tem espaços e parênteses).
function parseInterfaceName(text) {
  if (typeof text !== 'string') return { error: 'deve ser texto.' };
  const t = text.trim();
  if (!t || t.length > MAX_IFNAME || /[\u0000-\u001f\u007f]/.test(t)) return { error: `deve ter de 1 a ${MAX_IFNAME} caracteres, sem controle.` };
  return { name: t };
}

const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();

function describe(c) { return `${c.address} (${c.interface})`; }

// Núcleo: decide o endereço anunciado e produz problemas/avisos.
//   mode, container: vindos de settings; ports: { addon, bridge };
//   advertiseHost/interfaceName: LAN_ADVERTISE_HOST/LAN_INTERFACE (já validados na sintaxe);
//   bridgeUrl/addonUrl: BRIDGE_PUBLIC_URL/ADDON_PUBLIC_URL;
//   strict: endereço escolhido que não pertence ao host vira problema (ao salvar), em vez de
//   aviso (na partida: DHCP/Wi-Fi podem demorar e isso não pode impedir a retomada do seed).
function evaluate({
  mode = 'local', container = false, ports, advertiseHost = null, interfaceName = null,
  bridgeUrl = null, addonUrl = null, interfaces = systemInterfaces(), strict = false,
} = {}) {
  const problems = [];
  const warnings = [];
  const lan = mode === 'lan';
  const info = [];
  const bind = container || lan ? '0.0.0.0' : '127.0.0.1';
  let host = '127.0.0.1';
  let hostSource = 'loopback';
  let hostKind = 'ipv4';
  let ambiguous = false;
  let candidates = [];
  const fail = (msg) => (strict ? problems : warnings).push(msg);

  const chosen = advertiseHost ? parseHost(advertiseHost) : null;
  if (chosen?.error) problems.push(`LAN_ADVERTISE_HOST: ${chosen.error}`);

  if (!lan) {
    // Local: escuta só em loopback (ou, no contêiner, porta publicada no 127.0.0.1 do host).
    if (chosen?.host && !chosen.error) {
      warnings.push(`LAN_ADVERTISE_HOST=${chosen.host} não tem efeito no modo local: addon e ponte só são alcançáveis em 127.0.0.1. Use ASCSTREMIO_MODE=lan para atender outros aparelhos.`);
    }
    if (interfaceName) warnings.push('LAN_INTERFACE só vale no modo LAN; ignorada no modo local.');
  } else if (container) {
    // No contêiner as interfaces vistas são as internas: nada a conferir nem a adivinhar.
    if (chosen?.host) { host = chosen.host; hostSource = 'config'; hostKind = chosen.kind; }
    else host = null;
    if (interfaceName) warnings.push('LAN_INTERFACE é ignorada em contêiner: ele só enxerga a interface interna. Informe LAN_ADVERTISE_HOST (ou as URLs públicas) com o endereço do host.');
    if (chosen?.host) info.push('Contêiner: confirme que as portas do addon e da ponte estão publicadas no host com os mesmos números (docker-compose.yml publica só em 127.0.0.1 por padrão).');
    const missing = [['BRIDGE_PUBLIC_URL', bridgeUrl], ['ADDON_PUBLIC_URL', addonUrl]].filter(([, u]) => !u).map(([k]) => k);
    if (!chosen?.host) for (const k of missing) problems.push(`Modo LAN em contêiner exige ${k} ou LAN_ADVERTISE_HOST: o IP interno do contêiner não serve aos outros aparelhos.`);
  } else {
    candidates = listCandidates(interfaces);
    const byName = candidates.filter((c) => c.interface === interfaceName);
    if (interfaceName && interfaces && !(interfaceName in interfaces)) {
      warnings.push(`LAN_INTERFACE=${interfaceName} não existe neste computador agora (desconectada ou renomeada). Interfaces vistas: ${[...new Set(candidates.map((c) => c.interface))].join(', ') || 'nenhuma'}.`);
    }
    if (chosen?.host) {
      host = chosen.host; hostSource = 'config'; hostKind = chosen.kind;
      if (chosen.kind === 'dns') {
        info.push(`${host} é um nome: o programa não consegue verificar se ele resolve para este computador nem se os aparelhos o resolvem. Prefira DNS local do roteador ou reserva DHCP; mDNS (.local) não funciona em todo aparelho.`);
      } else {
        const own = candidates.filter((c) => sameAddress(c.address, host));
        if (own.length === 0) {
          fail(`LAN_ADVERTISE_HOST=${host} não pertence a nenhuma interface deste computador (mudou de IP? DHCP sem reserva?). Os aparelhos não chegarão. Interfaces: ${candidates.filter((c) => c.usable).map(describe).join(', ') || 'nenhuma elegível'}.`);
        } else {
          const c = own[0];
          if (c.kind === 'virtual') warnings.push(`${host} pertence à interface virtual ${c.interface}: os outros aparelhos da LAN normalmente não a alcançam.`);
          if (c.kind === 'vpn') warnings.push(`${host} pertence à interface de VPN ${c.interface}: só alcança aparelhos na mesma VPN.`);
          if (interfaceName && !own.some((x) => x.interface === interfaceName) && (interfaceName in (interfaces ?? {}))) {
            problems.push(`LAN_ADVERTISE_HOST=${host} e LAN_INTERFACE=${interfaceName} se contradizem: o endereço está em ${c.interface}.`);
          }
        }
      }
    } else if (interfaceName) {
      const ok = byName.filter((c) => c.usable).sort((a, b) => (a.family === 'IPv4' ? 0 : 1) - (b.family === 'IPv4' ? 0 : 1));
      if (ok.length) { host = ok[0].address; hostSource = 'interface'; hostKind = ok[0].family === 'IPv4' ? 'ipv4' : 'ipv6'; }
      else { host = null; if (interfaceName in (interfaces ?? {})) problems.push(`LAN_INTERFACE=${interfaceName} não tem endereço elegível (${byName.map((c) => c.reason).join(' ') || 'sem endereços'}).`); }
    } else {
      // Sem escolha explícita: só automático entre redes locais comuns. Várias interfaces =
      // ambiguidade avisada em voz alta (não é escolha silenciosa); a partida não é bloqueada
      // para não impedir a retomada do seed, mas a instalação não deve ficar assim.
      const auto = candidates.filter((c) => c.auto).sort((a, b) => (a.family === 'IPv4' ? 0 : 1) - (b.family === 'IPv4' ? 0 : 1));
      const ifaces = new Set(auto.map((c) => c.interface));
      const v4 = auto.filter((c) => c.family === 'IPv4');
      if (auto.length === 0) {
        host = null;
        warnings.push(`Modo LAN sem interface elegível: ${candidates.length ? 'todas foram excluídas (veja `rede`)' : 'nenhuma interface encontrada'}. Conecte-se à rede ou defina LAN_ADVERTISE_HOST.`);
      } else {
        host = auto[0].address; hostSource = 'auto'; hostKind = auto[0].family === 'IPv4' ? 'ipv4' : 'ipv6';
        if (ifaces.size > 1 || v4.length > 1) {
          ambiguous = true;
          warnings.push(`Várias interfaces candidatas (${auto.map(describe).join(', ')}): usando ${describe(auto[0])} só por ser a primeira. Defina LAN_ADVERTISE_HOST (ou LAN_INTERFACE) para escolher de propósito.`);
        } else info.push(`Endereço escolhido automaticamente: ${describe(auto[0])}. Para que não mude com o DHCP, reserve o IP no roteador ou use um nome em LAN_ADVERTISE_HOST.`);
      }
    }
  }

  const base = (port, explicit) => (explicit || (host ? `http://${urlHost(host)}:${port}` : null));
  const urls = {
    addon: base(ports?.addon, addonUrl),
    bridge: base(ports?.bridge, bridgeUrl),
  };
  const sources = {
    addon: addonUrl ? 'url' : (host ? hostSource : 'indisponivel'),
    bridge: bridgeUrl ? 'url' : (host ? hostSource : 'indisponivel'),
  };
  if (lan && !container && (!urls.addon || !urls.bridge)) {
    // Sem endereço, as URLs viriam como loopback e enganariam o cliente: fica explícito.
    warnings.push('Sem endereço anunciado utilizável: as fontes mostrariam um endereço que os outros aparelhos não alcançam.');
  }
  // Alcance: nunca 'ok' por checagem local.
  const loopbackOnly = bind === '127.0.0.1';
  for (const [name, url] of [['addon', urls.addon], ['ponte', urls.bridge]]) {
    if (!loopbackOnly || !url) continue;
    try {
      const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
      if (!['localhost', '::1'].includes(h) && !/^127\./.test(h)) {
        warnings.push(`O endereço anunciado do ${name} (${h}) não é loopback, mas no modo local a escuta é só em 127.0.0.1: outros aparelhos não chegarão.`);
      }
    } catch { /* URL já recusada pela validação do esquema */ }
  }
  return {
    mode, container, bind, host, hostKind, hostSource, ambiguous, urls, sources, candidates,
    problems, warnings, info, clientReachability: 'unknown',
  };
}

// Revalidação em execução: o endereço anunciado ainda pertence a este computador? Devolve
// um aviso (texto) ou null. Não muda nenhuma URL já anunciada nem presume o que o Stremio
// guardou no cliente.
function staleWarning(plan, interfaces = systemInterfaces()) {
  if (!plan || plan.container || plan.mode !== 'lan' || !plan.host || plan.hostKind === 'dns') return null;
  if (plan.hostSource === 'config' || plan.hostSource === 'auto' || plan.hostSource === 'interface') {
    const still = listCandidates(interfaces).some((c) => sameAddress(c.address, plan.host));
    if (!still) {
      return `O endereço anunciado ${plan.host} não está mais neste computador (interface caiu ou o IP mudou). Os aparelhos podem não alcançar o addon; reinstale o addon no Stremio com o endereço novo depois de ajustar LAN_ADVERTISE_HOST. Seed e dados não foram alterados.`;
    }
  }
  return null;
}

module.exports = { listCandidates, parseHost, parseInterfaceName, evaluate, staleWarning, urlHost, systemInterfaces };
