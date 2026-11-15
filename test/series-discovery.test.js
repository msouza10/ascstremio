const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AscClient } = require('../src/asc-client');
const { createAscProvider } = require('../src/asc-provider');
const { tmpdir } = require('./tmp-helper');

const html = (props) => new Response(`<script type="application/json" data-page="app">${JSON.stringify({ props })}</script>`, { status: 200 });
const GB = 1024 ** 3;

async function clientWith(t, handler) {
  const dir = tmpdir('series-discovery-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const asc = new AscClient({ stateFile: path.join(dir, 'session.json'), delay: 0, fetchImpl: async (url) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
    return handler(u);
  } });
  return { asc, calls };
}

const rowsOf = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i, name: `Show S01 ${from + i}`, seeders: 1, freeleech: true }));

// ---- Cliente --------------------------------------------------------------------------------------

test('searchSeries: junta Series (3) e Anime (11) e segue as páginas cheias', async (t) => {
  const { asc, calls } = await clientWith(t, (u) => {
    const { category, page = '1' } = Object.fromEntries(u.searchParams);
    if (category === '3') return html({ torrents: { data: rowsOf(1, 5) } });
    return html({ torrents: { data: page === '1' ? rowsOf(100, 96) : rowsOf(300, 21) } });
  });
  const { rows, truncated } = await asc.searchSeries('tt0388629');
  assert.equal(rows.length, 5 + 96 + 21, '117 releases do anime em duas páginas, mais os da categoria 3');
  assert.equal(truncated, false);
  assert.deepEqual(calls.map((c) => `${c.params.category}/${c.params.page ?? 1}`), ['3/1', '11/1', '11/2']);
  assert.ok(calls.every((c) => c.params.q === 'tt0388629'));
});

test('searchSeries: sem repetir release que aparece nas duas categorias, e avisa truncamento', async (t) => {
  const { asc } = await clientWith(t, () => html({ torrents: { data: rowsOf(1, 96) } })); // sempre cheia
  const { rows, truncated } = await asc.searchSeries('tt1', { maxPages: 2 });
  assert.equal(rows.length, 96, 'mesmos ids nas duas categorias e páginas contam uma vez');
  assert.equal(truncated, true, 'ainda havia página cheia no limite: lista não é completa');
});

test('searchSeries: IMDb inválido é recusado antes de qualquer consulta', async (t) => {
  const { asc, calls } = await clientWith(t, () => html({ torrents: { data: [] } }));
  await assert.rejects(asc.searchSeries('Breaking Bad'), /IMDb inválido/);
  assert.equal(calls.length, 0);
});

test('search (filme) continua na categoria 4, uma página só', async (t) => {
  const { asc, calls } = await clientWith(t, () => html({ torrents: { data: rowsOf(1, 96) } }));
  assert.equal((await asc.search('tt0133093')).length, 96);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.category, '4');
  assert.equal(calls[0].params.page, undefined);
});

test('releaseFiles: lê a lista da página sem baixar .torrent e junta as páginas', async (t) => {
  const pagina = (n) => Array.from({ length: n === 3 ? 20 : 100 }, (_, i) => ({ path: `Temporada 01/Show.S01E${String(i + 1 + (n - 1) * 100).padStart(3, '0')}.mkv`, size: GB }));
  const { asc, calls } = await clientWith(t, (u) => {
    const n = Number(u.searchParams.get('filesPage') ?? 1);
    return html({ torrent: { numFiles: 220 }, files: { data: pagina(n) }, filesTotal: 220, filesRoot: 'Show (2020)' });
  });
  const result = await asc.releaseFiles(61);
  assert.equal(result.files.length, 220);
  assert.equal(result.complete, true);
  assert.ok(result.files[0].path.startsWith('Temporada 01/'), 'caminho relativo: filesRoot não é somado');
  assert.ok(calls.every((c) => c.path === '/torrents/61'), 'nenhuma chamada a /download');
});

