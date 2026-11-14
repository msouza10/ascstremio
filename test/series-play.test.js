const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createAscProvider } = require('../src/asc-provider');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const { DiskRefusal } = require('../src/disk-policy');
const { tmpdir } = require('./tmp-helper');

const GB = 1024 ** 3;
const MIB = 1024 * 1024;
const HASH = '2'.padStart(40, 'b');

// ---- Provedor: lookup de série e resolução de episódio ---------------------------------------------

const row = (id, name, seeders = 10) => ({ id, name, seeders, freeleech: true, size: 10 * GB, badges: [{ label: '1080p', kind: 'resolution' }] });
const lista = (...paths) => ({ files: paths.map((p) => ({ path: p, size: GB })), total: paths.length, complete: true });

// `torrents[id]` = arquivos do .torrent de verdade (ordem real, diferente da página do site).
async function provedor(t, { rows = [], pages = {}, torrents = {}, searchError = null } = {}) {
  const dir = tmpdir('series-play-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = { downloads: [], searches: 0 };
  const asc = {
    onlyFreeleech: false,
    connected: true,
    async searchSeries() {
      calls.searches += 1;
      if (searchError) throw searchError;
      return { rows, truncated: false };
    },
    async releaseFiles(id) { return pages[id] ?? { files: [], total: null, complete: false }; },
    async download(id) { calls.downloads.push(String(id)); await new Promise((r) => setTimeout(r, 10)); return Buffer.from(String(id)); },
  };
  const bridge = {
    entries: new Map(),
    vault: { get: () => null },
    lazyUrl: (id) => `http://x/a/${id}`,
    episodeUrl: (id, s, e) => `http://x/e/${id}/${s}/${e}`,
    diskState: () => 'none',
    entryByAscId(id) { return [...this.entries.values()].find((e) => path.basename(String(e.torrentPath)) === `asc-${id}.torrent`) ?? null; },
  };
  const provider = createAscProvider(asc, bridge, dir, {
    async readTorrentImpl(file) {
      const id = /asc-(\d+)\.torrent$/.exec(file)[1];
      const files = (torrents[id] ?? []).map((f, index) => ({ index, isVideo: /\.(mkv|mp4)$/.test(f.path), ...f }));
      return { infoHash: id.padStart(40, 'c'), torrentPath: file, files };
    },
  });
  return { provider, bridge, calls };
}
const video = (season, episode) => ({ type: 'series', imdbId: 'tt0903747', season, episode });
const arq = (p, length = GB) => ({ path: p, length });

test('lookup de série oferece /e/<id>/<T>/<E> com o tamanho do episódio e o grupo do release', async (t) => {
  const { provider, calls } = await provedor(t, {
    rows: [row(5, 'Show S01 1080p')],
    pages: { 5: { files: [{ path: 'Show.S01E02.mkv', size: 2 * GB }, { path: 'Show.S01E01.mkv', size: GB }], total: 2, complete: true } },
  });
  const { streams, offline } = await provider.lookup(video(1, 2));
  assert.equal(offline, null);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'http://x/e/5/1/2');
  assert.equal(streams[0].behaviorHints.bingeGroup, 'asc-5');
  assert.equal(streams[0].behaviorHints.filename, 'Show.S01E02.mkv');
  assert.match(streams[0].description, /S01E02 · 💾 este episódio: 2 GB/);
  assert.match(streams[0].description, /📦 Temporada 1 completa: 10 GB \(tamanho do pacote inteiro, não só deste episódio\)/);
  assert.equal(streams[0].description.match(/💾/g).length, 1, 'o tamanho do release não aparece de novo, sem rótulo');
  assert.equal(calls.downloads.length, 0, 'listar não baixa .torrent');
});

