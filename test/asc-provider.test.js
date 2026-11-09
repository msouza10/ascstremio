const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAscProvider } = require('../src/asc-provider');
const { tmpdir } = require('./tmp-helper');

const GB = 1024 ** 3;
const linha = (id, extra = {}) => ({
  id, name: `Filme ${id}`, size: 5.6 * GB, seeders: 18, leechers: 2, timesCompleted: 326, freeleech: true,
  badges: [{ label: '1080p', kind: 'resolution' }, { label: 'WEB-DL', kind: 'source' }, { label: 'Dual Áudio', kind: 'audio' }, { label: '1080p', kind: 'dup' }],
  ...extra,
});

// Ponte e ASC falsos que registram tudo: o que importa é o QUE foi baixado e QUANDO.
async function fixture(t, { rows = [linha(1), linha(2)], videosPorId = {}, arquivosPorId = {}, diskFull = false, onlyFreeleech = false, historyFreeleech = true, downloadErro = null, connected = true, original } = {}) {
  const dir = tmpdir('asc-provider-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = { searches: 0, downloads: [], histories: [], originals: [] };
  const bridge = {
    entries: new Map(),
    vault: { get: () => null },
    lazyUrl: (id) => `http://127.0.0.1:7010/a/${id}`,
    diskState: () => (diskFull ? 'full' : 'none'),
    entryByAscId(id) { return [...this.entries.values()].find((e) => path.basename(String(e.torrentPath)) === `asc-${id}.torrent`) ?? null; },
  };
  const asc = {
    onlyFreeleech, connected,
    async search() { calls.searches++; return rows; },
    async download(id) { calls.downloads.push(String(id)); await new Promise((r) => setTimeout(r, 10)); if (downloadErro) throw new Error(downloadErro); return Buffer.from(String(id)); },
    ...(original === undefined ? {} : { async originalLanguage(id) { calls.originals.push(String(id)); if (original instanceof Error) throw original; return original; } }),
    async history(id) { calls.histories.push(String(id)); return { history: null, freeleech: historyFreeleech, name: 'x' }; },
  };
  const provider = createAscProvider(asc, bridge, dir, {
    async readTorrentImpl(file) {
      const id = /asc-(\d+)\.torrent$/.exec(file)[1];
      if (arquivosPorId[id]) {
        return { infoHash: id.padStart(40, 'a'), torrentPath: file, files: arquivosPorId[id].map((f, index) => ({ index, isVideo: /\.(mkv|mp4)$/.test(f.path), ...f })) };
      }
      const videos = videosPorId[id] ?? 1;
      return { infoHash: id.padStart(40, 'a'), torrentPath: file,
        files: Array.from({ length: videos }, (_, i) => ({ index: i, path: `filme-${id}-${i}.mkv`, length: 1000 * (i + 1), isVideo: true })).concat([{ index: videos, path: 'leia.nfo', length: 10, isVideo: false }]) };
    },
  });
  return { provider, bridge, asc, calls, dir };
}
const imdb = { type: 'movie', imdbId: 'tt35538033' };

test('listar as fontes NÃO baixa .torrent nem grava nada em disco', async (t) => {
  const { provider, bridge, calls, dir } = await fixture(t);
  const streams = await provider.findStreams(imdb);
  assert.equal(streams.length, 2);
  assert.deepEqual(calls.downloads, [], 'nenhum download ao listar');
  assert.equal(calls.searches, 1, 'uma busca só');
  assert.equal(bridge.entries.size, 0, 'nada entra na biblioteca antes do play');
  assert.deepEqual(await fs.readdir(dir), [], 'nenhum arquivo gravado (a passkey vem dentro do .torrent)');
  assert.equal(streams[0].url, 'http://127.0.0.1:7010/a/1', 'a URL aponta para o id; o download é só no play');
});

test('Modelo B: esquerda só com 🆓/resolução/fonte; direita com idioma em bandeira, seeders, tamanho e completos, sem repetir', async (t) => {
  const { provider } = await fixture(t);
  const [s] = await provider.findStreams(imdb);
  assert.equal(s.name, '🆓 1080p\nWEB-DL');
  const linhas = s.description.split('\n');
  assert.equal(linhas[0], '🇧🇷🌐', 'sem o idioma original, Dual Áudio mostra 🇧🇷 e 🌐; resolução e fonte não se repetem');
  assert.equal(linhas[1], '👤 18 seeders · 2 leechers · 💾 5,6 GB · ✅ 326');
  assert.equal(linhas.length, 2, 'freeleech não leva aviso de ratio; o título do filme não se repete');
  assert.equal(s.behaviorHints.notWebReady, true);
  assert.equal(s.behaviorHints.filename, undefined, 'sem .torrent não há nome real do arquivo');
});

test('selos de vídeo e som: HDR/codec e Atmos vão para a direita; idioma desconhecido vira texto', async (t) => {
  const badges = [{ label: '4K', kind: 'resolution' }, { label: 'REMUX', kind: 'source' }, { label: 'HDR10', kind: 'hdr' },
    { label: 'H.265', kind: 'codec' }, { label: 'Dublado', kind: 'audio' }, { label: 'Atmos', kind: 'codec' }];
  const { provider } = await fixture(t, { rows: [linha(1, { badges })] });
  const [s] = await provider.findStreams(imdb);
  assert.equal(s.name, '🆓 4K\nREMUX');
  const linhas = s.description.split('\n');
  assert.equal(linhas[0], 'HDR10 · H.265');
  assert.equal(linhas[1], '🇧🇷 Atmos');
});

test('idioma original: lido uma vez por filme (1 página), vira bandeira; Legendado leva a bandeira + 💬', async (t) => {
  const badges = (...l) => [{ label: '1080p', kind: 'resolution' }, ...l.map((label) => ({ label, kind: 'audio' }))];
  const rows = [linha(1, { badges: badges('Dual Áudio') }), linha(2, { badges: badges('Legendado'), seeders: 3 }), linha(3, { badges: badges('Dublado'), seeders: 2 })];
  const { provider, calls, dir } = await fixture(t, { rows, original: 'Coreano' });
  const streams = await provider.findStreams(imdb);
  assert.deepEqual(streams.map((s) => s.description.split('\n')[0]), ['🇧🇷🇰🇷', '🇰🇷💬', '🇧🇷']);
  assert.deepEqual(calls.originals, ['1'], 'uma página só, a do release com mais seeders');
  await provider.findStreams(imdb);
  assert.equal(calls.originals.length, 1, 'segunda abertura do filme usa o que já foi lido');
  assert.deepEqual(calls.downloads, [], 'ler a página não baixa .torrent');
  assert.deepEqual(await fs.readdir(dir), []);
});

test('idioma original: falha na leitura não derruba a lista e tenta de novo na próxima', async (t) => {
  const { provider, calls } = await fixture(t, { original: new Error('rede') });
  const [s] = await provider.findStreams(imdb);
  assert.equal(s.description.split('\n')[0], '🇧🇷🌐');
  await provider.findStreams(imdb);
  assert.equal(calls.originals.length, 2, 'falha não fica em cache');
});

test('fora do freeleech avisa do ratio; limita a quantidade de opções', async (t) => {
  const rows = Array.from({ length: 9 }, (_, i) => linha(i + 1, i === 0 ? { freeleech: false } : {}));
  const { provider, calls } = await fixture(t, { rows });
  const streams = await provider.findStreams(imdb);
  assert.equal(streams.length, 9, 'todas as versões aparecem (até 12; listar é de graça)');
  assert.ok(streams.some((s) => !s.name.includes('🆓')), 'o não-freeleech aparece, sem o selo 🆓');
  assert.match(streams.find((s) => !s.name.includes('🆓')).description, /^⚠ Não é freeleech$/m);
  assert.equal(calls.downloads.length, 0);
});

test('play: baixa o .torrent uma única vez mesmo com GETs simultâneos e registra a biblioteca', async (t) => {
  const { provider, bridge, calls, dir } = await fixture(t);
  await provider.findStreams(imdb);
  const [a, b, c] = await Promise.all([provider.resolve('1'), provider.resolve('1'), provider.resolve(1)]);
  assert.deepEqual(calls.downloads, ['1'], 'um download só');
  assert.deepEqual(a, b); assert.deepEqual(a, c);
  assert.equal(a.infoHash, '1'.padStart(40, 'a'));
  assert.equal(a.fileIdx, 0);
  assert.equal(bridge.entries.get(a.infoHash).freeleech, true, 'freeleech vem da busca');
  assert.deepEqual(await fs.readdir(dir), ['asc-1.torrent']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'asc-1.torrent'))).mode & 0o777, 0o600);
  // segundo play: já está na biblioteca, não baixa de novo
  await provider.resolve('1');
  assert.equal(calls.downloads.length, 1);
});