test('releaseFiles: o site repete a primeira página -> incompleto, sem duplicar', async (t) => {
  const { asc } = await clientWith(t, () => html({ torrent: { numFiles: 150 }, files: { data: [{ path: 'a.mkv', size: 1 }, { path: 'b.mkv', size: 1 }] }, filesTotal: 150 }));
  const result = await asc.releaseFiles(7);
  assert.deepEqual(result.files.map((f) => f.path), ['a.mkv', 'b.mkv']);
  assert.equal(result.complete, false);
});

test('releaseFiles: página sem lista de arquivos não afirma nada', async (t) => {
  const { asc } = await clientWith(t, () => html({ torrent: { numFiles: 3 } }));
  assert.deepEqual(await asc.releaseFiles(9), { files: [], total: null, complete: false });
});

test('releaseFiles: id inválido e formato mudado são erro', async (t) => {
  const { asc } = await clientWith(t, () => html({ outra: 1 }));
  await assert.rejects(asc.releaseFiles('x'), /Torrent inválido/);
  await assert.rejects(asc.releaseFiles(5), /Formato da página do torrent mudou/);
});

// ---- Provedor -------------------------------------------------------------------------------------

function providerWith({ rows, files = {}, truncated = false, fail = [] }) {
  const calls = { searches: 0, files: [], downloads: 0 };
  const asc = {
    onlyFreeleech: false,
    async searchSeries() { calls.searches += 1; return { rows, truncated }; },
    async releaseFiles(id) {
      calls.files.push(String(id));
      if (fail.map(String).includes(String(id))) throw new Error('site fora');
      return files[id] ?? { files: [], total: null, complete: false };
    },
    async download() { calls.downloads += 1; throw new Error('listar não baixa .torrent'); },
  };
  const bridge = { entries: new Map(), vault: { get: () => null }, lazyUrl: (id) => `http://x/a/${id}`, diskState: () => 'none', entryByAscId: () => null };
  return { provider: createAscProvider(asc, bridge, '/nao-usado', {}), calls };
}
const lista = (...paths) => ({ files: paths.map((p) => ({ path: p, size: GB })), total: paths.length, complete: true });
const row = (id, name, seeders = 10) => ({ id, name, seeders, freeleech: true, size: 10 * GB, badges: [] });
const video = (season, episode) => ({ type: 'series', imdbId: 'tt0903747', season, episode });

test('seriesCandidates: filtra pelo episódio na lista de arquivos e não baixa .torrent', async () => {
  const { provider, calls } = providerWith({
    rows: [row(1, 'Show S01 1080p'), row(2, 'Show S02 1080p'), row(3, 'Show Completo 1080p')],
    files: {
      1: lista('Show.S01E01.mkv', 'Show.S01E02.mkv'),
      3: lista('Temporada 01/Show.S01E01.mkv', 'Temporada 02/Show.S02E01.mkv'),
    },
  });
  const { candidates } = await provider.seriesCandidates(video(1, 2));
  assert.deepEqual(candidates.map((c) => c.row.id), [1], 'S02 sai pelo nome; o completo não tem S01E02 na lista');
  assert.equal(candidates[0].status, 'tem');
  assert.equal(candidates[0].file.path, 'Show.S01E02.mkv');
  assert.equal('index' in candidates[0].file, false, 'a posição na página nunca vira fileIdx');
  assert.equal(calls.downloads, 0);
  assert.ok(!calls.files.includes('2'), 'nome que contradiz poupa a consulta da página');
});

test('seriesCandidates: ordem embaralhada na página não muda o arquivo escolhido', async () => {
  const { provider } = providerWith({
    rows: [row(1, 'Show S01')],
    files: { 1: lista('Show.S01E03.mkv', 'banner.jpg', 'Show.S01E01.mkv') },
  });
  const { candidates } = await provider.seriesCandidates(video(1, 1));
  assert.equal(candidates[0].file.path, 'Show.S01E01.mkv');
});

