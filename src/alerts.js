// Alertas operacionais por webhook (issue #31). Desligado por padrão; um destino HTTP genérico
// escolhido pelo operador (ex.: um tópico do ntfy). Nada aqui interrompe seed, reprodução ou
// conciliação: a entrega é assíncrona, com timeout, fila limitada e erros engolidos.
//
// Modelo de ameaça (veja docs/seguranca.md):
//   - A URL do destino é SEGREDO (costuma carregar um token no caminho). Vem do ambiente
//     (ALERT_WEBHOOK_URL / ALERT_WEBHOOK_URL_FILE) ou de DATA_DIR/alert-webhook.json (0600). Nunca
//     vai ao settings.json, a logs, ao painel, à CLI ou a respostas; erros viram códigos fixos.
//   - SSRF: só http/https, sem usuário/fragmento, host na lista ALERT_WEBHOOK_ALLOWED_HOSTS,
//     loopback/link-local/metadata/multicast/reservado sempre recusados, rede privada só com
//     ALERT_WEBHOOK_ALLOW_PRIVATE, http só para rede privada. O endereço é validado no momento da
//     conexão (lookup próprio, sem janela para DNS rebinding), sem redirecionamentos, sem cookies,
//     sem proxy do ambiente, com timeout e leitura de resposta limitada.
//   - Exfiltração: o conteúdo é um texto fixo em português mais um contador. Nunca há título,
//     infoHash, ratio, caminho, passkey, cookie, credencial ou URL (lista de campos em CAMPOS_JSON).

const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

const DEST_FILE = 'alert-webhook.json';
const STATE_FILE = 'alerts-state.json';
const MAX_URL = 2048;
const MAX_BEARER = 512;
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 4096;
const MAX_QUEUE = 100;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000]; // tentativa inicial + no máximo 3 retentativas
const RETRY_AFTER_CAP_MS = 15 * 60_000;
const TEST_INTERVAL_MS = 60_000;
const OBSERVE_INTERVAL_MS = 60_000;
const DISK_HYSTERESIS_BYTES = 1024 ** 3;

// Único conjunto de campos enviados em format=json. Qualquer outro é bug (há teste para isso).
const CAMPOS_JSON = Object.freeze(['schemaVersion', 'eventId', 'type', 'severity', 'state', 'occurredAt', 'message', 'count']);

const TYPES = Object.freeze(['hnr_deadline', 'disk_low', 'account_inactivity', 'tracker_unavailable', 'download_no_peers']);
const PRIORITY = { hnr_deadline: 0, disk_low: 1, account_inactivity: 2, tracker_unavailable: 3, download_no_peers: 4, test: 5 };

// Textos fixos: só o contador (número) varia.
const plural = (n, um, varios) => (n === 1 ? um : varios);
const MESSAGES = {
  hnr_deadline: {
    open: (c) => `${c} ${plural(c, 'obrigação de seed está', 'obrigações de seed estão')} perto do prazo ou vencida${c === 1 ? '' : 's'}. Abra o painel.`,
    resolved: () => 'As obrigações de seed que estavam perto do prazo foram resolvidas.',
  },
  disk_low: {
    open: () => 'O espaço livre em disco está abaixo do patamar de aviso.',
    resolved: () => 'O espaço livre em disco voltou ao normal.',
  },
  account_inactivity: {
    open: () => 'A conta está perto do limite de inatividade do tracker (regra 2.6). Entre no site do ASC.',
    resolved: () => 'A conta voltou a ficar em dia quanto à inatividade.',
  },
  tracker_unavailable: {
    open: (c, cfg) => `Não foi possível consultar o tracker há mais de ${cfg.trackerMinutes} min.`,
    resolved: () => 'A consulta ao tracker voltou a funcionar.',
  },
  download_no_peers: {
    open: (c, cfg) => `${c} ${plural(c, 'download está', 'downloads estão')} sem peers nem progresso há mais de ${cfg.noPeersMinutes} min.`,
    resolved: () => 'Os downloads voltaram a ter peers ou progresso.',
  },
};
const TEST_MESSAGE = 'Mensagem de teste do ascstremio. Se você a recebeu, o destino de alertas funciona.';

// Texto fixo e seguro para cada código de erro (nunca a mensagem do Node, que pode ter a URL).
const ERROR_TEXT = {
  blocked: 'destino não permitido pela política de rede',
  dns: 'o nome do destino não foi resolvido',
  refused: 'conexão recusada pelo destino',
  timeout: 'tempo esgotado',
  network: 'falha de rede',
  tls: 'falha na verificação TLS',
  redirect: 'o destino respondeu com redirecionamento (não seguido)',
  http_4xx: 'o destino rejeitou a mensagem',
  http_5xx: 'o destino respondeu com erro',
  http_retry: 'o destino pediu para tentar mais tarde',
  config: 'configuração do destino inválida',
};

