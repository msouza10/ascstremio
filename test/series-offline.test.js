const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createAscProvider } = require('../src/asc-provider');
const { AscError } = require('../src/asc-client');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const { tmpdir } = require('./tmp-helper');

const HASH = 'a'.repeat(40);
const IMDB = 'tt0903747';
const PL = 8;
const DADOS = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];
const tudo = Buffer.concat(DADOS);
const pieces = [];
for (let o = 0; o < tudo.length; o += PL) pieces.push(createHash('sha1').update(tudo.subarray(o, o + PL)).digest('hex'));

// ---- Cofre: o vínculo persiste ---------------------------------------------------------------------
test('cofre: o IMDb da série fica gravado, sobrevive ao reinício e recusa valor inválido', () => {
  const file = path.join(tmpdir('so-v-'), 'v.json');
  const v = new SeedVault({ file });
  v.markSeen(HASH, { name: 'Pack' });
  assert.equal(v.setSeriesLink(HASH, 'tt0903747').imdbId, 'tt0903747');
  for (const ruim of ['', 'abc', 'tt', 'tt123456789012', '../x', null, 5]) v.setSeriesLink(HASH, ruim);
  assert.equal(new SeedVault({ file }).get(HASH).imdbId, 'tt0903747');
  assert.equal(v.setSeriesLink('b'.repeat(40), 'tt1'), null, 'sem entrada no cofre não cria vínculo');
});

// ---- Ponte: grava o vínculo quando o episódio é tocado -------------------------------------------
const cred = new CredentialStore({ file: path.join(tmpdir('so-cred-'), 'credentials.json') });
const { token: TOKEN } = cred.create({ name: 'teste' });
function resposta() {
  const r = new EventEmitter();
  Object.assign(r, { statusCode: 0, headers: {}, chunks: [], headersSent: false, writableFinished: false, writableEnded: false, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(st, h) { this.statusCode = st; Object.assign(this.headers, h || {}); this.headersSent = true; },
    write(c) { this.chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) this.chunks.push(Buffer.from(c)); this.writableEnded = true; this.writableFinished = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); } });
  return r;
}
const pedido = (method, url, headers = {}) => ({ method, url: `${url}?k=${TOKEN}`, headers, socket: { remoteAddress: '127.0.0.1' } });

function ponte(over = {}) {
  const store = tmpdir('so-store-');
  const vault = new SeedVault({ file: path.join(tmpdir('so-v2-'), 'v.json') });
  vault.markSeen(HASH, { name: 'Pack', freeleech: true });
  const lib = { infoHash: HASH, name: 'Pack', title: 'Pack', freeleech: true, torrentPath: '/x/asc-12.torrent',
    files: DADOS.map((d, i) => ({ index: i, path: `P/P.S01E0${i + 1}.mkv`, length: d.length, isVideo: true })) };
  fs.mkdirSync(path.join(store, 'P'));
  lib.files.forEach((f, i) => fs.writeFileSync(path.join(store, f.path), DADOS[i]));
  const b = new Bridge({ torrentDir: '/tmp', storeDir: store, port: 7099, publicUrl: 'http://127.0.0.1:7010/', credentials: cred, vault,
    minFreeBytes: 1000, freeSpace: () => 1e12,
    loadPieceMeta: async () => ({ pieceLength: PL, pieces, length: tudo.length, files: lib.files.map((f) => ({ path: f.path, length: f.length })) }), ...over });
  b.entries.set(HASH, lib);
  b.client = { torrents: [] };
  return { b, vault, lib, store };
}
const abrir = (b) => { b.getTorrent = async () => ({ ready: true, numPeers: 0, progress: 0, files: DADOS.map((d) => ({ length: d.length, path: 'x', downloaded: 0, createReadStream: ({ start, end }) => Readable.from([d.subarray(start, end + 1)]) })) }); };

test('tocar um episódio por /e/ grava o IMDb da série no pack; HEAD e dica ausente não gravam', async () => {
  const s = ponte({ ascImdbHint: (id) => (id === '12' ? IMDB : null) });
  abrir(s.b);
  s.b.ascEpisodeResolver = async () => ({ infoHash: HASH, fileIdx: 1 });
  await s.b.handle(pedido('HEAD', '/e/12/1/2'), resposta());
  assert.ok(!s.vault.get(HASH).imdbId, 'HEAD não é play');
  const outro = resposta();
  await s.b.handle(pedido('GET', '/e/99/1/2', { range: 'bytes=0-3' }), outro);
  assert.ok(!s.vault.get(HASH).imdbId, 'release que o provedor não conhece: sem vínculo');
  const res = resposta();
  await s.b.handle(pedido('GET', '/e/12/1/2', { range: 'bytes=0-3' }), res);
  assert.equal(res.statusCode, 206);
  assert.equal(s.vault.get(HASH).imdbId, IMDB);
});

test('com o .torrent já local, tocar o episódio também grava o vínculo', async () => {
  const s = ponte({ ascImdbHint: () => IMDB });
  abrir(s.b);
  s.b.ascEpisodeResolver = async () => { throw new Error('não devia resolver'); };
  s.b.entryByAscId = () => s.lib; // o provedor já tem este .torrent
  await s.b.handle(pedido('GET', '/e/12/1/2', { range: 'bytes=0-3' }), resposta());
  assert.equal(s.vault.get(HASH).imdbId, IMDB);
});