test('lookup de série: episódio avulso não ganha rótulo de pacote; pack sem escopo no nome ganha', async (t) => {
  const { provider } = await provedor(t, {
    rows: [{ ...row(1, 'Show S02E03 1080p'), size: 1.5 * GB }, row(2, 'Show Completo 1080p')],
    pages: {
      1: { files: [{ path: 'Show.S02E03.mkv', size: 1.5 * GB }], total: 1, complete: true },
      2: { files: [{ path: 'T1/Show.S02E03.mkv', size: GB }, { path: 'T1/Show.S02E04.mkv', size: GB }], total: 2, complete: true },
    },
  });
  const { streams } = await provider.lookup(video(2, 3));
  const por = (id) => streams.find((s) => s.url.includes(`/e/${id}/`)).description;
  assert.doesNotMatch(por(1), /📦/);
  assert.match(por(1), /💾 1,5 GB/);
  assert.match(por(2), /📦 Pacote completo: 10 GB \(tamanho do pacote inteiro, não só deste episódio\)/);
  assert.match(por(2), /este episódio: 1 GB/);
});

test('lookup de série: quem não tem o episódio não ocupa vaga das 12 opções', async (t) => {
  const rows = Array.from({ length: 22 }, (_, i) => row(i + 1, `Show S01 v${i}`, 100 - i));
  const pages = Object.fromEntries(rows.slice(0, 8).map((r) => [r.id, lista('Show.S01E01.mkv')])); // as 8 lidas não têm o E05
  const { provider } = await provedor(t, { rows, pages });
  const { streams } = await provider.lookup(video(1, 5));
  assert.equal(streams.length, 12);
  const ids = streams.map((s) => Number(s.url.split('/')[4]));
  assert.ok(ids.every((id) => id > 8), 'os 8 releases sem o episódio ficaram de fora');
  assert.ok(streams.every((s) => /não confirmado/.test(s.description)), 'os demais seguem como candidatos a confirmar ao tocar');
});

test('lookup de série com o ASC fora do ar: lista vazia e o motivo, sem lançar', async (t) => {
  const { provider } = await provedor(t, { searchError: Object.assign(new Error('sem rede'), { kind: 'network' }) });
  const result = await provider.lookup(video(1, 1));
  assert.deepEqual(result.streams, []);
  assert.equal(result.offline.kind, 'network');
});

test('resolveEpisode: dois episódios do mesmo pack baixam o .torrent uma vez e usam o índice REAL', async (t) => {
  const { provider, bridge, calls } = await provedor(t, {
    rows: [row(5, 'Show S01')],
    pages: { 5: lista('Show.S01E01.mkv', 'Show.S01E02.mkv', 'Show.S01E03.mkv') },
    // no torrent a ordem é outra: o índice 0 é o E03
    torrents: { 5: [arq('Show/Show.S01E03.mkv'), arq('Show/banner.jpg', 1000), arq('Show/Show.S01E01.mkv'), arq('Show/Show.S01E02.mkv')] },
  });
  await provider.lookup(video(1, 1)); // a listagem registra o que o site mostrou
  const [um, dois] = await Promise.all([provider.resolveEpisode('5', 1, 1), provider.resolveEpisode('5', 1, 2)]);
  const hash = '5'.padStart(40, 'c');
  assert.deepEqual(um, { infoHash: hash, fileIdx: 2 });
  assert.deepEqual(dois, { infoHash: hash, fileIdx: 3 });
  assert.deepEqual(calls.downloads, ['5'], 'um download só para os dois episódios');
  assert.ok(bridge.entries.has(hash), 'registrado na biblioteca para a ponte abrir');
});

test('resolveEpisode: episódio ausente não marca o pack como incompatível', async (t) => {
  const { provider } = await provedor(t, {
    torrents: { 7: [arq('Show.S01E01.mkv'), arq('Show.S01E02.mkv')] },
  });
  await assert.rejects(provider.resolveEpisode('7', 1, 9), (e) => e.status === 404 && /S01E09/.test(e.message));
  // o outro episódio do mesmo release continua tocável
  assert.equal((await provider.resolveEpisode('7', 1, 2)).fileIdx, 1);
  // e o filme (/a/) nesse release segue recusado, porque é pack
  await assert.rejects(provider.resolve('7'), (e) => e.status === 422);
});

test('resolveEpisode: dois arquivos para o mesmo episódio é ambíguo (422)', async (t) => {
  const { provider } = await provedor(t, { torrents: { 8: [arq('Show.S01E01.1080p.mkv'), arq('Show.S01E01.720p.mkv')] } });
  await assert.rejects(provider.resolveEpisode('8', 1, 1), (e) => e.status === 422 && /mais de um arquivo/.test(e.message));
});

