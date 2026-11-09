// Central de logs do addon.
//
// - Níveis: debug < info < warn < error. `LOG_LEVEL` define o mínimo gravado.
// - Buffer circular em memória (consulta rápida pelo painel) + arquivos diários
//   NDJSON em private/logs/ (0600), com retenção e teto de tamanho por dia.
// - REDAÇÃO antes de qualquer gravação: a passkey, cookies, senhas e tokens
//   nunca chegam ao buffer, ao arquivo, ao terminal nem ao download.
// - `captureConsole()` roteia os console.* já existentes (com prefixo [tag])
//   para cá, sem mudar o que aparece no terminal/journald.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { randomBytes } = require('node:crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = Object.keys(LEVELS);
// Aceita o prefixo antigo (brazuka-) para não perder o histórico de quem já tinha logs.
const FILE_RE = /^(?:ascstremio|brazuka)-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.log$/;
const MAX_MSG = 4000;
const MAX_DATA = 8000;

// Referências originais: o terminal continua recebendo as mesmas linhas.
const orig = {
  log: console.log.bind(console), info: console.info.bind(console), warn: console.warn.bind(console),
  error: console.error.bind(console), debug: console.debug.bind(console),
};

const SENSITIVE_KEY = /pass(word|key)?|senha|cookie|token|secret|authorization|csrf/i;

class Logger {
  constructor({ max = 5000, level = 'debug', dir = null, retentionDays = 14, maxDayBytes = 20 * 1024 * 1024, now = () => Date.now(), echo = false } = {}) {
    this.max = max;
    this.minLevel = LEVELS[level] ?? LEVELS.debug;
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.maxDayBytes = maxDayBytes;
    this.now = now;
    this.echo = echo;
    this.boot = randomBytes(4).toString('hex'); // muda a cada partida: o painel reinicia o cursor
    this.entries = [];
    this.nextId = 1;
    this.secrets = new Set();
    this.dayKey = null;
    this.dayFile = null;
    this.dayBytes = 0;
    this.captured = false;
    if (dir) this.openDir();
  }

  // ------------------------------------------------------------ segredos
  addSecret(value) {
    if (typeof value === 'string' && value.length >= 8) this.secrets.add(value);
  }

