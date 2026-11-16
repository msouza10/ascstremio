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
  assert.ok(streams[0].description.startsWith('📦 Temporada 1 completa\n💾 Pacote: 10 GB\n▶ Este episódio: 2 GB\n'));
  assert.equal(streams[0].description.match(/💾/g).length, 1, 'o tamanho do release não aparece de novo, sem rótulo');
  assert.equal(calls.downloads.length, 0, 'listar não baixa .torrent');
});

test('lookup de série: o tipo do release vem primeiro e cada tamanho tem o seu rótulo', async (t) => {
  const { provider } = await provedor(t, {
    rows: [
      { ...row(1, 'Show S02E03 1080p'), size: 1.5 * GB },
      row(2, 'Show Completo 1080p'),
      row(3, 'Show 1080p WEB-DL'),
      row(4, 'Show 720p'),
    ],
    pages: {
      1: { files: [{ path: 'Show.S02E03.mkv', size: 1.5 * GB }], total: 1, complete: true },
      2: { files: [{ path: 'T1/Show.S02E03.mkv', size: GB }, { path: 'T1/Show.S02E04.mkv', size: GB }], total: 2, complete: true },
      3: { files: [{ path: 'T1/Show.S02E03.mkv', size: GB }, { path: 'T1/Show.S02E04.mkv', size: GB }], total: 2, complete: true },
    },
  });
  const { streams } = await provider.lookup(video(2, 3));
  const por = (id) => streams.find((s) => s.url.includes(`/e/${id}/`)).description;
  assert.ok(por(1).startsWith('📺 Episódio avulso\n💾 1,5 GB\n'), 'avulso: um tamanho só, sem rótulo de pacote');
  assert.doesNotMatch(por(1), /📦|Pacote/);
  assert.ok(por(2).startsWith('📚 Série completa\n💾 Pacote: 10 GB\n▶ Este episódio: 1 GB\n'));
  assert.ok(por(3).startsWith('📦 Pacote de episódios\n💾 Pacote: 10 GB\n▶ Este episódio: 1 GB\n'), 'sem dica no nome: o tamanho da lista de arquivos decide');
  assert.ok(por(4).startsWith('💾 Release: 10 GB\nℹ A confirmar ao tocar\n'), 'sem evidência: não chama de episódio nem de temporada');
});

test('lookup de série: as linhas de tipo e tamanho cabem no Stremio (até 26 caracteres)', async (t) => {
  const { provider } = await provedor(t, {
    rows: [row(1, 'Show S12 1080p'), row(2, 'Show S02E03'), row(3, 'Show Completo'), row(4, 'Show 720p')],
    pages: { 1: { files: [{ path: 'Show.S12E01.mkv', size: 12.5 * GB }], total: 1, complete: true } },
  });
  for (const stream of (await provider.lookup(video(12, 1))).streams) {
    const nossas = stream.description.split('\n').filter((l) => /^(📦|📚|📺|💾|▶|ℹ)/u.test(l));
    assert.ok(nossas.length > 0);
    for (const linha of nossas) assert.ok([...linha].length <= 26, `"${linha}" tem ${[...linha].length} caracteres`);
  }
});