test('resolveEpisode: arquivo do .torrent que não confere com a lista do site é recusado (409)', async (t) => {
  const { provider } = await provedor(t, {
    rows: [row(9, 'Show S01')],
    pages: { 9: { files: [{ path: 'Show.S01E01.mkv', size: 5 * GB }], total: 1, complete: true } },
    torrents: { 9: [arq('Show/Show.S01E01.mkv', GB)] }, // tamanho diferente do que o site mostrou
  });
  await provider.lookup(video(1, 1));
  await assert.rejects(provider.resolveEpisode('9', 1, 1), (e) => e.status === 409 && /não confere/.test(e.message));
});

test('resolveEpisode: sem seeders recusa antes de baixar o .torrent (503); entradas inválidas dão 400', async (t) => {
  const { provider, calls } = await provedor(t, {
    rows: [row(4, 'Show S01', 0)],
    pages: { 4: lista('Show.S01E01.mkv') },
    torrents: { 4: [arq('Show.S01E01.mkv')] },
  });
  await provider.lookup(video(1, 1));
  await assert.rejects(provider.resolveEpisode('4', 1, 1), (e) => e.status === 503);
  assert.equal(calls.downloads.length, 0);
  for (const [id, s, e] of [['x', 1, 1], ['4', -1, 1], ['4', 100, 1], ['4', 1, 0], ['4', 1.5, 1], ['4', 1, 10000]]) {
    await assert.rejects(provider.resolveEpisode(id, s, e), (err) => err.status === 400, `${id}/${s}/${e}`);
  }
});

test('resolveEpisode: com o .torrent já local não baixa de novo', async (t) => {
  const { provider, bridge, calls } = await provedor(t);
  bridge.entries.set(HASH, { infoHash: HASH, torrentPath: '/x/asc-3.torrent', files: [
    { index: 0, path: 'S/S.S02E02.mkv', length: GB, isVideo: true }, { index: 1, path: 'S/S.S02E01.mkv', length: GB, isVideo: true }] });
  assert.deepEqual(await provider.resolveEpisode('3', 2, 1), { infoHash: HASH, fileIdx: 1 });
  assert.equal(calls.downloads.length, 0);
});

// ---- Ponte: rota /e/ -------------------------------------------------------------------------------

const LOCAL = { remoteAddress: '127.0.0.1' };
const store = new CredentialStore({ file: path.join(tmpdir('series-cred-'), 'credentials.json') });
const { token: TOKEN } = store.create({ name: 'teste' });

function ponte(over = {}) {
  const dir = tmpdir('series-store-');
  const b = new Bridge({ torrentDir: '/tmp', storeDir: dir, port: 7096, publicUrl: 'http://127.0.0.1:7010/', credentials: store,
    vault: new SeedVault({ file: path.join(tmpdir('series-v-'), 'v.json') }), minFreeBytes: 1000, freeSpace: () => 1e12, ...over });
  b.client = { torrents: [] };
  return b;
}
function resposta() {
  const r = new EventEmitter();
  Object.assign(r, { statusCode: 0, headers: {}, chunks: [], ended: false, headersSent: false, writableFinished: false, writableEnded: false, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); this.headersSent = true; },
    write(c) { this.chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) this.chunks.push(Buffer.from(c)); this.ended = true; this.writableEnded = true; this.writableFinished = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); } });
  return r;
}
const pedido = (method, url, headers = {}) => ({ method, url: `${url}?k=${TOKEN}`, headers, socket: LOCAL });
const corpo = (res) => Buffer.concat(res.chunks).toString();
const video3 = (i, bytes) => ({ length: bytes.length, path: `S/S.S01E0${i + 1}.mkv`, downloaded: 0, createReadStream: ({ start, end }) => Readable.from([bytes.subarray(start, end + 1)]) });

test('/e/ exige a credencial como /a/ e /s/', async () => {
  const b = ponte();
  b.ascEpisodeResolver = async () => { throw new Error('não devia resolver'); };
  const res = resposta();
  await b.handle({ method: 'GET', url: '/e/1/1/2', headers: {}, socket: LOCAL }, res);
  assert.equal(res.statusCode, 403);
});