test('seriesCandidates: lista incompleta ou falha de leitura mantém o candidato como "nao-visto"', async () => {
  const { provider } = providerWith({
    rows: [row(1, 'Show S01', 30), row(2, 'Show S01', 20)],
    files: { 1: { files: [{ path: 'Show.S01E09.mkv', size: GB }], total: 150, complete: false } },
    fail: [2],
  });
  const { candidates } = await provider.seriesCandidates(video(1, 2));
  assert.deepEqual(candidates.map((c) => [c.row.id, c.status]), [[1, 'nao-visto'], [2, 'nao-visto']]);
});

test('seriesCandidates: episódio ambíguo (dois arquivos) não é adivinhado', async () => {
  const { provider } = providerWith({
    rows: [row(1, 'Show S01')],
    files: { 1: lista('Show.S01E01.1080p.mkv', 'Show.S01E01.720p.mkv') },
  });
  assert.deepEqual((await provider.seriesCandidates(video(1, 1))).candidates, []);
});

test('seriesCandidates: o filtro roda sobre todos os releases, sem corte prévio de opções', async () => {
  // 20 releases; só o de menos seeders (fora das 8 leituras) poderia ter o episódio: fica candidato.
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, `Show S01 v${i}`, 100 - i));
  const files = Object.fromEntries(rows.map((r) => [r.id, lista('Show.S01E01.mkv')]));
  const { provider } = providerWith({ rows, files });
  const { candidates } = await provider.seriesCandidates(video(1, 5));
  // 8 listas completas sem o E05 saem; os 12 não lidos continuam candidatos "nao-visto"
  assert.equal(candidates.length, 12);
  assert.ok(candidates.every((c) => c.status === 'nao-visto'));
  assert.ok(candidates.some((c) => c.row.id === 20), 'o release de menos seeders não foi cortado');
});

test('seriesCandidates: limita as páginas lidas por pedido e reaproveita a lista completa', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, 'Show S01', 100 - i));
  const files = Object.fromEntries(rows.map((r) => [r.id, lista('Show.S01E01.mkv')]));
  const { provider, calls } = providerWith({ rows, files });
  const first = await provider.seriesCandidates(video(1, 1));
  assert.equal(calls.files.length, 8);
  assert.equal(first.candidates.length, 12, 'os 4 sem leitura continuam candidatos');
  assert.equal(first.candidates.filter((c) => c.status === 'nao-visto').length, 4);
  await provider.seriesCandidates(video(1, 1));
  assert.ok(calls.files.length < 16, 'as listas completas vieram do cache');
});

test('seriesCandidates: repassa o aviso de truncamento da busca', async () => {
  const { provider } = providerWith({ rows: [row(1, 'Show S01')], files: { 1: lista('Show.S01E01.mkv') }, truncated: true });
  const result = await provider.seriesCandidates(video(1, 1));
  assert.equal(result.truncated, true);
  assert.equal(result.total, 1);
});

test('seriesCandidates: leituras que falham contam no orçamento e o site instável não é insistido', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, 'Show S01', 100 - i));
  const { provider, calls } = providerWith({ rows, files: {}, fail: rows.map((r) => r.id) });
  const { candidates } = await provider.seriesCandidates(video(1, 1));
  assert.equal(calls.files.length, 2, 'depois de 2 falhas seguidas para de ler');
  assert.equal(candidates.length, 12, 'todos seguem como candidatos a confirmar');
  assert.ok(candidates.every((c) => c.status === 'nao-visto'));
});

test('seriesCandidates: falhas alternadas ainda respeitam o limite de 8 tentativas', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, 'Show S01', 100 - i));
  const files = Object.fromEntries(rows.map((r) => [r.id, lista('Show.S01E09.mkv')]));
  const { provider, calls } = providerWith({ rows, files, fail: [1, 3, 5, 7, 9, 11] });
  const { candidates } = await provider.seriesCandidates(video(1, 1));
  assert.equal(calls.files.length, 8, 'as que falham gastam o orçamento como as que funcionam');
  assert.equal(candidates.length, 12 - 4, 'os 4 lidos sem o episódio saíram; as falhas e os não lidos ficam por confirmar');
});