test('lookup de série: quem não tem o episódio não ocupa vaga das 12 opções', async (t) => {
  const rows = Array.from({ length: 22 }, (_, i) => row(i + 1, `Show S01 v${i}`, 100 - i));
  const pages = Object.fromEntries(rows.slice(0, 8).map((r) => [r.id, lista('Show.S01E01.mkv')])); // as 8 lidas não têm o E05
  const { provider } = await provedor(t, { rows, pages });
  const { streams } = await provider.lookup(video(1, 5));
  assert.equal(streams.length, 12);
  const ids = streams.map((s) => Number(s.url.split('/')[4]));
  assert.ok(ids.every((id) => id > 8), 'os 8 releases sem o episódio ficaram de fora');
  assert.ok(streams.every((s) => /A confirmar ao tocar/.test(s.description)), 'os demais seguem como candidatos a confirmar ao tocar');
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

test('pack: a admissão não sobra depois que o torrent sai do motor (limpeza, seed, retenção)', () => {
  const b = ponte({ freeSpace: () => 20 * GB });
  b.entries.set(HASH, PACK);
  b.admitTorrent(HASH, 1); // cabe e fica registrado
  assert.ok(b.packFiles.get(HASH).has(1));
  // o torrent nunca ficou (ou foi destruído) e o disco encheu: tocar de novo tem que rechecar
  b.disk.measureFn = () => 1 * GB;
  assert.throws(() => b.admitTorrent(HASH, 1), (e) => e instanceof DiskRefusal && e.status === 507);
  assert.equal(b.packFiles.has(HASH), false, 'a admissão velha foi descartada');
});

test('pack ainda abrindo: o segundo episódio soma o que o primeiro prometeu', () => {
  const b = ponte({ freeSpace: () => 12 * GB });
  b.entries.set(HASH, PACK);
  b.admitTorrent(HASH, 0); // 10 GB + folga: cabe nos 12 GB
  b.loading.set(HASH, Promise.resolve()); // abrindo: sem progresso, liveRemaining é indefinido
  assert.equal(b.liveRemaining(HASH), undefined);
  assert.throws(() => b.admitTorrent(HASH, 1), (e) => e instanceof DiskRefusal && e.status === 507, '20 GB prometidos não cabem em 12 GB');
  assert.equal(b.packFiles.get(HASH).has(1), false, 'recusado não fica registrado');
});

test('getTorrent com o pack abrindo também admite o outro episódio', async () => {
  const b = ponte({ freeSpace: () => 12 * GB });
  b.entries.set(HASH, PACK);
  b.admitTorrent(HASH, 0);
  b.loading.set(HASH, Promise.resolve({}));
  await assert.rejects(b.getTorrent(HASH, { fileIdx: 1 }), (e) => e instanceof DiskRefusal);
});

test('pack: liveRemaining conta só o que os arquivos admitidos ainda vão gravar', () => {
  const b = ponte();
  b.entries.set(HASH, PACK);
  const files = PACK.files.map((f) => ({ length: f.length, downloaded: 0 }));
  files[1].downloaded = 4 * GB;
  b.client.torrents.push({ infoHash: HASH, ready: true, length: 30 * GB, progress: 0.13, files });
  assert.equal(b.liveRemaining(HASH), 0, 'nada admitido ainda: nada prometido');
  b.packFiles.set(HASH, new Map([[1, 0]]));
  assert.equal(b.liveRemaining(HASH), 6 * GB);
  b.completing.add(HASH);
  assert.equal(b.liveRemaining(HASH), Math.round(30 * GB * (1 - 0.13)), 'conclusão pedida: vale o torrent todo');
});

// Pack de 3 episódios (10 GB cada); `baixado` = bytes já gravados por arquivo.
function packAberto({ baixado = [0, 0, 0], abertos = [1], streams = 1, ...over } = {}) {
  const vault = new SeedVault({ file: path.join(tmpdir('series-bg-'), 'v.json') });
  vault.markSeen(HASH, {});
  const b = ponte({ vault, backgroundMode: 'auto', idleMs: 1000, ...over });
  b.entries.set(HASH, PACK);
  const selecoes = [];
  const files = PACK.files.map((f, i) => ({ length: f.length, downloaded: baixado[i] ?? 0, select: (p) => selecoes.push(['arquivo', i, p]) }));
  b.client.torrents.push({ infoHash: HASH, name: 'Pack', ready: true, done: false, length: 30 * GB, downloaded: GB,
    pieces: new Array(31), pieceLength: GB, progress: 0.03, files, select: (...a) => selecoes.push(['torrent', ...a.slice(0, 3)]) });
  // Posição do último GET Range: só alimenta a ORDEM da fila, nunca decide quando a conclusão começa.
  b.playbackPositions.set(b.client.torrents[0], { fileIdx: abertos.at(-1), start: 0 });
  b.startedAt.set(HASH, 0);
  b.packFiles.set(HASH, new Map(abertos.map((i) => [i, 10 * GB])));
  if (streams) b.streams.set(HASH, streams);
  return { b, vault, selecoes };
}

test('pack: com o episódio aberto ainda baixando e o player aberto, não completa o pack', () => {
  const { b, selecoes } = packAberto({ baixado: [0, 4 * GB, 0] });
  b.completionTick(1e6);
  assert.deepEqual(selecoes, []);
});

test('pack: episódio aberto inteiro em disco começa o resto do pack mesmo com o player aberto', () => {
  const { b, vault, selecoes } = packAberto({ baixado: [0, 10 * GB, 0] });
  b.completionTick(1e6);
  // Gatilho de sempre (episódio aberto inteiro); a ordem é por peças: primeiro o resto do arquivo
  // atual (peças 10-19), prioridade baixa. As etapas seguintes só entram com as peças verificadas.
  assert.deepEqual(selecoes, [['torrent', 10, 19, 0]]);
  assert.equal(vault.get(HASH).backgroundComplete, true);
  b.completionTick(2e6);
  assert.equal(selecoes.length, 1, 'não repete');
});

test('pack: abrir um episódio adiante completa os anteriores depois do atual', () => {
  const { b, selecoes } = packAberto({ baixado: [0, 0, 10 * GB], abertos: [2] });
  b.completionTick(1e6);
  assert.deepEqual(selecoes, [['torrent', 20, 29, 0]], 'começa pelo restante do episódio aberto (o 3.º)');
});

test('pack: o início da conclusão segue o gatilho de sempre; a posição só define a ordem', () => {
  // Player aberto e episódio ainda baixando: com posição conhecida, mesmo assim nada é selecionado.
  const aberto = packAberto({ baixado: [0, 4 * GB, 0] });
  aberto.b.completionTick(1e6);
  assert.deepEqual(aberto.selecoes, []);
  // Parado há mais que o limite: começa, na ordem da posição registrada (episódio 2 a partir do meio).
  const parado = packAberto({ baixado: [0, 4 * GB, 0], streams: 0 });
  parado.b.playbackPositions.set(parado.b.client.torrents[0], { fileIdx: 1, start: 5 * GB });
  parado.b.completionTick(1e6);
  assert.deepEqual(parado.selecoes, [['torrent', 15, 19, 0]], 'do ponto do seek até o fim do arquivo');
});

test('pack: sem episódio pronto e parado, a conclusão automática completa pela ociosidade', () => {
  const { b, selecoes } = packAberto({ baixado: [0, 4 * GB, 0], streams: 0 });
  b.completionTick(1e6);
  assert.equal(selecoes.length > 0, true);
});

test('pack: modo off não completa nem com o episódio pronto', () => {
  const { b, selecoes } = packAberto({ baixado: [0, 10 * GB, 0], backgroundMode: 'off' });
  b.completionTick(1e6);
  assert.deepEqual(selecoes, []);
});

test('pack: o usuário pedindo a conclusão do torrent continua valendo', () => {
  const { b, vault, selecoes } = packAberto({ baixado: [0, 4 * GB, 0], backgroundMode: 'off' });
  vault.setBackground(HASH, true);
  b.completionTick(1e6);
  assert.equal(selecoes.length > 0, true);
});

test('snapshot: pack mostra os episódios com o que há em disco; filme não ganha o campo', async () => {
  const b = ponte();
  b.entries.set(HASH, { ...PACK, name: 'Pack', title: 'Pack' });
  b.client.torrents.push({ infoHash: HASH, name: 'Pack', ready: true, done: false, length: 30 * GB, downloaded: 13 * GB, progress: 0.43,
    files: PACK.files.map((f, i) => ({ length: f.length, downloaded: [10 * GB, 3 * GB, 0, 0][i] })) });
  const item = b.snapshot().titles.find((t) => t.infoHash === HASH);
  assert.deepEqual(item.episodes.map((e) => [e.season, e.episode, e.state, e.verified]),
    [[1, 1, 'completo', true], [1, 2, 'parcial', true], [1, 3, 'ausente', true]]);
  assert.equal(item.episodes[1].onDisk, 3 * GB);
  assert.equal(item.episodes[0].length, 10 * GB);

  const filme = '1'.repeat(40);
  b.entries.set(filme, { infoHash: filme, name: 'Filme', title: 'Filme', files: [{ index: 0, path: 'F/F.mkv', length: 5 * GB, isVideo: true }] });
  assert.equal('episodes' in b.snapshot().titles.find((t) => t.infoHash === filme), false);
});

test('snapshot: pack fora do motor mostra o disco como não verificado', () => {
  const b = ponte();
  b.entries.set(HASH, { ...PACK, name: 'Pack', title: 'Pack' });
  const item = b.snapshot().titles.find((t) => t.infoHash === HASH);
  assert.equal(item.episodes.length, 3);
  assert.equal(item.episodes.every((e) => e.verified === false && e.state === 'ausente'), true);
});

// --- Obrigação de seed é do TORRENT: concluir só o arquivo de um episódio nunca a abre nem a quita ---
// (#88: "Nenhum contador de 72 h por episódio"; regra 13.1 vale depois de concluir o download inteiro.)

// Torrent de pack simulado no motor. `baixado` = bytes gravados por arquivo.
function packNoMotor({ baixado }) {
  const vault = new SeedVault({ file: path.join(tmpdir('series-obr-'), 'v.json') });
  vault.markSeen(HASH, { name: 'Pack' });
  const b = ponte({ vault, backgroundMode: 'auto', idleMs: 1000 });
  b.entries.set(HASH, { ...PACK, name: 'Pack', title: 'Pack' });
  const torrent = Object.assign(new EventEmitter(), {
    infoHash: HASH, name: 'Pack', ready: true, done: false, length: 30 * GB, downloaded: baixado.reduce((a, n) => a + n, 0), progress: 0.34,
    pieces: new Array(10), select() {},
    files: PACK.files.map((f, i) => ({ length: f.length, downloaded: baixado[i] ?? 0, select() {} })),
  });
  b.client.torrents.push(torrent);
  b.startedAt.set(HASH, 0);
  b.packFiles.set(HASH, new Map([[0, 10 * GB]]));
  return { b, vault, torrent };
}

test('episódio inteiro em disco com o torrent incompleto: sem conclusão, sem obrigação e sem horas de seed', () => {
  const { b, vault, torrent } = packNoMotor({ baixado: [10 * GB, 0, 0, 0] });
  const s = b.seedState(torrent);
  assert.equal(s.concluded, false);
  assert.equal(s.obligation, false);
  assert.equal(s.met, true, 'nada a cumprir enquanto o torrent não conclui');
  assert.equal(s.hoursSeeding, 0);
  // a contagem de seed (a mesma do relógio de 1 min) ignora um torrent sem conclusão
  vault.addSeedingTime(HASH, 5 * 3_600_000);
  assert.equal(vault.get(HASH).seedMs, 0, 'nenhum contador de 72 h por episódio');
  assert.equal(vault.get(HASH).satisfiedAt ?? null, null);
});

test('a conclusão automática do pack, mesmo começando com o episódio pronto, não marca o torrent como concluído', () => {
  const { b, vault } = packNoMotor({ baixado: [10 * GB, 0, 0, 0] });
  b.completionTick(1e6);
  assert.equal(vault.get(HASH).backgroundComplete, true, 'o resto do pack começou a baixar');
  assert.equal(vault.get(HASH).completedAt ?? null, null, 'baixar o resto não é concluir');
  assert.equal(vault.get(HASH).satisfiedAt ?? null, null);
  assert.equal(b.seedState({ infoHash: HASH, done: false, downloaded: 10 * GB, progress: 0.34 }).obligation, false);
});

test('abrir o torrent para tocar um episódio já inteiro não abre a obrigação; só o torrent concluir abre', async () => {
  const { b, vault, torrent } = packNoMotor({ baixado: [10 * GB, 0, 0, 0] });
  b.client.torrents.splice(0); // não está no motor: getTorrent abre de verdade
  b.client.get = async () => null;
  b.client.add = (source, options, ready) => {
    b.client.torrents.push(torrent);
    queueMicrotask(() => ready(torrent));
    return torrent;
  };
  await b.getTorrent(HASH, { fileIdx: 0 });
  assert.equal(vault.get(HASH).completedAt ?? null, null, 'episódio pronto não conclui o torrent');
  assert.equal(b.seedState(torrent).obligation, false);
  // controle positivo: o torrent inteiro concluindo abre a obrigação do torrent (uma só)
  torrent.done = true; torrent.progress = 1;
  for (const f of torrent.files) f.downloaded = f.length;
  torrent.emit('done');
  assert.ok(vault.get(HASH).completedAt, 'a obrigação nasce na conclusão do torrent');
  assert.equal(b.seedState(torrent).obligation, true);
  vault.addSeedingTime(HASH, 3_600_000);
  assert.equal(vault.get(HASH).seedMs, 3_600_000, 'agora o seed conta, para o torrent inteiro');
});

test('o painel não mostra obrigação nem horas por episódio, só a do torrent', () => {
  const { b } = packNoMotor({ baixado: [10 * GB, 10 * GB, 0, 0] });
  const item = b.snapshot().titles.find((t) => t.infoHash === HASH);
  assert.equal(item.episodes.length, 3);
  for (const e of item.episodes) {
    assert.deepEqual(Object.keys(e).filter((k) => /seed|hora|hour|obrig|deadline|prazo|tracker/i.test(k)), [], `episódio ${e.episode} sem campo de obrigação`);
  }
  assert.equal(item.state === 'done' || item.state === 'seeding', false, 'torrent incompleto não aparece como semeando nem cumprido');
  assert.equal(item.seededHours, 0);
});

test('o tracker dizendo "baixando" (parcial) nunca vira obrigação cumprida por ter um episódio completo', () => {
  const { b, vault, torrent } = packNoMotor({ baixado: [10 * GB, 10 * GB, 10 * GB, 0] });
  vault.setTracker(HASH, { status: 'downloading', satisfied: false, hitAndRun: false, completedAtMs: null, remainingMs: 72 * 3_600_000, deadlineMs: Date.now() + 86_400_000 });
  const s = b.seedState(torrent);
  assert.equal(s.concluded, false, 'todos os episódios prontos, mas o torrent não concluiu (falta o banner)');
  assert.equal(s.tracker.satisfied, false);
  assert.equal(vault.get(HASH).satisfiedAt ?? null, null);
});

test('GET com Range reorganiza a conclusão ao começar no meio e ao fazer seek', async () => {
  const { b, vault, selecoes } = packAberto({ streams: 0 });
  b.completing.add(HASH); // conclusão já ativa pelas regras de sempre: o GET só reordena a fila
  vault.setBackground(HASH, true);
  const torrent = b.client.torrents[0];
  torrent.files = [0, 1, 2].map((i) => video3(i, Buffer.from('0123456789')));
  torrent.files.push({ length: 1, path: 'capa.jpg' });
  torrent.pieces = new Array(31);
  torrent.pieceLength = 1;
  torrent.length = 31;
  torrent.downloaded = 0;
  b.getTorrent = async () => torrent;
  const removed = [];
  torrent.deselect = (...args) => removed.push(args);
  for (const [range, expected] of [['bytes=6-9', 16], ['bytes=2-5', 12]]) {
    const res = resposta();
    await b.handle(pedido('GET', `/s/${HASH}/1`, { range }), res);
    assert.equal(res.statusCode, 206);
    assert.equal(selecoes.at(-1)[1], expected, 'a fila acompanha a nova posição');
    assert.equal(selecoes.at(-1)[2], 19, 'busca o restante do arquivo mesmo com Range curto');
  }
  assert.equal(removed.length, 2, 'substitui as seleções de fundo, sem acumular a posição anterior');
  assert.equal(vault.get(HASH).backgroundComplete, true);
  assert.equal(b.streams.get(HASH), 0);
});

async function getComPack(ctx) {
  const torrent = ctx.b.client.torrents[0];
  torrent.files = [0, 1, 2].map((i) => video3(i, Buffer.from('0123456789')));
  torrent.pieces = new Array(30);
  torrent.pieceLength = 1;
  // `completos`: o episódio aberto já está inteiro em disco, o gatilho que liberaria a conclusão de um pack.
  if (ctx.completos) for (const f of torrent.files) f.downloaded = f.length;
  ctx.b.getTorrent = async () => torrent;
  const res = resposta();
  await ctx.b.handle(pedido('GET', `/s/${HASH}/1`, { range: 'bytes=2-5' }), res);
  return res;
}


test('GET de vídeo registra a posição, mas não inicia a conclusão automática', async () => {
  const ctx = packAberto({ streams: 0 });
  // Episódio aberto inteiro (gatilho que liberaria a conclusão de um pack): só o timer
  // (completionTick) decide quando começar; o GET não.
  ctx.completos = true;
  const res = await getComPack(ctx);
  assert.equal(res.statusCode, 206);
  assert.deepEqual(ctx.selecoes, []);
  assert.equal(ctx.b.completing.has(HASH), false);
  assert.ok(!ctx.vault.get(HASH).backgroundComplete);
  assert.deepEqual(ctx.b.playbackPositions.get(ctx.b.client.torrents[0]), { fileIdx: 1, start: 2 });
});

test('falha ao reorganizar a conclusão não derruba a reprodução nem o timer', async () => {
  const ctx = packAberto({ streams: 0 });
  const torrent = ctx.b.client.torrents[0];
  ctx.b.completing.add(HASH);
  // Seleção de peças recusada pelo motor (por exemplo, torrent destruído no meio do pedido).
  torrent.select = () => { throw new Error('invalid selection'); };
  const res = await getComPack(ctx);
  assert.equal(res.statusCode, 206, 'a conclusão é otimização: o vídeo continua');
  // O timer de 30 s também não pode lançar: uma exceção ali encerra o processo inteiro.
  ctx.b.completing.delete(HASH);
  assert.doesNotThrow(() => ctx.b.completionTick());
  assert.equal(ctx.b.completing.has(HASH), false, 'sem seleção feita, a conclusão não é dada como ativa');
});
