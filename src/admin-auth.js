// Administração do painel pela LAN (issue #24): credencial, sessões e limite de tentativas.
//
// Três coisas separadas, de propósito:
//   - login do ASC: confirma a CONTA no tracker; não autentica quem fala com este computador;
//   - credencial de instalação do addon (src/credentials.js): dá reprodução, nunca administração;
//   - senha de administração do painel (aqui): só vale para o painel e só quando a administração
//     pela LAN está habilitada. Nunca é a senha do ASC.
//
// Só o verificador (scrypt com sal) fica em disco, em DATA_DIR/panel-admin.json (0600). Quem
// escreve esse arquivo é o terminal (src/admin-cli.js); o servidor só LÊ. Assim "perdi a
// senha" se resolve no terminal do host, sem depender do ASC, e a troca ou remoção vale na
// hora para o servidor em execução (o arquivo é relido quando muda e a geração das sessões muda
// junto). Sessões vivem só em memória: reiniciar o aplicativo as encerra.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger').logger.child('admin-painel');

const FILE_NAME = 'panel-admin.json';
const FILE_VERSION = 1;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 });

const filePath = (dataDir) => path.join(dataDir, FILE_NAME);

class AdminAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdminAuthError';
    this.code = code;
  }
}

// Política mínima e honesta: tamanho (a defesa real contra tentativa é o limite de tentativas e o
// scrypt) e recusa de repetição trivial. Não adivinha se coincide com a senha do ASC.
function checkPassword(password) {
  if (typeof password !== 'string') return 'a senha deve ser texto.';
  if (password.length < PASSWORD_MIN) return `a senha precisa de pelo menos ${PASSWORD_MIN} caracteres.`;
  if (password.length > PASSWORD_MAX) return `a senha não pode passar de ${PASSWORD_MAX} caracteres.`;
  if (new Set(password).size < 5) return 'a senha tem caracteres demais repetidos.';
  return null;
}

const scrypt = (password, salt, params = SCRYPT) => new Promise((resolve, reject) => {
  crypto.scrypt(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
});

// Gera o documento a gravar (async por causa do scrypt). `generation` muda a cada senha nova:
// é o que revoga as sessões abertas com a senha anterior.
async function buildRecord(password) {
  const problem = checkPassword(password);
  if (problem) throw new AdminAuthError('weak', problem);
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return {
    version: FILE_VERSION,
    kdf: 'scrypt',
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    generation: crypto.randomBytes(8).toString('hex'),
    updatedAt: new Date().toISOString(),
  };
}

function validRecord(doc) {
  return doc && doc.version === FILE_VERSION && doc.kdf === 'scrypt'
    && doc.N === SCRYPT.N && doc.r === SCRYPT.r && doc.p === SCRYPT.p
    && typeof doc.salt === 'string' && Buffer.from(doc.salt, 'base64').length === 16
    && typeof doc.hash === 'string' && Buffer.from(doc.hash, 'base64').length === SCRYPT.keylen
    && /^[0-9a-f]{16}$/.test(doc.generation);
}

// Gravação (usada só pelo terminal e pelos testes). `exclusive: true` só cria se ainda não existe
// (link atômico): duas provisões simultâneas da primeira senha nunca se sobrepõem, uma delas falha.
function writeRecord(dataDir, record, { exclusive = false } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = filePath(dataDir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    if (exclusive) {
      try { fs.linkSync(tmp, file); } catch (err) {
        if (err.code === 'EEXIST') throw new AdminAuthError('exists', 'Já existe uma senha de administração; use a troca explícita.');
        throw err;
      }
    } else fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nada a limpar */ }
  }
}

function removeRecord(dataDir) {
  try { fs.unlinkSync(filePath(dataDir)); return true; } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// Leitura com cache por assinatura (mtime, tamanho, inode): o servidor percebe troca/remoção feita
// pelo terminal sem reiniciar e sem reler o disco a cada requisição.
class AdminCredential {
  constructor({ dataDir }) {
    this.file = filePath(dataDir);
    this.sig = null;
    this.record = null;
    this.warned = false;
  }

  load() {
    let st;
    try { st = fs.statSync(this.file); } catch {
      this.sig = 'ausente'; this.record = null; this.warned = false;
      return null;
    }
    const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (sig === this.sig) return this.record;
    this.sig = sig;
    this.record = null;
    try {
      // Fail-closed: arquivo grande demais, ilegível ou com formato inesperado = sem credencial.
      if (st.size > 4096) throw new Error('tamanho inesperado');
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!validRecord(doc)) throw new Error('formato inesperado');
      this.record = doc;
    } catch (err) {
      if (!this.warned) log.warn(`${FILE_NAME} inválido (${err.message}): administração pela LAN sem credencial (fail-closed)`);
      this.warned = true;
    }
    return this.record;
  }

  configured() { return this.load() !== null; }

  generation() { return this.load()?.generation ?? null; }

  // Compara em tempo constante. Sem credencial, ainda faz o trabalho do scrypt contra um sal
  // descartável para não revelar por tempo se a administração está configurada.
  async verify(password) {
    const rec = this.load();
    if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX) return false;
    const salt = rec ? Buffer.from(rec.salt, 'base64') : crypto.randomBytes(16);
    const got = await scrypt(password, salt);
    if (!rec) return false;
    return crypto.timingSafeEqual(got, Buffer.from(rec.hash, 'base64'));
  }
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Sessões de administração, em memória. O cookie carrega só um identificador aleatório (256 bits);
// o mapa é indexado pelo SHA-256 dele. Expiram por inatividade e por tempo absoluto (relógios
// distintos), seguem a geração da credencial (trocar/remover a senha as revoga) e têm o id
// rotacionado de tempos em tempos: o id anterior fica válido por poucos segundos para não quebrar
// requisições paralelas que já saíram com ele.
const SESSION_CAP = 16;
const ROTATE_AFTER_MS = 15 * 60_000;
const ROTATE_GRACE_MS = 15_000;