test('depois do play a fonte passa a trazer o nome real do arquivo', async (t) => {
  const { provider } = await fixture(t);
  await provider.resolve('1');
  const [s] = await provider.findStreams(imdb);
  assert.equal(s.behaviorHints.filename, 'filme-1-0.mkv');
});

test('pack com vídeos de tamanho parecido: recusa no play (422) e some das listas seguintes', async (t) => {
  const { provider, calls } = await fixture(t, { videosPorId: { 2: 3 } }); // 1000, 2000 e 3000 bytes: nenhum domina
  assert.equal((await provider.findStreams(imdb)).length, 2, 'antes de saber, aparece');
  await assert.rejects(provider.resolve('2'), (e) => e.status === 422 && /3 vídeos de tamanho parecido/.test(e.message));
  const depois = await provider.findStreams(imdb);
  assert.deepEqual(depois.map((s) => s.url), ['http://127.0.0.1:7010/a/1'], 'aprendeu e não oferece mais');
  await assert.rejects(provider.resolve('2'), (e) => e.status === 422);
  assert.deepEqual(calls.downloads, ['2'], 'não baixa de novo um release já recusado');
});

test('filme com extras pequenos (making-of, entrevistas) TOCA: o vídeo que domina é o filme', async (t) => {
  // O release real asc-467 (Perdido em Marte): 1 filme de 6,6 GB + 8 extras de 20 a 70 MB.
  const arquivos = [{ path: 'Extras - Entrevistas.mkv', length: 20e6 }, { path: 'The.Martian.2160p.mkv', length: 6.59 * GB }, { path: 'Extras - Making of.mkv', length: 70e6 }, { path: 'leia.nfo', length: 10 }];
  const { provider, calls } = await fixture(t, { arquivosPorId: { 2: arquivos } });
  const r = await provider.resolve('2');
  assert.equal(r.fileIdx, 1, 'escolhe o filme, não o primeiro vídeo');
  assert.deepEqual(calls.downloads, ['2']);
  const [, s2] = await provider.findStreams(imdb);
  assert.equal(s2.behaviorHints.filename, 'The.Martian.2160p.mkv', 'o nome real é o do filme');
  await provider.resolve('2');
  assert.equal(calls.downloads.length, 1, 'já local: não baixa de novo');
});

