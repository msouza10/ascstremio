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

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

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
      if (family === 6) {
        // A escuta é só IPv4 (0.0.0.0): anunciar IPv6 geraria URLs que ninguém alcança.
        out.push({ ...base, kind: 'ipv6', usable: false, auto: false, reason: 'Excluído: addon e ponte escutam só em IPv4 (0.0.0.0); um endereço IPv6 anunciado não seria alcançável.' });
        continue;
      }
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
      const reason = priv ? 'Rede local.' : 'IPv4 público ou fora das faixas privadas: confira se é mesmo o endereço da LAN.';
      out.push({ ...base, kind: priv ? 'privado' : 'outro', usable: true, auto: true, reason });
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
  if (chosen?.kind === 'ipv6' && lan) {
    problems.push('LAN_ADVERTISE_HOST: IPv6 ainda não é suportado, pois addon e ponte escutam só em IPv4 (0.0.0.0). Use o IPv4 do host ou um nome DNS.');
  }

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
      else { host = null; if (interfaceName in (interfaces ?? {})) fail(`LAN_INTERFACE=${interfaceName} não tem endereço elegível (${byName.map((c) => c.reason).join(' ') || 'sem endereços'}).`); }
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

// ---------------------------------------------------------------------------------------
// Porta de peers BitTorrent (issue #34): diagnóstico em camadas.
//
// Escuta local NÃO é alcance externo. O programa não abre porta no roteador (UPnP/NAT-PMP
// desligados), não pergunta a nenhum serviço de terceiros se a porta está aberta e não
// abre torrent só para testar. O que ele sabe de verdade:
//   1. se o motor está escutando e em qual porta (estado do servidor do WebTorrent);
//   2. no contêiner, só a porta de DENTRO; a publicação (-p) é do hospedeiro;
//   3. firewall/NAT: nada (só orientação);
//   4. se já chegou conexão de ENTRADA de peer desde a partida (contadores, sem endereço).
// Estados: escutando | sem_entrada | entrada_observada | sem_escuta | desconhecido.

const PEER_STATUS_FILE = 'peer-port-status.json';
// Tempo com torrent ativo sem nenhuma entrada antes de falar em "sem entrada observada".
// Peer só tenta entrar quando o tracker passa o nosso endereço a quem baixa; antes disso, a
// ausência de entrada não diz nada.
const PEER_QUIET_MS = 6 * 3600 * 1000;
// O processo em execução regrava o resumo a cada ~1 min; mais velho que isto não vale.
const PEER_STATUS_FRESH_MS = 3 * 60 * 1000;

// Classifica o endereço remoto de uma conexão de entrada, sem guardá-lo.
//   'publico': roteável na internet; 'privado': LAN/CGNAT/link-local/ULA; 'loopback'; 'desconhecido'.
function classifyRemote(address) {
  if (typeof address !== 'string' || !address) return 'desconhecido';
  let a = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const fam = net.isIP(a);
  if (fam === 4) {
    const [x, y] = a.split('.').map(Number);
    if (x === 127) return 'loopback';
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return 'privado';
    if (x === 169 && y === 254) return 'privado';
    if (x === 100 && y >= 64 && y <= 127) return 'privado';
    if (x === 0 || x >= 224) return 'desconhecido';
    return 'publico';
  }
  if (fam === 6) {
    if (a === '::1') return 'loopback';
    if (a === '::') return 'desconhecido';
    const h = firstHextet(a);
    if ((h & 0xfe00) === 0xfc00 || (h & 0xffc0) === 0xfe80) return 'privado';
    if ((h >> 8) === 0xff) return 'desconhecido';
    return 'publico';
  }
  return 'desconhecido';
}

