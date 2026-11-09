// Cache mínimo de metadados de APRESENTAÇÃO das fontes do ASC, por filme (IMDb).
//
// Para que serve: quando o ASC está fora do ar (site, sessão expirada, rede), a busca por IMDb
// ainda sabe quais releases já baixados correspondem àquele filme e como mostrá-los (nome, selos
// de resolução/fonte/áudio). Sem isto o mapeamento IMDb -> release só existia em memória.
//
// O que NÃO é: autorização. Nada aqui libera um novo .torrent, presume freeleech, seeders ou seed
// cumprido: esses campos nem são guardados. Também não guarda cookie, passkey, credencial, URL
// de download ou de stream. O arquivo é local (DATA_DIR, 0600), com versão do formato, limite de
// títulos, de bytes e de idade. Arquivo ilegível ou de outra versão é ignorado (começa vazio).

const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger').logger.child('meta-cache');

const VERSION = 1;
const DAY_MS = 24 * 3600_000;
const STALE_AFTER_MS = 7 * DAY_MS; // mostrado como "pode estar desatualizado"
const EXPIRE_AFTER_MS = 90 * DAY_MS; // descartado: o mapeamento deixa de valer
const MAX_TITLES = 300;
const MAX_RELEASES = 12;
const MAX_BYTES = 512 * 1024;

const IMDB = /^tt\d{1,10}$/;
const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// Só campos de apresentação; qualquer outro campo do site é descartado.
function cleanRelease(row) {
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0) return null;
  const name = text(row.name, 200);
  if (!name) return null;
  const badges = (Array.isArray(row.badges) ? row.badges : [])
    .map((badge) => ({ label: text(badge?.label, 40), kind: text(badge?.kind, 20) }))
    .filter((badge) => badge.label)
    .slice(0, 12);
  const size = Number.isFinite(row.size) && row.size > 0 ? row.size : null;
  return { id: row.id, name, size, badges };
}

class MetaCache {
  constructor({ file, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.titles = new Map(); // imdbId -> { at, releases }
  }

  load() {
    this.titles = new Map();
    if (!this.file) return this;
    try {
      if (fs.statSync(this.file).size > MAX_BYTES * 2) throw new Error('arquivo grande demais');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data?.version !== VERSION || typeof data.titles !== 'object' || data.titles === null) throw new Error('formato desconhecido');
      for (const [imdbId, item] of Object.entries(data.titles)) {
        if (!IMDB.test(imdbId) || !Number.isFinite(item?.at) || this.now() - item.at > EXPIRE_AFTER_MS) continue;
        const releases = (Array.isArray(item.releases) ? item.releases : []).map(cleanRelease).filter(Boolean).slice(0, MAX_RELEASES);
        if (releases.length) this.titles.set(imdbId, { at: item.at, releases });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn(`cache de metadados ignorado (${error?.message ?? error}); recomeçando vazio`);
      this.titles = new Map();
    }
    return this;
  }

  // Releases conhecidos do filme, ou null (nunca visto ou vencido). `stale`: confirmado há mais de 7 dias.
  get(imdbId) {
    const item = this.titles.get(imdbId);
    if (!item) return null;
    const age = this.now() - item.at;
    if (age > EXPIRE_AFTER_MS) { this.titles.delete(imdbId); return null; }
    return { at: item.at, stale: age > STALE_AFTER_MS, releases: item.releases };
  }

  // Resultado de uma busca online bem-sucedida: substitui o que havia (invalida releases que sumiram).
  set(imdbId, rows) {
    if (!IMDB.test(imdbId)) return;
    const releases = (Array.isArray(rows) ? rows : []).map(cleanRelease).filter(Boolean).slice(0, MAX_RELEASES);
    if (!releases.length) {
      if (this.titles.delete(imdbId)) this.save();
      return;
    }
    const before = this.titles.get(imdbId);
    // Busca idêntica no mesmo dia não regrava o arquivo.
    const same = before && this.now() - before.at < DAY_MS && JSON.stringify(before.releases) === JSON.stringify(releases);
    if (same) return;
    this.titles.set(imdbId, { at: this.now(), releases });
    this.save();
  }

  serialize() {
    const ordered = [...this.titles.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TITLES);
    let body;
    for (;;) {
      body = JSON.stringify({ version: VERSION, titles: Object.fromEntries(ordered) });
      if (Buffer.byteLength(body) <= MAX_BYTES || ordered.length <= 1) break;
      ordered.pop(); // estourou o limite: descarta o mais antigo
    }
    this.titles = new Map(ordered);
    return body;
  }

  // Escrita atômica (temporário + rename); falha de disco não derruba a busca.
  save() {
    if (!this.file) return;
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, this.serialize(), { mode: 0o600 });
      try { fs.chmodSync(temp, 0o600); } catch { /* Windows/volume sem chmod */ }
      fs.renameSync(temp, this.file);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* nada a limpar */ }
      log.warn(`cache de metadados não gravado: ${error?.message ?? error}`);
    }
  }
}

module.exports = { MetaCache, cleanRelease, VERSION, STALE_AFTER_MS, EXPIRE_AFTER_MS, MAX_TITLES, MAX_RELEASES, MAX_BYTES };
