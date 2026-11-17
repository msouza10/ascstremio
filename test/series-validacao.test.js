// Validação automatizada da etapa 5 de séries (#90): o que a auditoria achou sem teste direto.
// Tudo simulado: nada de rede, de `private/` ou de .torrent real. A matriz item a item está na
// descrição do PR; aqui ficam só as lacunas (caminhos do Windows, S00/duplo/repetido pelo provedor
// e pela rota, dois episódios simultâneos pela ponte e a ausência de credencial nos logs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { parseEpisode, buildEpisodeIndex, findEpisode } = require('../src/episodes');
const { createAscProvider } = require('../src/asc-provider');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const { logger } = require('../src/logger');
const { tmpdir } = require('./tmp-helper');

const HASH = '3'.padStart(40, 'd');
const KIB16 = 16 * 1024; // arquivos de fixture pequenos: o que importa são nomes e índices

// ---- Nomes: caminhos do Windows e etiquetas de release ---------------------------------------------

test('caminho do Windows (barra invertida) conta como pasta de temporada, igual ao do Linux', () => {
  // O ASC é um site e o .torrent usa "/", mas o caminho pode chegar do disco do Windows com "\".
  const win = parseEpisode('Show\\Temporada 02\\Show.S02E03.mkv');
  assert.deepEqual(win, parseEpisode('Show/Temporada 02/Show.S02E03.mkv'));
  assert.equal(win.confidence, 'alta', 'a pasta de temporada foi reconhecida');
  // pasta e arquivo discordando continua recusado, também com "\" e com separadores misturados
  assert.equal(parseEpisode('Show\\Temporada 01\\Show.S02E03.mkv'), null);
  assert.equal(parseEpisode('Show/Season 01\\Show.S02E03.mkv'), null);
});

test('etiquetas de release (MiXED, caixa mista) não confundem o episódio', () => {
  for (const nome of ['Show.s01e04.MiXED.1080p.mkv', 'SHOW.S01E04.MiXED.mkv', 'Show S01e04 [MiXED].mkv']) {
    const id = parseEpisode(nome);
    assert.ok(id, nome);
    assert.deepEqual([id.season, id.episode, id.episodeEnd], [1, 4, undefined], nome);
  }
});

// ---- Provedor: S00, duplo, número repetido, auxiliares, ordem real ---------------------------------

const arq = (p, length = KIB16) => ({ path: p, length });
const row = (id) => ({ id, name: 'Show', seeders: 5, freeleech: true, size: 1, badges: [] });