// Observador de conexões de ENTRADA de peers. Guarda só contadores e horários: nenhum
// endereço, porta remota, peerId ou info hash (privacidade; o tracker é privado).
function createPeerObserver({ now = Date.now } = {}) {
  const st = { total: 0, publico: 0, privado: 0, desconhecido: 0, lastAt: null, lastPublicAt: null, startedAt: now(), activeMs: 0 };
  let client = null;
  let lastSample = now();
  let lastActive = false;
  // Soma só os intervalos em que havia torrent ativo (amostrado a cada snapshot, ~1 min).
  const sample = () => {
    const t = now();
    if (lastActive) st.activeMs += Math.max(0, t - lastSample);
    lastSample = t;
    lastActive = Boolean(client?.torrents?.length);
  };
  const seen = new WeakSet();
  const onWire = (wire) => {
    // 'tcpIncoming'/'utpIncoming' = o peer nos procurou; 'tcpOutgoing' = fomos nós (não prova nada).
    if (!wire || typeof wire.type !== 'string' || !wire.type.includes('Incoming')) return;
    const cls = classifyRemote(wire.remoteAddress);
    if (cls === 'loopback') return; // o próprio computador não prova nada
    st.total += 1;
    st[cls] += 1;
    st.lastAt = now();
    if (cls === 'publico') st.lastPublicAt = st.lastAt;
  };
  const watch = (torrent) => {
    if (!torrent || seen.has(torrent) || typeof torrent.on !== 'function') return;
    seen.add(torrent);
    torrent.on('wire', onWire);
  };
  return {
    // Liga ao cliente do motor: pega os torrents existentes e os futuros. Não abre porta nem torrent.
    attach(c) {
      if (!c || typeof c.on !== 'function') return;
      client = c;
      sample();
      for (const t of client.torrents ?? []) watch(t);
      client.on('torrent', watch);
    },
    snapshot: () => { sample(); return { ...st }; },
  };
}

// O que o motor sabe de si, sem abrir nada. Qualquer leitura que falhe vira "desconhecido".
function engineState(client) {
  if (!client) return { known: false };
  try {
    if (client.destroyed) return { known: true, listening: false, destroyed: true, port: null };
    const addr = client.listening && typeof client.address === 'function' ? client.address() : null;
    return {
      known: true, listening: Boolean(client.listening && addr), destroyed: false,
      port: addr?.port ?? null, utp: Boolean(client.utp),
    };
  } catch { return { known: false }; }
}

const fmtTime = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : null);

