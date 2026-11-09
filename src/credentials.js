// Credenciais de instalação: cada aparelho/instalação do Stremio recebe um token
// próprio, revogável sozinho. O token vai na URL base do addon (/<token>/manifest.json),
// único modelo que o Stremio propaga a catálogo, meta e stream (ele não envia
// cabeçalhos de autenticação), e nas URLs de vídeo (?k=<token>).
//
// Limite honesto: o Stremio sincroniza addons entre os aparelhos da mesma conta, então
// o token identifica uma INSTALAÇÃO do addon, não um hardware. Quem tem a URL tem o
// acesso de reprodução; revogar o token derruba esse acesso sem girar os demais.
//
// Só o verificador (SHA-256 do token) fica em disco: o token aparece uma vez, quando
// é emitido. O token tem 256 bits aleatórios, então um hash rápido basta (não há o que
// forçar por dicionário). Nada daqui concede administração, conta ou logs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');
const log = require('./logger').logger.child('credenciais');

const TOKEN_PREFIX = 'ascc_';
const TOKEN_RE = /^ascc_[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 40;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const publicView = (c) => ({
  id: c.id, name: c.name, status: c.status, createdAt: c.createdAt, revokedAt: c.revokedAt,
});

// O token da requisição em curso fica aqui para o addon montar as URLs de vídeo com a
// mesma credencial que o cliente usou, sem passar o segredo por todas as funções.
const context = new AsyncLocalStorage();
const runWith = (credential, token, fn) => context.run({ credential, token }, fn);
const currentCredential = () => context.getStore()?.credential ?? null;
const currentToken = () => context.getStore()?.token ?? null;

function cleanName(name) {
  const text = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!text || text.length > NAME_MAX) {
    throw new Error(`o nome da credencial deve ter de 1 a ${NAME_MAX} caracteres`);
  }
  return text;
}

class CredentialStore extends EventEmitter {
  constructor({ file, now = () => Date.now() }) {
    super();
    this.file = file;
    this.now = now;
    this.items = new Map();
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('arquivo de credenciais ilegível: nenhuma credencial válida (fail-closed)');
      return;
    }
    try {
      for (const c of JSON.parse(raw).credentials ?? []) {
        if (c && /^c_[0-9a-f]{8}$/.test(c.id) && /^[0-9a-f]{64}$/.test(c.verifier)) {
          this.items.set(c.id, { ...c, name: String(c.name ?? '').slice(0, NAME_MAX), status: c.status === true });
        }
      }
    } catch {
      this.items.clear();
      log.warn('arquivo de credenciais corrompido: nenhuma credencial válida (fail-closed)');
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, credentials: [...this.items.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // `status`: a credencial pode ver o catálogo "ASC — status" (ratio, avisos). Negado por padrão.
  create({ name, status = false } = {}) {
    const clean = cleanName(name);
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    let id;
    do { id = `c_${crypto.randomBytes(4).toString('hex')}`; } while (this.items.has(id));
    const credential = { id, name: clean, status: status === true, verifier: hashToken(token), createdAt: this.now(), revokedAt: null };
    this.items.set(id, credential);
    this.save();
    log.info('credencial emitida', { id, nome: clean, status: credential.status });
    return { credential: publicView(credential), token };
  }

  // Devolve a credencial ativa que corresponde ao token, ou null. Compara em tempo constante.
  verify(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const given = Buffer.from(hashToken(token), 'hex');
    let found = null;
    for (const c of this.items.values()) {
      const same = crypto.timingSafeEqual(given, Buffer.from(c.verifier, 'hex'));
      if (same && !c.revokedAt) found = c;
    }
    return found ? publicView(found) : null;
  }

  revoke(id) {
    const c = this.items.get(id);
    if (!c) return false;
    if (!c.revokedAt) {
      c.revokedAt = this.now();
      this.save();
      log.info('credencial revogada', { id, nome: c.name });
      this.emit('revoked', id);
    }
    return true;
  }

  // Rotação = emite uma nova com o mesmo nome/permissão e revoga a antiga.
  rotate(id) {
    const old = this.items.get(id);
    if (!old || old.revokedAt) return null;
    const next = this.create({ name: old.name, status: old.status });
    this.revoke(id);
    return next;
  }

  list() { return [...this.items.values()].map(publicView); }

  hasActive() { return [...this.items.values()].some((c) => !c.revokedAt); }
}

module.exports = { CredentialStore, TOKEN_RE, runWith, currentCredential, currentToken };