class AdminSessions {
  constructor({ idleMs, maxMs, generation, now = () => Date.now(), rotateMs = ROTATE_AFTER_MS }) {
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    this.generation = generation; // () => geração atual da credencial (null = sem credencial)
    this.now = now;
    this.rotateMs = rotateMs;
    this.byId = new Map(); // sha256(id) -> sessão
    this.previous = new Map(); // sha256(id antigo) -> { session, until }
  }

  newId() { return crypto.randomBytes(32).toString('base64url'); }

  // `binding`: o Host exato do login; a sessão não vale em outro endereço.
  create(binding) {
    this.sweep();
    while (this.byId.size >= SESSION_CAP) this.byId.delete(this.byId.keys().next().value);
    const id = this.newId();
    const t = this.now();
    const session = { createdAt: t, lastSeen: t, rotatedAt: t, csrf: crypto.randomBytes(32).toString('base64url'), binding, generation: this.generation(), keyHash: sha(id) };
    this.byId.set(session.keyHash, session);
    return { id, session };
  }

  expired(s, t) { return t - s.lastSeen > this.idleMs || t - s.createdAt > this.maxMs; }

  // Devolve { session, rotateTo? } ou null. Toca a inatividade.
  check(id, binding) {
    if (typeof id !== 'string' || id.length < 40 || id.length > 64) return null;
    const t = this.now();
    const key = sha(id);
    let s = this.byId.get(key);
    if (!s) {
      const old = this.previous.get(key);
      if (old && old.until > t && this.byId.get(old.session.keyHash) === old.session) s = old.session;
      else return null;
    }
    const gen = this.generation();
    if (gen === null || s.generation !== gen || this.expired(s, t) || !safeEqual(s.binding, binding)) {
      this.destroyKey(s.keyHash);
      return null;
    }
    s.lastSeen = t;
    if (this.byId.get(key) === s && t - s.rotatedAt > this.rotateMs) {
      const next = this.newId();
      this.byId.delete(s.keyHash);
      this.previous.set(key, { session: s, until: t + ROTATE_GRACE_MS });
      s.keyHash = sha(next);
      s.rotatedAt = t;
      this.byId.set(s.keyHash, s);
      return { session: s, rotateTo: next };
    }
    return { session: s };
  }

  destroyKey(keyHash) {
    this.byId.delete(keyHash);
    for (const [k, v] of this.previous) if (v.session.keyHash === keyHash) this.previous.delete(k);
  }

  destroy(id) {
    if (typeof id !== 'string') return;
    const s = this.byId.get(sha(id)) ?? this.previous.get(sha(id))?.session;
    if (s) this.destroyKey(s.keyHash);
  }

  destroyAll() { this.byId.clear(); this.previous.clear(); }

  sweep() {
    const t = this.now();
    for (const [k, s] of this.byId) if (this.expired(s, t)) this.byId.delete(k);
    for (const [k, v] of this.previous) if (v.until <= t || !this.byId.has(v.session.keyHash)) this.previous.delete(k);
  }

  size() { this.sweep(); return this.byId.size; }

  expiresAt(s) { return Math.min(s.createdAt + this.maxMs, s.lastSeen + this.idleMs); }
}

// Limite de tentativas de senha errada: por origem (IP do socket, nunca cabeçalho encaminhado) e
// global, em janela deslizante. Excedido = 429 com Retry-After. Sem bloqueio permanente: a única
// conta administrativa não pode ficar trancada para sempre por um terceiro (nem o dono precisa
// do terminal para voltar: basta esperar a janela). Custo: um vizinho da rede pode atrasar o dono
// por até uma janela; é negação de serviço breve, não acesso.
class LoginLimiter {
  constructor({ perSource = 5, global = 30, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.perSource = perSource;
    this.global = global;
    this.windowMs = windowMs;
    this.now = now;
    this.bySource = new Map();
    this.all = [];
  }

  prune(list, t) {
    while (list.length && t - list[0] >= this.windowMs) list.shift();
    return list;
  }

  // { ok: true } ou { ok: false, retryAfter } (segundos, inteiro >= 1).
  check(source) {
    const t = this.now();
    this.prune(this.all, t);
    const mine = this.prune(this.bySource.get(source) ?? [], t);
    if (mine.length === 0) this.bySource.delete(source);
    const wait = (list, max) => (list.length >= max ? Math.max(1, Math.ceil((list[0] + this.windowMs - t) / 1000)) : 0);
    const retry = Math.max(wait(mine, this.perSource), wait(this.all, this.global));
    return retry ? { ok: false, retryAfter: retry } : { ok: true };
  }

  fail(source) {
    const t = this.now();
    this.all.push(t);
    const list = this.bySource.get(source) ?? [];
    list.push(t);
    this.bySource.set(source, list);
    if (this.bySource.size > 1000) { // memória limitada sob varredura de muitos endereços
      for (const [k, l] of this.bySource) { this.prune(l, t); if (!l.length) this.bySource.delete(k); }
    }
  }

  succeed(source) { this.bySource.delete(source); }
}

module.exports = {
  FILE_NAME, PASSWORD_MIN, PASSWORD_MAX, AdminAuthError, filePath, checkPassword, buildRecord, writeRecord, removeRecord,
  AdminCredential, AdminSessions, LoginLimiter, safeEqual,
};