// Núcleo puro. engine: saída de engineState (ou { known:false }); observed: snapshot do observador
// (ou null); configuredPort: TORRENT_PORT (0 = escolhida pelo sistema).
function evaluatePeerPort({ engine = { known: false }, observed = null, configuredPort = 0, container = false, now = Date.now() } = {}) {
  const notes = [];
  const advice = [];
  const listening = Boolean(engine.known && engine.listening);
  const port = listening ? engine.port : null;
  const evidence = observed ? (container ? observed.publico + observed.privado : observed.publico) : 0;
  const localOnly = observed && !container ? observed.privado : 0;
  const observedMs = observed?.activeMs ?? 0;

  let state;
  if (!engine.known) state = 'desconhecido';
  else if (!listening) state = 'sem_escuta';
  else if (evidence > 0) state = 'entrada_observada';
  else if (observedMs >= PEER_QUIET_MS) state = 'sem_entrada';
  else state = 'escutando';

  const summary = {
    desconhecido: 'Desconhecido: não há leitura do estado do motor de torrents (o aplicativo não está em execução ou não respondeu).',
    sem_escuta: engine.destroyed
      ? 'O motor de torrents parou (por exemplo, porta de peers ocupada por outro programa). Veja o log e reinicie o aplicativo.'
      : 'O motor ainda não está escutando a porta de peers.',
    escutando: `O motor escuta a porta ${port} neste computador. Isso não prova que ela seja alcançável de fora: nenhuma conexão de entrada foi observada ainda (pode ser só falta de tempo ou de torrent ativo).`,
    sem_entrada: `O motor escuta a porta ${port}, mas nenhuma conexão de entrada de peer foi observada desde a partida. Isso é compatível com firewall, NAT/CGNAT ou simplesmente com ninguém ter tentado entrar; não prova bloqueio.`,
    entrada_observada: `Já entrou ao menos uma conexão de peer pela porta ${port} desde a partida${container ? ' (no contêiner, o Docker pode mascarar o endereço de origem)' : ', vinda de endereço público'}. É evidência prática de alcance, não garantia para todos os peers.`,
  }[state];

  if (listening && configuredPort === 0) {
    notes.push('TORRENT_PORT=0: o sistema escolhe uma porta nova a cada partida, então não dá para liberá-la no firewall nem publicá-la no contêiner. Fixe uma porta (a imagem usa 7030).');
  }
  if (listening && configuredPort && port && configuredPort !== port) {
    notes.push(`Configurada ${configuredPort}, mas o motor escuta ${port}: a configuração salva ainda não foi aplicada (reinicie) ou o ambiente a sobrescreve.`);
  }
  if (localOnly > 0) {
    notes.push(`${localOnly} entrada(s) vieram de endereço da rede local ou privado: não provam alcance pela internet.`);
  }
  if (container) {
    notes.push('Contêiner: o programa só vê a porta de dentro. Se ela foi publicada no hospedeiro (-p), não dá para saber daqui; confira com `docker port` ou o docker-compose.yml. A porta de fora tem de ser igual à de dentro, pois é a de dentro que vai ao tracker.');
  }
  if (state !== 'desconhecido') {
    notes.push('Firewall e NAT: o programa não os consulta nem os altera (UPnP/NAT-PMP desligados) e não pergunta a serviço de terceiros. Atrás de CGNAT (IP do roteador na faixa 100.64.0.0/10, ou diferente do que um site de "meu IP" mostra) não há como receber conexões de entrada sem ajuda do provedor. IPv6 tem regras de firewall próprias no roteador.');
    notes.push('Não receber conexões de entrada não impede todo upload: peers para os quais o programa se conecta também recebem dados, e o seed continua valendo para o tracker.');
    advice.push(`Se quiser receber conexões de entrada: libere somente a porta de peers${port ? ` (${port}/TCP)` : ''} no firewall do computador e encaminhe-a no roteador para este computador. Nunca abra as portas do addon, da ponte ou do painel para a internet.`);
    advice.push(`Para conferir de fora, por sua conta, a partir de outra rede (por exemplo, o celular no 4G): \`nc -vz <seu IP público> ${port ?? '<porta>'}\` ou o verificador de portas que você escolher. O programa não faz isso por você. Não informe passkey, hashes nem títulos a nenhum serviço.`);
  }

  return {
    state, summary, notes, advice,
    layers: {
      escuta: {
        configurada: configuredPort,
        real: port,
        protocolo: engine.utp ? 'TCP e uTP (UDP) na mesma porta' : 'TCP',
        estado: !engine.known ? 'desconhecido' : (listening ? 'escutando' : 'sem_escuta'),
      },
      publicacao: {
        modo: container ? 'contêiner' : 'nativo',
        verificavel: false,
        nota: container ? 'Não verificável de dentro do contêiner.' : 'Não se aplica (execução nativa).',
      },
      firewallNat: { estado: 'desconhecido', nota: 'Não verificado: o programa não consulta nem altera firewall, roteador ou NAT.' },
      entrada: {
        observada: evidence,
        deRedeLocal: localOnly,
        total: observed?.total ?? 0,
        ultima: fmtTime(observed?.lastAt),
        ultimaPublica: container ? null : fmtTime(observed?.lastPublicAt),
        desde: fmtTime(observed?.startedAt),
      },
    },
  };
}

// Resumo gravado pelo processo em execução para a CLI (`npm run rede`) ler. Só contadores e
// o estado do motor; nenhum endereço de peer. Fica em DATA_DIR (0600) e é regravado a cada ~1 min.
function writePeerStatus(dataDir, { engine, observed }, now = Date.now()) {
  const file = path.join(dataDir, PEER_STATUS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, pid: process.pid, updatedAt: now, engine, observed }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nada a limpar */ }
    return false;
  }
}

// Devolve { engine, observed } só se o resumo for recente e legível; senão o motor fica "desconhecido".
function readPeerStatus(dataDir, now = Date.now()) {
  const none = { engine: { known: false }, observed: null, stale: true };
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, PEER_STATUS_FILE), 'utf8'));
    if (doc?.version !== 1 || !Number.isFinite(doc.updatedAt) || now - doc.updatedAt > PEER_STATUS_FRESH_MS || doc.updatedAt > now + 60000) return none;
    return { engine: doc.engine ?? { known: false }, observed: doc.observed ?? null, stale: false };
  } catch { return none; }
}

module.exports = {
  listCandidates, parseHost, parseInterfaceName, evaluate, staleWarning, urlHost, systemInterfaces,
  classifyRemote, createPeerObserver, engineState, evaluatePeerPort, writePeerStatus, readPeerStatus,
  PEER_STATUS_FILE, PEER_QUIET_MS, PEER_STATUS_FRESH_MS,
};