async function provedor(t, { torrents = {}, rows = [], pages = {} } = {}) {
  const dir = tmpdir('series-valid-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = { downloads: [], searches: 0 };
  const asc = {
    onlyFreeleech: false,
    connected: true,
    async searchSeries() { calls.searches += 1; return { rows, truncated: false }; },
    async releaseFiles(id) { return pages[id] ?? { files: [], total: null, complete: false }; },
    async download(id) { calls.downloads.push(String(id)); return Buffer.from(String(id)); },
  };
  const bridge = {
    entries: new Map(),
    vault: { get: () => null },
    lazyUrl: (id) => `http://x/a/${id}`,
    episodeUrl: (id, s, e) => `http://x/e/${id}/${s}/${e}`,
    diskState: () => 'none',
    entryByAscId: () => null,
  };
  const provider = createAscProvider(asc, bridge, dir, {
    async readTorrentImpl(file) {
      const id = /asc-(\d+)\.torrent$/.exec(file)[1];
      const files = (torrents[id] ?? []).map((f, index) => ({ index, isVideo: /\.(mkv|mp4)$/.test(f.path), ...f }));
      return { infoHash: id.padStart(40, 'c'), torrentPath: file, files };
    },
  });
  return { provider, calls };
}

// Pack "legado" misturado: a ordem do torrent não é a da temporada e há S00, duplo, S02E01 repetido,
// um nome ambíguo (dois SxxExx), um arquivo sem identidade e auxiliares.
const PACK_MISTO = [
  arq('Show/Show.S02E01.mkv'), // 0: o número 1 repetido na temporada 2
  arq('Show/cover.jpg'), // 1: auxiliar
  arq('Show/Show.S01E03.mkv'), // 2
  arq('Show/Specials/Show.S00E01.Pilot.Extendido.mkv'), // 3: especial
  arq('Show/Show.S01E01-E02.MiXED.mkv'), // 4: duplo
  arq('Show/Show.S01E04E05.Resumo.mkv'), // 5: duplo colado (E04E05)
  arq('Show/Show.S01E06.S01E07.mkv'), // 6: dois SxxExx no nome: ambíguo, recusado
  arq('Show/Show.nfo', 100), // 7: auxiliar
  arq('Show/Extras.mkv'), // 8: sem identidade
];

test('resolveEpisode: S00, duplo e número repetido entre temporadas resolvem o índice REAL do torrent', async (t) => {
  const { provider, calls } = await provedor(t, { torrents: { 11: PACK_MISTO } });
  const hash = '11'.padStart(40, 'c');
  const quer = async (s, e) => provider.resolveEpisode('11', s, e);
  assert.deepEqual(await quer(0, 1), { infoHash: hash, fileIdx: 3 }, 'S00 (especiais) é temporada válida');
  assert.deepEqual(await quer(1, 1), { infoHash: hash, fileIdx: 4 }, 'duplo atende o primeiro número');
  assert.deepEqual(await quer(1, 2), { infoHash: hash, fileIdx: 4 }, 'e o segundo, com o mesmo arquivo');
  assert.deepEqual(await quer(1, 3), { infoHash: hash, fileIdx: 2 });
  assert.deepEqual(await quer(2, 1), { infoHash: hash, fileIdx: 0 }, 'E01 da temporada 2 não é o E01 da 1');
  assert.deepEqual(await quer(1, 5), { infoHash: hash, fileIdx: 5 });
  // sem identidade segura: nada de adivinhar
  for (const [s, e] of [[1, 6], [1, 7], [3, 1], [0, 2]]) {
    await assert.rejects(quer(s, e), (err) => err.status === 404, `S${s}E${e}`);
  }
  assert.deepEqual(calls.downloads, ['11'], 'um .torrent só para todas as perguntas');
});

test('buildEpisodeIndex: auxiliares e sem identidade ficam fora dos episódios, em qualquer ordem', () => {
  const files = PACK_MISTO.map((f, index) => ({ index, isVideo: /\.mkv$/.test(f.path), ...f }));
  const idx = buildEpisodeIndex(files);
  assert.deepEqual(idx.auxiliary, [1, 7]);
  assert.deepEqual(idx.unmatched, [6, 8]);
  assert.deepEqual(idx.conflicts, []);
  assert.equal(findEpisode(idx, 0, 1).file.index, 3);
});

// ---- Ponte: rota /e/ -------------------------------------------------------------------------------

const LOCAL = { remoteAddress: '127.0.0.1' };
const store = new CredentialStore({ file: path.join(tmpdir('series-valid-cred-'), 'credentials.json') });
const { token: TOKEN } = store.create({ name: 'teste' });

function ponte(over = {}) {
  const dir = tmpdir('series-valid-store-');
  const b = new Bridge({ torrentDir: dir, storeDir: dir, port: 7097, publicUrl: 'http://127.0.0.1:7010/', credentials: store,
    vault: new SeedVault({ file: path.join(tmpdir('series-valid-v-'), 'v.json') }), minFreeBytes: 1000, freeSpace: () => 1e12, ...over });
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
    destroy() { this.destroyed = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); } });
  return r;
}
const pedido = (method, url, headers = {}) => ({ method, url: `${url}?k=${TOKEN}`, headers, socket: LOCAL });
const corpo = (res) => Buffer.concat(res.chunks).toString();
const esperar = async (cond, ms = 2000) => {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// Espia o que a ponte manda ao logger ANTES da redação: o logger já esconde `ascc_…` e `k=`, mas a
// ponte também não pode depender disso para não pôr a credencial na mensagem.
function espiarLog(t) {
  const vistos = [];
  const propria = Object.hasOwn(logger, 'write'); // `write` é do protótipo: restaurar removendo a espia
  const original = logger.write;
  logger.write = function espia(level, src, msg, data, opts) {
    vistos.push(`${msg} ${data === undefined ? '' : JSON.stringify(data)}`);
    return original.call(this, level, src, msg, data, opts);
  };
  t.after(() => { if (propria) logger.write = original; else delete logger.write; });
  return vistos;
}

test('rota /e/ aceita a temporada 0 (especiais) e repassa 0 ao resolvedor', async () => {
  const b = ponte();
  const visto = [];
  b.ascEpisodeResolver = async (id, s, e) => { visto.push([id, s, e]); return { infoHash: HASH, fileIdx: 0 }; };
  b.getTorrent = async () => ({ ready: true, numPeers: 1, progress: 0, files: [{ length: 4, path: 'S/S.S00E01.mkv', downloaded: 0, createReadStream: () => Readable.from([Buffer.from('spec')]) }] });
  const res = resposta();
  await b.handle(pedido('GET', '/e/12/0/1'), res);
  assert.deepEqual(visto, [['12', 0, 1]]);
  assert.equal(res.statusCode, 200);
  assert.equal(corpo(res), 'spec');
});

test('dois episódios simultâneos do mesmo torrent: índices certos, encerramento independente e sem credencial no log', async (t) => {
  const b = ponte();
  const logs = espiarLog(t);
  const resolvidos = [];
  b.ascEpisodeResolver = async (id, s, e) => { // o provedor aponta o MESMO torrent, índices diferentes
    resolvidos.push([s, e]);
    await new Promise((r) => setTimeout(r, 5));
    return { infoHash: HASH, fileIdx: e };
  };
  const aberturas = [];
  const longo = new PassThrough(); // episódio 1: o player segue lendo
  const arquivos = [
    null,
    { length: 100, path: 'S/S.S01E01.mkv', downloaded: 0, createReadStream: () => longo },
    { length: 4, path: 'S/S.S01E02.mkv', downloaded: 0, createReadStream: () => Readable.from([Buffer.from('dois')]) },
  ];
  b.getTorrent = async (h, opts) => { aberturas.push([h, opts.fileIdx]); return { ready: true, numPeers: 2, progress: 0, files: arquivos }; };

  const r1 = resposta(); const r2 = resposta();
  const p1 = b.handle(pedido('GET', '/e/12/1/1'), r1);
  const p2 = b.handle(pedido('GET', '/e/12/1/2'), r2);
  longo.write('um');
  await p2;
  await esperar(() => r1.chunks.length > 0);

  assert.deepEqual(resolvidos.sort((x, y) => x[1] - y[1]), [[1, 1], [1, 2]], 'cada pedido resolve o seu episódio');
  assert.deepEqual(aberturas.map((a) => a[1]).sort(), [1, 2], 'o motor recebe o índice de cada um');
  assert.equal(corpo(r1), 'um');
  assert.equal(corpo(r2), 'dois');
  assert.equal(r2.ended, true, 'o episódio curto terminou');
  assert.equal(r1.ended, false, 'sem arrastar o outro');
  assert.equal(b.streams.get(HASH), 1, 'só o episódio 1 segue aberto no torrent');

  r1.destroy(); // o player fecha o primeiro
  longo.end(); // e o motor encerra a leitura (um next() pendente só termina assim)
  await p1;
  assert.equal(b.streams.get(HASH), 0);

  const todo = logs.join('\n');
  assert.ok(logs.length > 0, 'a espia viu o log da ponte');
  assert.ok(!todo.includes(TOKEN) && !/ascc_|[?&]k=/.test(todo), 'a credencial nunca vai ao logger');
});

test('episódio ausente recusa só ele: o seguinte do mesmo torrent toca, e o erro não carrega a credencial', async (t) => {
  const b = ponte();
  const logs = espiarLog(t);
  b.ascEpisodeResolver = async (id, s, e) => {
    if (e === 9) throw Object.assign(new Error('Este release não traz o episódio S01E09'), { status: 404 });
    return { infoHash: HASH, fileIdx: 0 };
  };
  b.getTorrent = async () => ({ ready: true, numPeers: 1, progress: 0, files: [{ length: 3, path: 'S/S.S01E01.mkv', downloaded: 0, createReadStream: () => Readable.from([Buffer.from('ok!')]) }] });

  const ausente = resposta();
  await b.handle(pedido('GET', '/e/12/1/9'), ausente);
  assert.equal(ausente.statusCode, 404);
  assert.ok(!corpo(ausente).includes(TOKEN));

  const presente = resposta();
  await b.handle(pedido('GET', '/e/12/1/1'), presente);
  assert.equal(presente.statusCode, 200);
  assert.equal(corpo(presente), 'ok!');
  assert.ok(logs.length > 0, 'a espia viu o log da recusa');
  assert.ok(!logs.join('\n').includes(TOKEN));
});

test('HEAD em /e/ de dois episódios não resolve, não abre o motor e não anuncia', async () => {
  const b = ponte();
  let chamadas = 0;
  b.ascEpisodeResolver = async () => { chamadas += 1; return { infoHash: HASH, fileIdx: 0 }; };
  b.getTorrent = async () => { chamadas += 1; throw new Error('HEAD não abre o torrent'); };
  b.ascStartGate = async () => { chamadas += 1; };
  for (const url of ['/e/12/1/1', '/e/12/1/2', '/e/12/0/1']) {
    const res = resposta();
    await b.handle(pedido('HEAD', url), res);
    assert.equal(res.statusCode, 200, url);
  }
  assert.equal(chamadas, 0, 'nem .torrent, nem torrent no motor (sem announce), nem consulta de freeleech');
});