  redact(text) {
    let out = String(text);
    for (const s of this.secrets) out = out.split(s).join('[redigido]');
    return out
      .replace(/\/announce\/[0-9a-fA-F]{16,}/g, '/announce/[redigido]')
      .replace(/(passkey|pass|token|key)=([^&\s"']+)/gi, '$1=[redigido]')
      // credencial de instalação: token solto (caminho do addon), `?k=` das URLs de vídeo
      .replace(/ascc_[A-Za-z0-9_-]{8,}/g, 'ascc_[redigido]')
      .replace(/(?<![A-Za-z0-9_])k=[^&\s"']+/g, 'k=[redigido]')
      .replace(/(set-cookie|cookie|authorization):\s*[^\n]+/gi, '$1: [redigido]')
      .replace(/\b(XSRF-TOKEN|[a-z0-9-]*session|remember_web_[0-9a-f]+)=[^;\s]+/gi, '$1=[redigido]')
      // passkey (32 hex) e token CSRF (64 hex) soltos; infoHash (40 hex) fica
      .replace(/(?<![0-9a-fA-F])(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{64})(?![0-9a-fA-F])/g, '[redigido]');
  }

  redactData(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this.redact(value);
    if (typeof value !== 'object') return value;
    if (depth > 4) return '[…]';
    if (value instanceof Error) return this.redact(value.stack || value.message);
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => this.redactData(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redigido]' : this.redactData(v, depth + 1);
    }
    return out;
  }

  // -------------------------------------------------------------- escrita
  setLevel(level) {
    if (!(level in LEVELS)) return false;
    this.minLevel = LEVELS[level];
    return true;
  }
  get level() { return LEVEL_NAMES.find((n) => LEVELS[n] === this.minLevel) ?? 'debug'; }

  write(level, src, msg, data, { echoed = false } = {}) {
    if (!(level in LEVELS) || LEVELS[level] < this.minLevel) return null;
    let message = this.redact(String(msg)).slice(0, MAX_MSG);
    let extra;
    if (data !== undefined && data !== null) {
      const clean = this.redactData(data);
      const json = JSON.stringify(clean);
      extra = json && json.length > MAX_DATA ? { truncado: json.slice(0, MAX_DATA) } : clean;
    }
    const entry = { id: this.nextId++, t: this.now(), level, src: String(src || 'app').slice(0, 24), msg: message };
    if (extra !== undefined) entry.data = extra;
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.persist(entry);
    if (this.echo && !echoed && LEVELS[level] >= LEVELS.info) {
      const fn = level === 'error' ? orig.error : level === 'warn' ? orig.warn : orig.log;
      fn(`[${entry.src}] ${entry.msg}`);
    }
    return entry;
  }

  child(src) {
    return {
      debug: (m, d) => this.write('debug', src, m, d),
      info: (m, d) => this.write('info', src, m, d),
      warn: (m, d) => this.write('warn', src, m, d),
      error: (m, d) => this.write('error', src, m, d),
    };
  }

  // ---------------------------------------------------------- arquivos
  openDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.prune();
      this.loadHistory();
    } catch { this.dir = null; }
  }

  dayName(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  persist(entry) {
    if (!this.dir) return;
    try {
      const key = this.dayName(entry.t);
      if (key !== this.dayKey) {
        this.dayKey = key;
        this.dayFile = path.join(this.dir, `ascstremio-${key}.log`);
        this.dayBytes = fs.existsSync(this.dayFile) ? fs.statSync(this.dayFile).size : 0;
        this.prune();
      }
      // Teto por dia: passado dele, só warn/error entram (nunca perde o que importa).
      if (this.dayBytes > this.maxDayBytes && LEVELS[entry.level] < LEVELS.warn) return;
      const line = `${JSON.stringify(entry)}\n`;
      fs.appendFileSync(this.dayFile, line, { mode: 0o600 });
      this.dayBytes += Buffer.byteLength(line);
    } catch { /* disco cheio ou sem permissão: o buffer em memória segue valendo */ }
  }

  listFiles() {
    if (!this.dir) return [];
    try {
      return fs.readdirSync(this.dir)
        .filter((n) => FILE_RE.test(n))
        .map((name) => { const st = fs.statSync(path.join(this.dir, name)); return { name, bytes: st.size, modifiedAt: st.mtimeMs }; })
        .sort((a, b) => (a.name < b.name ? 1 : -1));
    } catch { return []; }
  }

  // Só nomes que o próprio logger criou; qualquer outra coisa (inclusive "..") é recusada.
  filePath(name) {
    if (!this.dir || typeof name !== 'string' || !FILE_RE.test(name)) return null;
    const full = path.join(this.dir, name);
    return full.startsWith(this.dir + path.sep) && fs.existsSync(full) ? full : null;
  }

  prune() {
    if (!this.dir) return;
    const limit = this.now() - this.retentionDays * 86_400_000;
    for (const f of this.listFiles()) {
      const m = FILE_RE.exec(f.name);
      if (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() < limit) {
        try { fs.rmSync(path.join(this.dir, f.name)); } catch { /* já removido */ }
      }
    }
  }

  // Ao subir, o painel já mostra o que aconteceu antes do restart.
  loadHistory() {
    const files = this.listFiles().sort((a, b) => (a.name > b.name ? 1 : -1)).slice(-3);
    const lines = [];
    for (const f of files) {
      try { lines.push(...fs.readFileSync(path.join(this.dir, f.name), 'utf8').split('\n').filter(Boolean)); } catch { /* arquivo ilegível */ }
    }
    for (const raw of lines.slice(-this.max)) {
      try {
        const e = JSON.parse(raw);
        if (e && LEVELS[e.level] && typeof e.t === 'number') this.entries.push({ ...e, id: this.nextId++ });
      } catch { /* linha corrompida */ }
    }
  }

  // ------------------------------------------------------------- consulta
  matches(e, { levels, source, q, since }) {
    if (levels && !levels.has(e.level)) return false;
    if (source && e.src !== source) return false;
    if (since && e.t < since) return false;
    if (q) {
      const hay = `${e.src} ${e.msg} ${e.data === undefined ? '' : JSON.stringify(e.data)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  static parseFilter(params) {
    const lv = String(params.get?.('nivel') ?? params.nivel ?? '').split(',').map((s) => s.trim()).filter((s) => s in LEVELS);
    const q = String(params.get?.('q') ?? params.q ?? '').trim().toLowerCase().slice(0, 100);
    const source = String(params.get?.('fonte') ?? params.fonte ?? '').trim().slice(0, 24);
    const since = Number(params.get?.('desde') ?? params.desde ?? 0);
    return { levels: lv.length ? new Set(lv) : null, q, source, since: Number.isFinite(since) && since > 0 ? since : 0 };
  }

  query(filter = {}, { after = 0, before = 0, limit = 500 } = {}) {
    const lim = Math.min(Math.max(1, Number(limit) || 500), 20000);
    const hit = this.entries.filter((e) => this.matches(e, filter));
    let out;
    if (after) out = hit.filter((e) => e.id > after).slice(0, lim);
    else if (before) out = hit.filter((e) => e.id < before).slice(-lim);
    else out = hit.slice(-lim);
    // `more` = existem entradas mais antigas que a primeira devolvida
    return { entries: out, more: out.length > 0 && hit[0].id < out[0].id };
  }

  counts(since = 0) {
    const c = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of this.entries) if (!since || e.t >= since) c[e.level] += 1;
    return c;
  }
  sources() { return [...new Set(this.entries.map((e) => e.src))].sort(); }
  get lastId() { return this.nextId - 1; }

  format(e) {
    const lvl = e.level.toUpperCase().padEnd(5);
    const extra = e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
    return `${new Date(e.t).toISOString()} ${lvl} [${e.src}] ${e.msg}${extra}`;
  }

  // ----------------------------------------------------- captura do console
  captureConsole() {
    if (this.captured) return;
    this.captured = true;
    const route = (level, fn) => (...args) => {
      let text = util.format(...args).replace(/^\n+/, '');
      const m = /^\[([^\]\n]{1,24})\]\s*([\s\S]*)$/.exec(text);
      // Avisos do próprio Node ("(node:123) [DEP0040] DeprecationWarning…") são avisos, não erros.
      const nodeWarn = /^\(node:\d+\) /.test(text);
      const src = nodeWarn ? 'node' : (m ? m[1] : 'app');
      this.write(nodeWarn && level === 'error' ? 'warn' : level, src, m ? m[2] : text.split('\n')[0], undefined, { echoed: true });
      // Terminal/journald continuam vendo a linha (já sem segredos), mesmo que o
      // nível mínimo de gravação a deixe fora do buffer. Debug nunca vai ao terminal.
      if (level !== 'debug') fn(this.redact(text));
    };
    console.log = route('info', orig.log);
    console.info = route('info', orig.info);
    console.warn = route('warn', orig.warn);
    console.error = route('error', orig.error);
    console.debug = route('debug', orig.debug);
  }
}

const envLevel = String(process.env.LOG_LEVEL || 'debug').toLowerCase();
const logger = new Logger({ level: envLevel in LEVELS ? envLevel : 'debug' });

// Liga a gravação em disco (index.js passa a pasta).
function initFiles(dir, opts = {}) {
  logger.dir = dir;
  if (opts.retentionDays) logger.retentionDays = opts.retentionDays;
  if (opts.maxDayBytes) logger.maxDayBytes = opts.maxDayBytes;
  logger.openDir();
  return logger;
}

module.exports = { Logger, logger, initFiles, LEVELS, LEVEL_NAMES, FILE_RE };