// ---- Ponte: quais episódios locais servem ao pedido, sem o ASC ------------------------------------
test('só episódio VERIFICADO por peças, não excluído e do IMDb certo é oferecido offline', async () => {
  const s = ponte();
  s.vault.setSeriesLink(HASH, IMDB);
  assert.deepEqual(s.b.localEpisodeSources(IMDB, 1, 2), [], 'só provável: sem prova não se oferece');
  await s.b.verifyEpisodes(HASH);
  const [src] = s.b.localEpisodeSources(IMDB, 1, 2);
  assert.deepEqual({ infoHash: src.infoHash, fileIdx: src.fileIdx, length: src.length, ascId: src.ascId }, { infoHash: HASH, fileIdx: 1, length: 16, ascId: '12' });
  assert.equal(s.b.localEpisodeSources('tt0000001', 1, 2).length, 0, 'outra série');
  assert.equal(s.b.localEpisodeSources(IMDB, 2, 1).length, 0, 'outra temporada');
  assert.equal(s.b.localEpisodeSources(IMDB, 1, 9).length, 0, 'episódio que o pack não tem');
  s.vault.setExcluded(HASH, 1, true);
  assert.equal(s.b.localEpisodeSources(IMDB, 1, 2).length, 0, 'excluído por você não é oferecido');
});

test('pack sem vínculo com a série nunca é oferecido, mesmo verificado', async () => {
  const s = ponte();
  await s.b.verifyEpisodes(HASH);
  assert.deepEqual(s.b.localEpisodeSources(IMDB, 1, 1), []);
});

test('a prova caduca: arquivo alterado depois de verificar deixa de ser oferecido', async () => {
  const s = ponte();
  s.vault.setSeriesLink(HASH, IMDB);
  await s.b.verifyEpisodes(HASH);
  const f = path.join(s.store, s.lib.files[0].path);
  fs.writeFileSync(f, Buffer.alloc(16, 9));
  const depois = new Date(Date.now() + 5000);
  fs.utimesSync(f, depois, depois);
  assert.equal(s.b.localEpisodeSources(IMDB, 1, 1).length, 0);
  assert.equal(s.b.localEpisodeSources(IMDB, 1, 2).length, 1);
});

// ---- Provedor: IMDb de cada release e o fallback offline de episódio -----------------------------
const row = (id) => ({ id, name: `Show S01 ${id}`, seeders: 10, freeleech: true, size: 1e10, badges: [{ label: '1080p', kind: 'resolution' }] });
function provedor({ fontes = [], falha = null } = {}) {
  const dir = tmpdir('so-prov-');
  const bridge = {
    entries: new Map(), vault: { get: () => null },
    lazyUrl: (id) => `http://x/a/${id}`, episodeUrl: (id, s, e) => `http://x/e/${id}/${s}/${e}`,
    urlFor: (hash, idx) => `http://x/s/${hash}/${idx}?k=T`, diskState: () => 'none', entryByAscId: () => null,
    localEpisodeSources: (imdb, s, e) => { bridge.chamadas.push([imdb, s, e]); return fontes; },
    chamadas: [],
  };
  const asc = {
    onlyFreeleech: false, connected: true, saved: true,
    async searchSeries() { if (falha) throw falha; return { rows: [row(5)], truncated: false }; },
    async releaseFiles() { return { files: [{ path: 'Show.S01E02.mkv', size: 1e9 }], total: 1, complete: true }; },
    async download() { return Buffer.from('x'); },
  };
  return { provider: createAscProvider(asc, bridge, dir, {}), bridge };
}
const ep = { type: 'series', imdbId: IMDB, season: 1, episode: 2 };
const fonte = { infoHash: HASH, fileIdx: 1, length: 1024 ** 3, path: 'P/Show.S01E02.mkv', name: 'Show S01 1080p', ascId: '12' };

test('provedor: lembra o IMDb de cada release listado (usado pela ponte no play)', async () => {
  const { provider } = provedor();
  assert.equal(provider.imdbOf(5), null, 'antes de listar não sabe');
  await provider.lookup(ep);
  assert.equal(provider.imdbOf(5), IMDB);
  assert.equal(provider.imdbOf('5'), IMDB);
  assert.equal(provider.imdbOf(999), null);
});

test('provedor: ASC fora do ar oferece o episódio verificado em disco, com o motivo', async () => {
  const { provider, bridge } = provedor({ fontes: [fonte], falha: new AscError('Não foi possível conectar ao ASC.', 'network') });
  const r = await provider.lookup(ep);
  assert.equal(r.offline.kind, 'network');
  assert.equal(r.streams.length, 1);
  assert.equal(r.streams[0].url, `http://x/s/${HASH}/1?k=T`, 'URL direta da ponte');
  assert.match(r.streams[0].name, /Local/);
  assert.match(r.streams[0].description, /Este episódio: 1 GB/);
  assert.match(r.streams[0].description, /conferido por peças/i);
  assert.match(r.streams[0].description, /Fontes online indisponíveis/);
  assert.equal(r.streams[0].behaviorHints.bingeGroup, 'asc-12');
  assert.equal(r.streams[0].behaviorHints.filename, 'Show.S01E02.mkv');
  assert.deepEqual(bridge.chamadas, [[IMDB, 1, 2]]);
});

test('provedor: com o ASC no ar a lista online não é substituída pela local', async () => {
  const { provider, bridge } = provedor({ fontes: [fonte] });
  const r = await provider.lookup(ep);
  assert.equal(r.offline, null);
  assert.ok(r.streams.every((s) => !/Local/.test(s.name)));
  assert.deepEqual(bridge.chamadas, []);
});

test('provedor: sem nada verificado em disco, offline continua só com o aviso', async () => {
  const { provider } = provedor({ fontes: [], falha: new AscError('Não foi possível conectar ao ASC.', 'network') });
  const r = await provider.lookup(ep);
  assert.deepEqual(r.streams, []);
  assert.equal(r.offline.kind, 'network');
});