test('/e/ malformada dá 404 sem resolver', async () => {
  const b = ponte();
  b.ascEpisodeResolver = async () => { throw new Error('não devia resolver'); };
  for (const ruim of ['/e/1/1/0', '/e/1/1', '/e/abc/1/1', '/e/1/100/1', '/e/1/1/10000', '/e/1/1/2/3', '/e/1/-1/2']) {
    const res = resposta();
    await b.handle(pedido('GET', ruim), res);
    assert.equal(res.statusCode, 404, ruim);
  }
});

test('GET em /e/ resolve o episódio uma vez e serve o arquivo escolhido com Range', async () => {
  const b = ponte();
  const arquivos = [video3(0, Buffer.from('AAAAAAAAAA')), video3(1, Buffer.from('0123456789')), video3(2, Buffer.from('ZZZZZZZZZZ'))];
  const visto = [];
  b.ascEpisodeResolver = async (id, s, e) => { visto.push([id, s, e]); return { infoHash: HASH, fileIdx: 1 }; };
  b.getTorrent = async (h, opts) => { assert.equal(h, HASH); assert.equal(opts.fileIdx, 1); return { ready: true, numPeers: 2, progress: 0, files: arquivos }; };
  const res = resposta();
  await b.handle(pedido('GET', '/e/12/1/2', { range: 'bytes=2-5' }), res);
  assert.deepEqual(visto, [['12', 1, 2]]);
  assert.equal(res.statusCode, 206);
  assert.equal(corpo(res), '2345');
});

test('HEAD em /e/ sem .torrent local não resolve, não baixa nem abre torrent', async () => {
  const b = ponte();
  b.ascEpisodeResolver = async () => { throw new Error('HEAD não baixa'); };
  b.getTorrent = async () => { throw new Error('HEAD não abre'); };
  const res = resposta();
  await b.handle(pedido('HEAD', '/e/12/1/2'), res);
  assert.equal(res.statusCode, 200);
});

test('/e/ sem resolvedor de episódio responde 501', async () => {
  const b = ponte();
  const res = resposta();
  await b.handle(pedido('GET', '/e/12/1/2'), res);
  assert.equal(res.statusCode, 501);
});

test('erro do resolvedor de episódio vira resposta HTTP clara, sem abrir torrent', async () => {
  const b = ponte();
  let aberto = 0;
  b.ascEpisodeResolver = async () => { throw Object.assign(new Error('Este release não traz o episódio S01E09'), { status: 404 }); };
  b.getTorrent = async () => { aberto += 1; };
  const res = resposta();
  await b.handle(pedido('GET', '/e/12/1/9'), res);
  assert.equal(res.statusCode, 404);
  assert.match(JSON.parse(corpo(res)).error, /S01E09/);
  assert.equal(aberto, 0);
});