class AlertSendError extends Error {
  constructor(code, { retryable = false, retryAfterMs = null, status = null } = {}) {
    super(ERROR_TEXT[code] ?? 'falha na entrega');
    this.name = 'AlertSendError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

function describeError(err) {
  if (!(err instanceof AlertSendError)) return 'falha na entrega';
  return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
}

// --------------------------------------------------------------------------- endereços
function parseV4(text) {
  const p = text.split('.');
  if (p.length !== 4) return null;
  const out = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return out.some((n) => !(n >= 0 && n <= 255)) ? null : out;
}

function parseV6(text) {
  let s = String(text).replace(/^\[|\]$/g, '').split('%')[0];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const v4 = parseV4(dotted[1]);
    if (!v4) return null;
    s = `${s.slice(0, -dotted[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > (halves.length === 2 ? 7 : 8)) return null;
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}

function classifyV4([a, b, c]) {
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'linklocal'; // inclui 169.254.169.254 (metadata de nuvem)
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  if (a >= 224) return a >= 240 ? 'reserved' : 'multicast';
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'reserved';
  return 'public';
}

// 'loopback' | 'linklocal' | 'unspecified' | 'metadata' | 'multicast' | 'reserved' | 'private' | 'public' | 'invalid'
function classifyAddress(address) {
  const text = String(address ?? '');
  const family = net.isIP(text.replace(/^\[|\]$/g, '').split('%')[0]);
  if (family === 4) return classifyV4(parseV4(text));
  if (family !== 6) return 'invalid';
  const b = parseV6(text);
  if (!b) return 'invalid';
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 15) && b[15] === 1) return 'loopback';
  if (zero(0, 16)) return 'unspecified';
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return classifyV4(b.slice(12)); // ::ffff:a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return classifyV4(b.slice(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)); // 6to4
  if (zero(0, 12)) return 'reserved'; // compatível com IPv4 (obsoleto)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'linklocal';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return 'reserved'; // site-local obsoleto
  if (b[0] === 0xff) return 'multicast';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved'; // documentação
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2 && zero(4, 14) && b[14] === 0x02 && b[15] === 0x54) return 'metadata'; // AWS
  if ((b[0] & 0xfe) === 0xfc) return 'private';
  return 'public';
}

// Política por endereço: null = permitido; senão o código do motivo.
function addressVerdict(address, { scheme, allowPrivate = false, unsafeAllowLoopback = false } = {}) {
  const cls = classifyAddress(address);
  if (cls === 'loopback' && unsafeAllowLoopback) return null; // só para testes; nenhuma configuração chega aqui
  if (cls === 'private') return allowPrivate ? null : 'private';
  if (cls === 'public') return scheme === 'http:' ? 'http_public' : null;
  return cls;
}

function localAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces() ?? {})) for (const i of list ?? []) out.add(String(i.address).toLowerCase());
  return out;
}

// --------------------------------------------------------------------------- validação estática
// Não acessa a rede. Devolve { ok, url } ou { ok:false, error } com mensagem segura (sem a URL).
function parseDestination(raw, { allowedHosts = [], allowPrivate = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'Informe a URL do destino.' };
  const text = raw.trim();
  if (text.length > MAX_URL || /[\u0000- \u007f]/.test(text)) return { ok: false, error: 'URL inválida (tamanho ou caracteres de controle).' };
  let url;
  try { url = new URL(text); } catch { return { ok: false, error: 'URL inválida.' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Use uma URL http:// ou https://.' };
  if (url.username || url.password) return { ok: false, error: 'A URL não pode ter usuário ou senha (use o token do destino no caminho ou o bearer).' };
  if (url.hash) return { ok: false, error: 'A URL não pode ter fragmento (#).' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, error: 'URL sem host.' };
  if (host.startsWith('[')) return { ok: false, error: 'Endereço IPv6 literal não é aceito; use um nome DNS ou IPv4.' };
  const allowed = (allowedHosts ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(host)) return { ok: false, error: 'O host do destino não está em ALERT_WEBHOOK_ALLOWED_HOSTS. Inclua o nome exato ali antes de usar este destino.' };
  if (net.isIP(host)) {
    const why = addressVerdict(host, { scheme: url.protocol, allowPrivate });
    if (why) return { ok: false, error: verdictText(why) };
  } else if (url.protocol === 'http:' && !allowPrivate) {
    return { ok: false, error: 'http:// só é aceito para rede privada e exige ALERT_WEBHOOK_ALLOW_PRIVATE=true; use https://.' };
  }
  return { ok: true, url, host };
}

function verdictText(why) {
  return {
    loopback: 'Destino em loopback (esta máquina) não é permitido.',
    linklocal: 'Destino link-local/metadata não é permitido.',
    unspecified: 'Endereço 0.0.0.0/:: não é permitido.',
    metadata: 'Endereço de metadata de nuvem não é permitido.',
    multicast: 'Endereço multicast/reservado não é permitido.',
    reserved: 'Endereço reservado não é permitido.',
    private: 'Destino em rede privada exige ALERT_WEBHOOK_ALLOW_PRIVATE=true.',
    http_public: 'http:// para endereço público não é permitido; use https://.',
    self: 'Destino aponta para o próprio painel, addon ou ponte.',
    invalid: 'Endereço inválido.',
  }[why] ?? 'Destino não permitido.';
}

// --------------------------------------------------------------------------- transporte
// opts: { lookup, unsafeAllowLoopback (SÓ testes), timeoutMs, localAddresses, ownPorts }
// request: { url (URL), headers, body, allowPrivate }
function createTransport({ lookup = dns.lookup, unsafeAllowLoopback = false, timeoutMs = TIMEOUT_MS, addresses = localAddresses, ownPorts = [] } = {}) {
  return function send({ url, headers, body, allowPrivate = false }) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      const own = new Set(ownPorts.map(Number));
      const verdict = (address) => {
        const why = addressVerdict(address, { scheme: url.protocol, allowPrivate, unsafeAllowLoopback });
        if (why) return why;
        if (own.has(port) && addresses().has(String(address).toLowerCase().replace(/^::ffff:/, ''))) return 'self';
        return null;
      };
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(literal) && verdict(literal)) return reject(new AlertSendError('blocked'));

      let settled = false;
      const agent = new lib.Agent({ keepAlive: false }); // agente próprio: ignora proxy do ambiente
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        agent.destroy();
        fn(value);
      };
      const guardedLookup = (hostname, options, cb) => {
        if (typeof options === 'function') { cb = options; options = {}; }
        lookup(hostname, { ...options, all: true, verbatim: true }, (err, list) => {
          if (err) return cb(err);
          const addrs = Array.isArray(list) ? list : [{ address: list, family: net.isIP(list) }];
          if (!addrs.length) return cb(Object.assign(new Error('sem endereço'), { code: 'ENOTFOUND' }));
          // Todos os endereços precisam passar: um nome que também resolve para loopback é recusado.
          if (addrs.some((a) => verdict(a.address))) return cb(Object.assign(new Error('destino bloqueado'), { code: 'EBLOCKED' }));
          return options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
        });
      };
      const timer = setTimeout(() => { req.destroy(); finish(reject, new AlertSendError('timeout', { retryable: true })); }, timeoutMs);
      const req = lib.request({
        protocol: url.protocol, hostname: literal, port, path: `${url.pathname}${url.search}`, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body), Connection: 'close' },
        agent, lookup: guardedLookup,
      }, (res) => {
        const status = res.statusCode ?? 0;
        const retryAfter = Number(res.headers['retry-after']);
        const retryAfterMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, RETRY_AFTER_CAP_MS) : null;
        let size = 0;
        const done = () => {
          if (status >= 200 && status < 300) return finish(resolve, { status });
          if (status >= 300 && status < 400) return finish(reject, new AlertSendError('redirect', { status }));
          if (status === 408 || status === 429) return finish(reject, new AlertSendError('http_retry', { retryable: true, retryAfterMs, status }));
          if (status >= 500) return finish(reject, new AlertSendError('http_5xx', { retryable: true, retryAfterMs, status }));
          return finish(reject, new AlertSendError('http_4xx', { status }));
        };
        res.on('data', (chunk) => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) { res.destroy(); done(); } });
        res.on('end', done);
        res.on('error', done); // corpo cortado: o status já basta
        res.on('close', done);
      });
      req.on('error', (err) => finish(reject, mapNetworkError(err)));
      req.end(body);
    });
  };
}

function mapNetworkError(err) {
  const code = String(err?.code ?? err?.errors?.[0]?.code ?? '');
  if (code === 'EBLOCKED') return new AlertSendError('blocked');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') return new AlertSendError('dns', { retryable: true });
  if (code === 'ECONNREFUSED') return new AlertSendError('refused', { retryable: true });
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_X509)/.test(code)) return new AlertSendError('tls');
  return new AlertSendError('network', { retryable: true });
}

// --------------------------------------------------------------------------- destino (segredo)
function readSecretFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.trim();
}

// Prioridade: ambiente (URL, depois arquivo apontado) > DATA_DIR/alert-webhook.json.
function loadDestination({ dataDir, env = process.env } = {}) {
  const bearerEnv = String(env.ALERT_WEBHOOK_TOKEN ?? '').trim() || null;
  const fromEnv = String(env.ALERT_WEBHOOK_URL ?? '').trim();
  if (fromEnv) return { source: 'env', url: fromEnv, bearer: bearerEnv };
  const fileEnv = String(env.ALERT_WEBHOOK_URL_FILE ?? '').trim();
  if (fileEnv) {
    try {
      const url = readSecretFile(fileEnv);
      if (url) return { source: 'env-file', url, bearer: bearerEnv };
    } catch { /* arquivo ausente/ilegível: sem destino */ }
    return { source: 'env-file', url: null, bearer: bearerEnv, problem: 'ALERT_WEBHOOK_URL_FILE não pôde ser lido ou está vazio.' };
  }
  if (dataDir) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dataDir, DEST_FILE), 'utf8'));
      if (doc && typeof doc.url === 'string' && doc.url) {
        return { source: 'file', url: doc.url, bearer: typeof doc.bearerToken === 'string' && doc.bearerToken ? doc.bearerToken : bearerEnv };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') return { source: 'file', url: null, bearer: null, problem: 'alert-webhook.json ilegível.' };
    }
  }
  return null;
}

function destinationPresent({ dataDir, env = process.env } = {}) {
  if (String(env.ALERT_WEBHOOK_URL ?? '').trim() || String(env.ALERT_WEBHOOK_URL_FILE ?? '').trim()) return true;
  try { return Boolean(dataDir) && fs.statSync(path.join(dataDir, DEST_FILE)).isFile(); } catch { return false; }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows/volume sem chmod */ }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nada a limpar */ }
    throw err;
  }
}

function saveDestination(dataDir, { url, bearerToken = null }) {
  const doc = { version: 1, url, ...(bearerToken ? { bearerToken } : {}) };
  writeAtomic(path.join(dataDir, DEST_FILE), `${JSON.stringify(doc)}\n`);
}

function clearDestination(dataDir) {
  fs.rmSync(path.join(dataDir, DEST_FILE), { force: true });
}

// Trechos da URL que identificam o destino (caminho, query, segmentos longos): vão para o redator
// de logs além da URL inteira.
function secretsOf(url, bearer) {
  const out = new Set();
  if (url) {
    out.add(url);
    try {
      const u = new URL(url);
      if (u.pathname.length > 1) out.add(u.pathname);
      if (u.search.length > 1) { out.add(u.search); out.add(u.search.slice(1)); }
      for (const seg of u.pathname.split('/')) if (seg.length >= 8) out.add(seg);
      for (const [, v] of u.searchParams) if (v.length >= 8) out.add(v);
    } catch { /* URL inválida: só o texto inteiro */ }
  }
  if (bearer) out.add(bearer);
  return [...out];
}

const fingerprint = (url) => crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16);

// --------------------------------------------------------------------------- configuração
const DEFAULTS = Object.freeze({
  enabled: false, format: 'json', allowedHosts: [], allowPrivate: false,
  hnrWithinHours: 48, diskFreeGiB: 10, trackerMinutes: 15, noPeersMinutes: 15, cooldownMinutes: 60,
});

// Converte os valores do esquema (src/settings.js) no formato interno.
function configFromValues(v = {}) {
  return {
    enabled: v.ALERTS_ENABLED === true,
    format: v.ALERT_WEBHOOK_FORMAT === 'text' ? 'text' : 'json',
    allowedHosts: String(v.ALERT_WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    allowPrivate: v.ALERT_WEBHOOK_ALLOW_PRIVATE === true,
    hnrWithinHours: v.ALERT_HNR_WITHIN_HOURS ?? DEFAULTS.hnrWithinHours,
    diskFreeGiB: v.ALERT_DISK_FREE_GIB ?? DEFAULTS.diskFreeGiB,
    trackerMinutes: v.ALERT_TRACKER_FAILURE_MINUTES ?? DEFAULTS.trackerMinutes,
    noPeersMinutes: v.ALERT_NO_PEERS_MINUTES ?? DEFAULTS.noPeersMinutes,
    cooldownMinutes: v.ALERT_COOLDOWN_MINUTES ?? DEFAULTS.cooldownMinutes,
  };
}

const KEY_TO_FIELD = {
  ALERTS_ENABLED: 'enabled', ALERT_WEBHOOK_FORMAT: 'format', ALERT_WEBHOOK_ALLOWED_HOSTS: 'allowedHosts',
  ALERT_WEBHOOK_ALLOW_PRIVATE: 'allowPrivate', ALERT_HNR_WITHIN_HOURS: 'hnrWithinHours', ALERT_DISK_FREE_GIB: 'diskFreeGiB',
  ALERT_TRACKER_FAILURE_MINUTES: 'trackerMinutes', ALERT_NO_PEERS_MINUTES: 'noPeersMinutes', ALERT_COOLDOWN_MINUTES: 'cooldownMinutes',
};

// --------------------------------------------------------------------------- gerente
// Condições (puras) sobre o snapshot da ponte. Só lê contadores; nada de títulos nem hashes.
function evaluate(snapshot, cfg, { wasOpen = {}, trackerSince = null, noPeersSince = null } = {}) {
  const titles = snapshot?.titles ?? [];
  const out = {};

  // Prazo de seed confirmado pelo tracker. Sem leitura do tracker não há estimativa apresentada como prazo.
  const risky = titles.filter((t) => t.tracker && !t.tracker.satisfied && t.state !== 'done'
    && (t.tracker.hitAndRun || (t.daysLeft !== null && t.daysLeft !== undefined && t.daysLeft * 24 <= cfg.hnrWithinHours)));
  out.hnr_deadline = {
    active: risky.length > 0, count: risky.length,
    severity: risky.some((t) => t.tracker.hitAndRun || t.risk === 'crit') ? 'critical' : 'warning',
  };

  // Disco: desconhecido não alerta (o painel já mostra "livres desconhecidos"). Histerese de 1 GiB.
  const free = snapshot?.summary?.freeBytes;
  const limit = cfg.diskFreeGiB * 1024 ** 3;
  out.disk_low = {
    active: cfg.diskFreeGiB > 0 && Number.isFinite(free) && (wasOpen.disk_low ? free < limit + DISK_HYSTERESIS_BYTES : free < limit),
    severity: 'warning',
  };

  out.account_inactivity = { active: Boolean(snapshot?.notices?.length), severity: 'warning' };

  // Falha explícita do tracker, contada desde a primeira falha sem recuperação.
  out.tracker_unavailable = { active: trackerSince !== null, since: trackerSince, severity: 'warning' };

  // Download em conclusão (aguardando peças) sem peers nem velocidade; seed ocioso não conta.
  const stuck = titles.filter((t) => t.state === 'completing' && t.active && (t.progress ?? 0) < 1 && !t.peers && !t.downSpeed);
  out.download_no_peers = { active: stuck.length > 0, count: stuck.length, since: noPeersSince, severity: 'warning' };
  return out;
}

const SUSTAIN = { // minutos até confirmar (tracker usa a primeira falha); recuperação em ms
  recoverMs: { disk_low: 5 * 60_000, download_no_peers: 5 * 60_000 },
};

class AlertManager {
  constructor({
    dataDir, env = process.env, config = {}, transport = null, now = () => Date.now(), random = Math.random,
    log = null, addSecret = () => {}, timers = true, resolver = dns.lookup, ownPorts = [], addresses = localAddresses,
    unsafeAllowLoopback = false,
  } = {}) {
    this.dataDir = dataDir;
    this.env = env;
    this.cfg = { ...DEFAULTS, ...config };
    this.now = now;
    this.random = random;
    this.log = log ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.addSecret = addSecret;
    this.timers = timers;
    this.transport = transport ?? createTransport({ lookup: resolver, ownPorts, addresses, unsafeAllowLoopback });
    this.queue = [];
    this.sending = false;
    this.timer = null;
    this.dropped = 0;
    this.lastTestAt = 0;
    this.trackerSince = null;
    this.noPeersSince = null;
    this.rt = {}; // por tipo: activeSince, clearSince
    this.st = this.loadState();
    this.registeredSecrets = new Set();
    this.registerSecrets();
  }

  // ---- estado persistente: só marcações de dedupe e o último resultado; nada de segredo.
  statePath() { return this.dataDir ? path.join(this.dataDir, STATE_FILE) : null; }

  loadState() {
    const empty = { version: 1, types: {}, last: { successAt: null, failureAt: null, error: null }, streak: 0 };
    const file = this.statePath();
    if (!file) return empty;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!doc || typeof doc !== 'object' || doc.version !== 1) return empty;
      const types = {};
      for (const t of TYPES) {
        const x = doc.types?.[t];
        if (x && typeof x === 'object') {
          types[t] = {
            notified: x.notified === true,
            lastOpenAt: Number.isFinite(x.lastOpenAt) ? x.lastOpenAt : null,
            lastResolveAt: Number.isFinite(x.lastResolveAt) ? x.lastResolveAt : null,
          };
        }
      }
      const last = doc.last ?? {};
      return {
        version: 1, types, streak: Number.isInteger(doc.streak) && doc.streak >= 0 ? Math.min(doc.streak, 10) : 0,
        last: {
          successAt: Number.isFinite(last.successAt) ? last.successAt : null,
          failureAt: Number.isFinite(last.failureAt) ? last.failureAt : null,
          error: typeof last.error === 'string' ? last.error.slice(0, 200) : null,
        },
      };
    } catch { return empty; }
  }

  saveState() {
    const file = this.statePath();
    if (!file) return;
    try { writeAtomic(file, `${JSON.stringify(this.st)}\n`); } catch (err) {
      this.log.warn(`não foi possível gravar o estado dos alertas: ${err.code ?? 'erro'}`);
    }
  }

  typeState(type) {
    if (!this.st.types[type]) this.st.types[type] = { notified: false, lastOpenAt: null, lastResolveAt: null };
    return this.st.types[type];
  }

  // ---- configuração e destino
  setConfig(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const field = KEY_TO_FIELD[key];
      if (!field) continue;
      this.cfg[field] = field === 'allowedHosts' ? String(value ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : value;
    }
    if (!this.cfg.enabled) { this.queue = []; this.clearTimer(); }
  }

  destination() {
    const dest = loadDestination({ dataDir: this.dataDir, env: this.env });
    if (!dest) return { configured: false, source: 'none', problem: 'Nenhum destino configurado.' };
    if (!dest.url) return { configured: false, source: dest.source, problem: dest.problem ?? 'Destino ilegível.' };
    this.registerSecrets(dest);
    const parsed = parseDestination(dest.url, this.cfg);
    if (!parsed.ok) return { configured: true, valid: false, source: dest.source, problem: parsed.error };
    if (dest.bearer && (dest.bearer.length > MAX_BEARER || /[\r\n\u0000]/.test(dest.bearer))) {
      return { configured: true, valid: false, source: dest.source, problem: 'Token bearer inválido.' };
    }
    return { configured: true, valid: true, source: dest.source, url: parsed.url, host: parsed.host, bearer: dest.bearer, id: fingerprint(dest.url) };
  }

  registerSecrets(dest = loadDestination({ dataDir: this.dataDir, env: this.env })) {
    if (!dest) return;
    for (const s of secretsOf(dest.url, dest.bearer)) {
      if (this.registeredSecrets.has(s)) continue;
      this.registeredSecrets.add(s);
      this.addSecret(s);
    }
  }

  // Motivo pelo qual habilitar não faz sentido agora (null = pode).
  configProblem() {
    if (!this.cfg.allowedHosts.length) return 'Informe ALERT_WEBHOOK_ALLOWED_HOSTS com o host exato do destino antes de habilitar.';
    const d = this.destination();
    if (!d.configured) return 'Configure o destino antes de habilitar os alertas.';
    if (!d.valid) return d.problem;
    return null;
  }

  // ---- observação (chamada a cada minuto pelo processo; nunca lança)
  trackerResult(ok, now = this.now()) {
    if (ok) this.trackerSince = null;
    else if (this.trackerSince === null) this.trackerSince = now;
  }

  async observe(getSnapshot, now = this.now()) {
    try {
      if (!this.cfg.enabled) return;
      const snapshot = getSnapshot();
      this.observeSnapshot(snapshot, now);
      await this.pump(now);
    } catch (err) {
      this.log.warn(`falha ao avaliar alertas: ${err?.code ?? 'erro'}`);
    }
  }

  observeSnapshot(snapshot, now = this.now()) {
    const wasOpen = {};
    for (const t of TYPES) wasOpen[t] = Boolean(this.typeState(t).notified);
    // Falha do tracker só conta com o intervalo configurado; o resto vai pelo "since" do próprio tipo.
    const cond = evaluate(snapshot, this.cfg, { wasOpen, trackerSince: this.trackerSince, noPeersSince: null });
    const cooldown = this.cooldownMs();
    for (const type of TYPES) {
      const c = cond[type];
      const s = this.typeState(type);
      const rt = this.rt[type] ?? (this.rt[type] = { activeSince: null, clearSince: null });
      const sustainMs = type === 'tracker_unavailable' ? this.cfg.trackerMinutes * 60_000
        : type === 'download_no_peers' ? this.cfg.noPeersMinutes * 60_000 : 0;
      if (c.active) {
        rt.clearSince = null;
        if (rt.activeSince === null) rt.activeSince = c.since ?? now;
        if (now - rt.activeSince < sustainMs) continue;
        const due = s.lastOpenAt === null || now - s.lastOpenAt >= cooldown;
        if (due && !this.isQueued(type, 'open')) {
          this.enqueue({ type, state: 'open', severity: c.severity, count: c.count });
          s.lastOpenAt = now; // adia a próxima tentativa/lembrete mesmo se a entrega falhar (backoff)
          this.saveState();
        }
      } else {
        rt.activeSince = null;
        if (!s.notified) { rt.clearSince = null; continue; }
        if (rt.clearSince === null) rt.clearSince = now;
        if (now - rt.clearSince < (SUSTAIN.recoverMs[type] ?? 0)) continue;
        const due = s.lastResolveAt === null || now - s.lastResolveAt >= cooldown;
        if (due && !this.isQueued(type, 'resolved')) {
          this.enqueue({ type, state: 'resolved', severity: 'info' });
          s.lastResolveAt = now;
          this.saveState();
        }
      }
    }
  }

  // Intervalo mínimo entre mensagens do mesmo tipo; dobra a cada falha final seguida (até 8x).
  cooldownMs() { return this.cfg.cooldownMinutes * 60_000 * 2 ** Math.min(this.st.streak, 3); }

  isQueued(type, state) { return this.queue.some((i) => i.type === type && i.state === state); }

  // ---- fila
  enqueue({ type, state, severity, count = null }) {
    const dest = this.destination();
    const item = {
      eventId: `evt-${crypto.randomBytes(8).toString('hex')}`, type, state, severity,
      count: Number.isInteger(count) ? count : null, occurredAt: this.now(), attempts: 0, nextAt: this.now(),
      destId: dest.valid ? dest.id : null,
    };
    // Coalesce: um tipo tem no máximo um item pendente (o mais novo vale).
    this.queue = this.queue.filter((i) => i.type !== type);
    if (this.queue.length >= MAX_QUEUE) {
      const rank = (i) => PRIORITY[i.type] + (i.state === 'resolved' ? 10 : 0);
      const worst = this.queue.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      if (rank(worst) <= rank(item)) { this.dropped += 1; this.log.warn('fila de alertas cheia: evento descartado'); return null; }
      this.queue.splice(this.queue.indexOf(worst), 1);
      this.dropped += 1;
      this.log.warn('fila de alertas cheia: evento de menor prioridade descartado');
    }
    this.queue.push(item);
    this.log.info(`alerta enfileirado: ${type} (${state})`);
    return item;
  }

  clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  schedule() {
    this.clearTimer();
    if (!this.timers || !this.queue.length || !this.cfg.enabled) return;
    const next = Math.min(...this.queue.map((i) => i.nextAt));
    this.timer = setTimeout(() => { this.timer = null; this.pump().catch(() => {}); }, Math.max(1000, next - this.now()));
    this.timer.unref?.();
  }

  // Envia, em série, os itens vencidos. Nunca lança.
  async pump(now = this.now()) {
    if (this.sending) return;
    this.sending = true;
    try {
      for (;;) {
        if (!this.cfg.enabled) break;
        const due = this.queue.filter((i) => i.nextAt <= now)
          .sort((a, b) => (PRIORITY[a.type] + (a.state === 'resolved' ? 10 : 0)) - (PRIORITY[b.type] + (b.state === 'resolved' ? 10 : 0)))[0];
        if (!due) break;
        await this.deliver(due, now);
      }
    } catch (err) {
      this.log.warn(`falha no envio de alertas: ${err?.code ?? 'erro'}`);
    } finally {
      this.sending = false;
      this.schedule();
    }
  }

  buildBody(item) {
    const message = item.state === 'test' ? TEST_MESSAGE : MESSAGES[item.type][item.state](item.count ?? 0, this.cfg);
    if (this.cfg.format === 'text') return { body: message, contentType: 'text/plain; charset=utf-8' };
    const doc = {
      schemaVersion: 1, eventId: item.eventId, type: item.type, severity: item.severity, state: item.state,
      occurredAt: new Date(item.occurredAt).toISOString(), message,
    };
    if (item.count !== null) doc.count = item.count;
    return { body: JSON.stringify(doc), contentType: 'application/json; charset=utf-8' };
  }

  // Uma tentativa. Em falha, agenda a retentativa ou encerra (e registra o erro já redigido).
  async attempt(item) {
    const dest = this.destination();
    if (!dest.valid) throw new AlertSendError('config');
    if (item.destId !== dest.id) { const e = new AlertSendError('config'); e.cancelled = true; throw e; } // destino trocado/removido
    const { body, contentType } = this.buildBody(item);
    const headers = { 'Content-Type': contentType, 'User-Agent': 'ascstremio-alertas', Accept: '*/*' };
    if (dest.bearer) headers.Authorization = `Bearer ${dest.bearer}`;
    return this.transport({ url: dest.url, headers, body, allowPrivate: this.cfg.allowPrivate });
  }

  async deliver(item, now) {
    try {
      await this.attempt(item);
    } catch (err) {
      const e = err instanceof AlertSendError ? err : new AlertSendError('network', { retryable: true });
      if (e.cancelled) {
        this.queue = this.queue.filter((i) => i !== item);
        this.log.info(`alerta ${item.type} cancelado: o destino mudou ou foi removido`);
        return;
      }
      item.attempts += 1;
      this.st.last.failureAt = now;
      this.st.last.error = describeError(e);
      if (e.retryable && item.attempts <= RETRY_DELAYS_MS.length) {
        const base = RETRY_DELAYS_MS[item.attempts - 1];
        const jitter = base * (0.8 + this.random() * 0.4);
        item.nextAt = now + Math.max(jitter, e.retryAfterMs ?? 0);
        this.log.warn(`entrega do alerta ${item.type} falhou (${e.code}); nova tentativa em ${Math.round((item.nextAt - now) / 1000)} s`);
      } else {
        this.queue = this.queue.filter((i) => i !== item);
        this.st.streak = Math.min(this.st.streak + 1, 10);
        this.log.warn(`entrega do alerta ${item.type} desistiu (${e.code})`);
      }
      this.saveState();
      return;
    }
    this.queue = this.queue.filter((i) => i !== item);
    const s = this.typeState(item.type);
    if (item.state === 'open') s.notified = true;
    else if (item.state === 'resolved') s.notified = false;
    this.st.last.successAt = now;
    this.st.last.error = null;
    this.st.streak = 0;
    this.saveState();
    this.log.info(`alerta entregue: ${item.type} (${item.state})`);
  }

  // Mensagem sintética ao destino já salvo (sem aceitar URL nem conteúdo). Uma tentativa, 1/min.
  async test(now = this.now()) {
    if (!this.cfg.enabled) return { status: 409, ok: false, error: 'Habilite os alertas antes de testar.' };
    const dest = this.destination();
    if (!dest.valid) return { status: 409, ok: false, error: dest.problem ?? 'Destino incompleto.' };
    const wait = TEST_INTERVAL_MS - (now - this.lastTestAt);
    if (this.lastTestAt && wait > 0) return { status: 429, ok: false, error: 'Aguarde antes de testar de novo.', retryAfter: Math.ceil(wait / 1000) };
    this.lastTestAt = now;
    const item = {
      eventId: `evt-${crypto.randomBytes(8).toString('hex')}`, type: 'test', state: 'test', severity: 'info', count: null,
      occurredAt: now, attempts: 0, nextAt: now, destId: dest.id,
    };
    try {
      await this.attempt(item);
      this.st.last.successAt = now;
      this.st.last.error = null;
      this.saveState();
      this.log.info('alerta de teste entregue');
      return { status: 200, ok: true };
    } catch (err) {
      const e = err instanceof AlertSendError ? err : new AlertSendError('network', { retryable: true });
      this.st.last.failureAt = now;
      this.st.last.error = describeError(e);
      this.saveState();
      this.log.warn(`alerta de teste falhou (${e.code})`);
      return { status: 502, ok: false, error: describeError(e) };
    }
  }

  // Grava o destino (write-only): valida sem rede, registra o segredo e devolve só o estado.
  setDestination({ url, bearerToken = null }) {
    if (loadDestination({ dataDir: this.dataDir, env: this.env })?.source === 'env' || this.env.ALERT_WEBHOOK_URL_FILE) {
      return { ok: false, status: 409, error: 'O destino é definido pelo ambiente (ALERT_WEBHOOK_URL/ALERT_WEBHOOK_URL_FILE); altere lá.' };
    }
    const parsed = parseDestination(url, this.cfg);
    if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };
    if (bearerToken !== null && bearerToken !== undefined && bearerToken !== '') {
      if (typeof bearerToken !== 'string' || bearerToken.length > MAX_BEARER || /[\s\u0000-\u001f]/.test(bearerToken)) return { ok: false, status: 422, error: 'Token bearer inválido.' };
    } else bearerToken = null;
    saveDestination(this.dataDir, { url: url.trim(), bearerToken });
    this.registerSecrets({ url: url.trim(), bearer: bearerToken });
    this.queue = []; // pendências do destino anterior não vão para o novo
    this.st.streak = 0;
    this.saveState();
    return { ok: true, status: 200 };
  }

  removeDestination() {
    if (String(this.env.ALERT_WEBHOOK_URL ?? '').trim() || String(this.env.ALERT_WEBHOOK_URL_FILE ?? '').trim()) {
      return { ok: false, status: 409, error: 'O destino é definido pelo ambiente; remova-o de lá.' };
    }
    clearDestination(this.dataDir);
    this.queue = [];
    this.clearTimer();
    return { ok: true, status: 200 };
  }

  // Estado para painel e CLI: nada de URL, token, caminho ou conteúdo de resposta.
  status() {
    const d = this.destination();
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return {
      enabled: this.cfg.enabled,
      configured: Boolean(d.configured),
      valid: Boolean(d.valid),
      source: d.source,
      host: d.valid ? d.host : null,
      problem: d.valid ? null : d.problem ?? null,
      format: this.cfg.format,
      allowPrivate: this.cfg.allowPrivate,
      thresholds: {
        hnrWithinHours: this.cfg.hnrWithinHours, diskFreeGiB: this.cfg.diskFreeGiB, trackerMinutes: this.cfg.trackerMinutes,
        noPeersMinutes: this.cfg.noPeersMinutes, cooldownMinutes: this.cfg.cooldownMinutes,
      },
      events: TYPES,
      open: TYPES.filter((t) => this.st.types[t]?.notified),
      queued: this.queue.length,
      dropped: this.dropped,
      lastSuccessAt: iso(this.st.last.successAt),
      lastFailureAt: iso(this.st.last.failureAt),
      lastError: this.st.last.error,
    };
  }
}

module.exports = {
  AlertManager,
  AlertSendError,
  CAMPOS_JSON,
  TYPES,
  DEST_FILE,
  STATE_FILE,
  OBSERVE_INTERVAL_MS,
  RETRY_DELAYS_MS,
  MAX_QUEUE,
  classifyAddress,
  addressVerdict,
  parseDestination,
  createTransport,
  loadDestination,
  destinationPresent,
  saveDestination,
  clearDestination,
  configFromValues,
  evaluate,
  secretsOf,
};