test('imagem de disco (.iso): 422 com o motivo, antes de abrir o torrent', async (t) => {
  const { provider, calls } = await fixture(t, { arquivosPorId: { 2: [{ path: 'Resident.Evil.BD25.iso', length: 19.9 * GB }] } });
  await assert.rejects(provider.resolve('2'), (e) => e.status === 422 && /imagem de disco \(\.iso\)/.test(e.message));
  assert.deepEqual(calls.downloads, ['2']);
  // já recusado e local: recusa de imediato, sem baixar o .torrent outra vez
  await assert.rejects(provider.resolve('2'), (e) => e.status === 422);
  assert.deepEqual(calls.downloads, ['2']);
});

test('sem nenhum arquivo de vídeo e sem ser disco: mensagem própria', async (t) => {
  const { provider } = await fixture(t, { arquivosPorId: { 2: [{ path: 'filme.rar', length: 5 * GB }, { path: 'leia.nfo', length: 10 }] } });
  await assert.rejects(provider.resolve('2'), (e) => e.status === 422 && /nenhum arquivo de vídeo reconhecido/.test(e.message));
});

test('ISO/BDMV e release sem seeders: avisados na lista e empurrados para o fim', async (t) => {
  const rows = [
    linha(1, { name: 'Filme.2026.BD25.iso', seeders: 40 }),
    linha(2, { name: 'Filme 2026 WEB-DL', seeders: 0 }),
    linha(3, { name: 'Filme 2026 1080p', seeders: 12 }),
  ];
  const { provider, calls } = await fixture(t, { rows });
  const streams = await provider.findStreams(imdb);
  assert.deepEqual(streams.map((s) => s.url.split('/').pop()), ['3', '2', '1'], 'bom primeiro; sem seeders, depois; disco por último');
  assert.match(streams[1].description, /👤 0 seeders/, 'sem seeders: só mostra o 0, sem frase');
  assert.doesNotMatch(streams[1].description, /Sem seeders agora/);
  assert.match(streams[2].description, /^⚠ ISO$/m);
  assert.doesNotMatch(streams[0].description, /⚠ ISO/);
  assert.equal(calls.downloads.length, 0);
});