test('/e/ com o .torrent local escolhe o episódio pelo índice real, sem chamar o resolvedor', async () => {
  const b = ponte();
  b.entries.set(HASH, { infoHash: HASH, torrentPath: '/x/asc-12.torrent', files: [
    { index: 0, path: 'S/S.S01E03.mkv', length: 10, isVideo: true },
    { index: 1, path: 'S/S.S01E01.mkv', length: 10, isVideo: true },
    { index: 2, path: 'S/S.S01E02.mkv', length: 10, isVideo: true }] });
  b.ascEpisodeResolver = async () => { throw new Error('não devia baixar de novo'); };
  const arquivos = [video3(0, Buffer.from('3333333333')), video3(1, Buffer.from('1111111111')), video3(2, Buffer.from('2222222222'))];
  b.getTorrent = async () => ({ ready: true, numPeers: 2, progress: 0, files: arquivos });
  const res = resposta();
  await b.handle(pedido('GET', '/e/12/1/2'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(corpo(res), '2222222222');
  assert.equal(b.lazyFile(b.entries.get(HASH), { season: 1, episode: 9 }), null);
});

test('episodeUrl leva o episódio na rota /e/', () => {
  const b = ponte();
  assert.equal(b.episodeUrl(12, 1, 2), 'http://127.0.0.1:7010/e/12/1/2');
});

// ---- Ponte: disco e conclusão em pack --------------------------------------------------------------

const PACK = { infoHash: HASH, freeleech: true, files: [
  { index: 0, path: 'P/P.S01E01.mkv', length: 10 * GB, isVideo: true },
  { index: 1, path: 'P/P.S01E02.mkv', length: 10 * GB, isVideo: true },
  { index: 2, path: 'P/P.S01E03.mkv', length: 10 * GB, isVideo: true },
  { index: 3, path: 'P/banner.jpg', length: 1000, isVideo: false }] };

test('pack: a reserva é do arquivo escolhido mais a folga das peças, não do pack inteiro', () => {
  const b = ponte();
  b.entries.set(HASH, PACK);
  assert.equal(b.neededBytes(HASH), 30 * GB + 1000, 'sem arquivo: o torrent inteiro, como antes');
  assert.equal(b.neededBytes(HASH, 1), 10 * GB + 16 * MIB);
});

test('filme com extras continua reservando o torrent inteiro mesmo com fileIdx', () => {
  const b = ponte();
  b.entries.set(HASH, { infoHash: HASH, files: [
    { index: 0, path: 'F.mkv', length: 6 * GB, isVideo: true }, { index: 1, path: 'Making of.mkv', length: 0.07 * GB, isVideo: true }] });
  assert.equal(b.neededBytes(HASH, 0), b.neededBytes(HASH));
});

test('pack: um episódio cabe mesmo quando o pack inteiro não cabe', () => {
  const b = ponte({ freeSpace: () => 20 * GB });
  b.entries.set(HASH, PACK);
  assert.throws(() => b.admitTorrent(HASH), (e) => e instanceof DiskRefusal && e.status === 507, 'o pack todo não cabe');
  b.admitTorrent(HASH, 1); // um episódio cabe
  assert.ok(b.packFiles.get(HASH).has(1));
});

test('pack já aberto: outro episódio paga a própria reserva; o mesmo arquivo não paga de novo', () => {
  const b = ponte({ freeSpace: () => 12 * GB });
  b.entries.set(HASH, PACK);
  b.client.torrents.push({ infoHash: HASH, ready: true, length: 30 * GB, progress: 0, files: PACK.files.map((f) => ({ length: f.length, downloaded: 0 })) });
  b.admitTorrent(HASH, 0);
  b.admitTorrent(HASH, 0); // Range e seek no mesmo episódio: sem custo novo
  assert.throws(() => b.admitTorrent(HASH, 1), (e) => e instanceof DiskRefusal, 'o segundo episódio não cabe nos 12 GB');
  assert.equal(b.packFiles.get(HASH).has(1), false, 'recusado não fica registrado');
});

test('pack: liveRemaining conta só o que os arquivos admitidos ainda vão gravar', () => {
  const b = ponte();
  b.entries.set(HASH, PACK);
  const files = PACK.files.map((f) => ({ length: f.length, downloaded: 0 }));
  files[1].downloaded = 4 * GB;
  b.client.torrents.push({ infoHash: HASH, ready: true, length: 30 * GB, progress: 0.13, files });
  assert.equal(b.liveRemaining(HASH), 0, 'nada admitido ainda: nada prometido');
  b.packFiles.set(HASH, new Set([1]));
  assert.equal(b.liveRemaining(HASH), 6 * GB);
  b.completing.add(HASH);
  assert.equal(b.liveRemaining(HASH), Math.round(30 * GB * (1 - 0.13)), 'conclusão pedida: vale o torrent todo');
});

test('pack: a conclusão automática não completa o pack depois de um episódio', () => {
  const vault = new SeedVault({ file: path.join(tmpdir('series-bg-'), 'v.json') });
  vault.markSeen(HASH, {});
  const b = ponte({ vault, backgroundMode: 'auto', idleMs: 1000 });
  b.entries.set(HASH, PACK);
  const selecoes = [];
  b.client.torrents.push({ infoHash: HASH, name: 'Pack', ready: true, done: false, length: 30 * GB, downloaded: GB, pieces: new Array(10), progress: 0.03, select: (...a) => selecoes.push(a) });
  b.startedAt.set(HASH, 0);
  b.completionTick(1e6);
  assert.deepEqual(selecoes, [], 'pack freeleech parado não é completado sozinho');
  // o usuário pedindo a conclusão do torrent continua valendo
  vault.setBackground(HASH, true);
  b.completionTick(1e6);
  assert.equal(selecoes.length, 1);
});