test('play de release sem seeders: 503 sem baixar nem abrir (evita snatch vazio); com dados completos em disco toca', async (t) => {
  const rows = [linha(1, { seeders: 0 })];
  let f = await fixture(t, { rows });
  await f.provider.findStreams(imdb);
  await assert.rejects(f.provider.resolve('1'), (e) => e.status === 503 && /sem seeders/.test(e.message));
  assert.deepEqual(f.calls.downloads, [], 'não baixa o .torrent de um release sem seeders');
  // dados completos em disco: dá para tocar mesmo sem seeders
  f = await fixture(t, { rows, diskFull: true });
  await f.provider.findStreams(imdb);
  f.bridge.entries.set('1'.padStart(40, 'a'), { infoHash: '1'.padStart(40, 'a'), torrentPath: '/x/asc-1.torrent', files: [{ index: 0, path: 'f.mkv', length: 9, isVideo: true }] });
  assert.equal((await f.provider.resolve('1')).fileIdx, 0);
  // seeders > 0: normal
  f = await fixture(t, { rows: [linha(1, { seeders: 3 })] });
  await f.provider.findStreams(imdb);
  assert.equal((await f.provider.resolve('1')).fileIdx, 0);
});

test('falha de download vira 502 (ou 401 sem sessão) e não fica em cache', async (t) => {
  let f = await fixture(t, { downloadErro: 'Limite de acesso do ASC.' });
  await assert.rejects(f.provider.resolve('1'), (e) => e.status === 502 && /Limite/.test(e.message));
  await assert.rejects(f.provider.resolve('1'), (e) => e.status === 502);
  assert.equal(f.calls.downloads.length, 2, 'falha não é memorizada: tenta de novo no próximo play');
  f = await fixture(t, { downloadErro: 'Sessão expirada. Entre novamente.', connected: false });
  await assert.rejects(f.provider.resolve('1'), (e) => e.status === 401);
});

test('id inválido é recusado antes de qualquer rede', async (t) => {
  const { provider, calls } = await fixture(t);
  for (const ruim of ['abc', '1/../2', '', '12345678901', '1;rm']) await assert.rejects(provider.resolve(ruim), (e) => e.status === 400, ruim);
  assert.equal(calls.downloads.length + calls.histories.length + calls.searches, 0);
});

test('"somente freeleech" vale no play: release que não é freeleech nunca é baixado', async (t) => {
  // a linha mudou para não-freeleech depois de listada
  let f = await fixture(t, { onlyFreeleech: true, rows: [linha(1, { freeleech: false })] });
  await f.provider.findStreams(imdb);
  await assert.rejects(f.provider.resolve('1'), (e) => e.status === 409 && /freeleech/.test(e.message));
  assert.deepEqual(f.calls.downloads, []);
  // URL antiga sem registro (restart): confirma na página do torrent antes de baixar
  f = await fixture(t, { onlyFreeleech: true, historyFreeleech: false });
  await assert.rejects(f.provider.resolve('7'), (e) => e.status === 409);
  assert.deepEqual(f.calls.histories, ['7']);
  assert.deepEqual(f.calls.downloads, []);
  f = await fixture(t, { onlyFreeleech: true, historyFreeleech: true });
  const r = await f.provider.resolve('7');
  assert.equal(r.fileIdx, 0);
  assert.deepEqual(f.calls.downloads, ['7']);
  assert.equal(f.bridge.entries.get(r.infoHash).freeleech, true);
  // filtro desligado: baixa sem consultar a página
  f = await fixture(t, { onlyFreeleech: false, historyFreeleech: false });
  await f.provider.resolve('7');
  assert.deepEqual(f.calls.histories, []);
});

test('aviso de arquivos removidos aparece nas fontes de um filme já liberado', async (t) => {
  const { provider, bridge } = await fixture(t);
  await provider.resolve('1');
  bridge.vault = { get: () => ({ releasedAs: 'delete' }) };
  const [s] = await provider.findStreams(imdb);
  assert.match(s.description, /^⚠ Baixa de novo \(72 h\)$/m);
});

test('abertura direta revalida freeleech mesmo com metadados em cache e não baixa nada', async (t) => {
  const dir = tmpdir('asc-recheck-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0; let downloads = 0;
  const provider = createAscProvider({
    async search() { return ++calls === 1 ? [{ id: 1, name: 'Movie', freeleech: true }] : []; },
    async download() { downloads++; },
  }, { entries: new Map(), lazyUrl: (id) => `u/${id}` }, dir);
  await provider.catalog('Movie');
  assert.deepEqual(await provider.streamsFor(1), []);
  assert.equal(downloads, 0);
});
