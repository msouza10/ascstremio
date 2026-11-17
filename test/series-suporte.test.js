// Matriz de suporte de séries (#89): para cada tipo de release da seção 1 da #83, o que o addon
// faz quando o Stremio pede um episódio: TOCA, mostra NÃO SUPORTADO (com mensagem) ou NÃO OFERECE
// (o release não serve a este pedido). Tudo pela rota real `GET /stream/series/<imdb>:<s>:<e>.json`
// (addon.get), com ASC simulado e listas de arquivos SINTÉTICAS (estrutura dos casos reais, sem
// .torrent e sem dados da conta). A matriz documentada está em docs/series-prioridades.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAddon } = require('../src/addon');
const { createAscProvider } = require('../src/asc-provider');

const GB = 1024 ** 3;
const row = (id, name, seeders = 10, extra = {}) => ({ id, name, seeders, freeleech: true, size: 10 * GB, badges: [], ...extra });
const lista = (...paths) => ({ files: paths.map((p) => ({ path: p, size: GB })), total: paths.length, complete: true });
const seq = (n, fmt) => Array.from({ length: n }, (_, i) => fmt(i + 1));
const p2 = (n) => String(n).padStart(2, '0');

// Addon real (stream handler do Stremio) em cima do provedor real; só o ASC e a ponte são falsos.
function montar({ rows, files = {}, panel = false }) {
  const calls = { searches: 0, files: [], downloads: 0, outras: 0 };
  const asc = {
    onlyFreeleech: false,
    async searchSeries() { calls.searches += 1; return { rows, truncated: false }; },
    async releaseFiles(id) { calls.files.push(String(id)); return files[id] ?? { files: [], total: null, complete: false }; },
    async download() { calls.downloads += 1; throw new Error('listar não baixa .torrent'); },
    async history() { calls.outras += 1; return {}; },
    async originalLanguage() { calls.outras += 1; return null; },
  };
  const bridge = {
    entries: new Map(), vault: { get: () => null }, diskState: () => 'none', entryByAscId: () => null,
    lazyUrl: (id) => `http://x/a/${id}`, episodeUrl: (id, s, e) => `http://x/e/${id}/${s}/${e}`,
  };
  const provider = createAscProvider(asc, bridge, '/nao-usado', {});
  const status = panel ? { snapshot: () => ({ ok: true }), posterBase: 'http://x', panelUrl: 'http://127.0.0.1:7020' } : null;
  return { addon: createAddon({ remote: provider, status }), calls };
}

const pedir = async (ctx, season, episode, imdb = 'tt0000001') => (await ctx.addon.get('stream', 'series', `${imdb}:${season}:${episode}`, {})).streams;
const tocaveis = (streams) => streams.filter((s) => s.url);
const avisos = (streams) => streams.filter((s) => !s.url && s.externalUrl);

// ---- Toca ----------------------------------------------------------------------------------------

test('toca: temporada simples, com os vídeos na raiz do release (Breaking Bad S01)', async () => {
  const ctx = montar({ rows: [row(1, 'Breaking Bad S01 1080p')], files: { 1: lista(...seq(7, (n) => `Breaking.Bad.S01E${p2(n)}.1080p.mkv`)) } });
  const streams = await pedir(ctx, 1, 3);
  assert.deepEqual(tocaveis(streams).map((s) => s.url), ['http://x/e/1/1/3']);
  assert.deepEqual(avisos(streams), []);
});

test('toca: pack completo com subpastas por temporada e nomes técnicos (S01-S05)', async () => {
  const files = [];
  for (let s = 1; s <= 5; s += 1) for (let e = 1; e <= 3; e += 1) files.push(`Breaking.Bad.S${p2(s)}.1080p.BluRay/Breaking.Bad.S${p2(s)}E${p2(e)}.1080p.mkv`);
  const ctx = montar({ rows: [row(2, 'Breaking Bad Completo')], files: { 2: lista(...files) } });
  assert.deepEqual(tocaveis(await pedir(ctx, 4, 2)).map((s) => s.url), ['http://x/e/2/4/2']);
});

test('toca: S02 continua sendo S02, e S01 nem consulta o release', async () => {
  const ctx = montar({ rows: [row(3, 'The Last of Us S02')], files: { 3: lista(...seq(7, (n) => `The.Last.of.Us.S02E${p2(n)}.mkv`)) } });
  assert.equal(tocaveis(await pedir(ctx, 2, 3)).length, 1);
  const outra = montar({ rows: [row(3, 'The Last of Us S02')], files: { 3: lista('The.Last.of.Us.S02E03.mkv') } });
  assert.deepEqual(await pedir(outra, 1, 3), [], 'outra temporada: não oferece e não avisa');
  assert.deepEqual(outra.calls.files, [], 'o nome já contradiz o pedido: nem lê a página');
});

test('toca: título do episódio depois do identificador (The Bear)', async () => {
  const ctx = montar({ rows: [row(4, 'The Bear S01')], files: { 4: lista('The.Bear.S01E01.System.mkv', 'The.Bear.S01E02.Hands.mkv', 'The.Bear.S01E08.Braciole.mkv') } });
  assert.equal(tocaveis(await pedir(ctx, 1, 8)).length, 1);
});

test('toca: raiz "Série (ano)" com pastas Temporada 01..05 e nome livre', async () => {
  const files = [];
  for (let s = 1; s <= 5; s += 1) for (let e = 1; e <= 3; e += 1) files.push(`Stranger Things (2016)/Temporada ${p2(s)}/Stranger.Things.S${p2(s)}E${p2(e)}.mkv`);
  const ctx = montar({ rows: [row(5, 'Stranger Things - Completo')], files: { 5: lista(...files) } });
  assert.equal(tocaveis(await pedir(ctx, 5, 3)).length, 1);
});

test('toca: episódio avulso com um só MKV (não vira filme); outro episódio não é oferecido', async () => {
  const ctx = montar({ rows: [row(6, 'Dexter Resurrection S02E03')], files: { 6: lista('Dexter.Resurrection.S02E03.1080p.mkv') } });
  assert.equal(tocaveis(await pedir(ctx, 2, 3)).length, 1);
  assert.deepEqual(await pedir(ctx, 2, 4), [], 'o nome declara E03: não serve ao E04 e não gera aviso');
});

test('toca só quando o identificador coincide: episódio de quatro dígitos (One Piece S23E1180)', async () => {
  const ctx = montar({ rows: [row(7, 'One Piece S23E1180')], files: { 7: lista('One.Piece.S23E1180.1080p.mkv') } });
  assert.equal(tocaveis(await pedir(ctx, 23, 1180)).length, 1, 'o Stremio pediu o mesmo identificador do release');
  // O Cinemeta numera o mesmo episódio como 23:25: não há conversão, então não é oferecido (sem aviso:
  // o release tem identidade de episódio, só não é o pedido).
  assert.deepEqual(await pedir(ctx, 23, 25), []);
});

test('toca só quando coincide: temporada de anime com numeração S34E864', async () => {
  const ctx = montar({ rows: [row(8, 'One Piece - S34')], files: { 8: lista(...seq(14, (n) => `One.Piece.S34E${863 + n}.mkv`)) } });
  assert.equal(tocaveis(await pedir(ctx, 34, 864)).length, 1);
  assert.deepEqual(await pedir(ctx, 34, 5), [], 'o E5 do Cinemeta não é o E864 do release: não adivinha');
});

test('toca: caminhos com barra invertida (Windows) e ordem embaralhada', async () => {
  const ctx = montar({ rows: [row(9, 'Show Completo')], files: { 9: lista('Show\\Temporada 02\\Show.S02E02.mkv', 'Show\\capa.jpg', 'Show\\Temporada 01\\Show.S01E03.mkv', 'Show\\Temporada 02\\Show.S02E01.mkv') } });
  assert.equal(tocaveis(await pedir(ctx, 2, 2)).length, 1);
  assert.deepEqual(await pedir(ctx, 1, 1), [], 'a lista não tem o S01E01: não oferece');
});

// ---- Não suportado, com mensagem -----------------------------------------------------------------

test('não suportado: pack legado "Temporada N/01 Título.mkv" com filme e imagens (Breaking Bad + El Camino)', async () => {
  const files = [
    'Breaking Bad (2008)/banner.jpg',
    'Breaking Bad (2008)/El Camino/El Camino.2019.mkv',
    ...seq(7, (n) => `Breaking Bad (2008)/Temporada 1/Breaking Bad A Química Do Mal ${p2(n)} Título.mkv`),
    ...seq(13, (n) => `Breaking Bad (2008)/Temporada 2/Breaking Bad A Química Do Mal ${p2(n)} Título.mkv`),
    'Breaking Bad (2008)/Temporada 1/cena.png',
  ];
  const ctx = montar({ rows: [row(10, 'Breaking Bad + El Camino Completo')], files: { 10: lista(...files) } });
  const streams = await pedir(ctx, 1, 1);
  assert.deepEqual(tocaveis(streams), [], 'não assume que "01" é S01E01: risco de tocar o episódio errado');
  assert.equal(avisos(streams).length, 1);
  assert.match(avisos(streams)[0].description, /1 release/);
  assert.match(avisos(streams)[0].description, /sem temporada/);
});

test('não suportado: legado "EP01" em subpasta por episódio, com Legenda/ ao lado (Irmãos de Guerra, #70)', async () => {
  const files = [];
  for (let n = 1; n <= 10; n += 1) {
    const raiz = `Irmaos.de.Guerra.2001.EP${p2(n)}.BRRip.1080p.AVC-AXS.DUAL-VET`;
    files.push(`${raiz}/Irmaos.de.Guerra.2001.EP${p2(n)}.BRRip.1080p.AVC-AXS.DUAL-VET.mkv`, `${raiz}/Legenda/Irmaos.de.Guerra.EP${p2(n)}.srt`);
  }
  const ctx = montar({ rows: [row(70, 'Irmãos de Guerra - Completo')], files: { 70: lista(...files) } });
  const streams = await pedir(ctx, 1, 5, 'tt0185906');
  assert.deepEqual(tocaveis(streams), [], 'EP05 não é assumido como S01E05');
  assert.equal(avisos(streams).length, 1, 'antes, o release sumia em silêncio');
  assert.equal(streams.some((s) => s.subtitles), false, 'legendas do pack não são expostas pelo addon');
});

test('não suportado: One Piece Projeto One Pace (Saga/Arco), mesma mensagem', async () => {
  const files = [
    'Saga 1 - East Blue/Arco 1 - Romance Dawn/One Pace - Romance Dawn - 01.mkv',
    'Saga 1 - East Blue/Arco 1 - Romance Dawn/One Pace - Romance Dawn - 02.mkv',
    'Saga 6 - Marineford/Arco 24 - Post-War/One Pace - Post-War - 08.mkv',
  ];
  const ctx = montar({ rows: [row(11, 'One Piece - Projeto One Pace')], files: { 11: lista(...files) } });
  const streams = await pedir(ctx, 1, 1, 'tt0388629');
  assert.deepEqual(tocaveis(streams), []);
  assert.equal(avisos(streams).length, 1);
  assert.match(avisos(streams)[0].description, /sem temporada/);
});

test('não suportado: Full Disc / ISO tem mensagem própria de imagem de disco', async () => {
  const ctx = montar({ rows: [row(12, 'Show S01 Full Disc BD50', 10, { badges: [{ label: 'BD50', kind: 'source' }] })], files: { 12: lista('Show.S01.BD50.iso') } });
  const streams = await pedir(ctx, 1, 1);
  assert.deepEqual(tocaveis(streams), []);
  assert.equal(avisos(streams).length, 1);
  assert.match(avisos(streams)[0].description, /disco/i);
});

test('não suportado: estrutura de disco BDMV com .m2ts (vídeo que o parser não identifica)', async () => {
  const ctx = montar({ rows: [row(13, 'Show Temporada 1 Full Disc')], files: { 13: lista('Show/BDMV/STREAM/00001.m2ts', 'Show/BDMV/STREAM/00002.m2ts') } });
  const streams = await pedir(ctx, 1, 1);
  assert.equal(avisos(streams).length, 1);
  assert.match(avisos(streams)[0].description, /disco/i);
});

test('não suportado: disco com caminhos do Windows (barra invertida) também é reconhecido como disco', async () => {
  const ctx = montar({ rows: [row(18, 'Show Temporada 1')], files: { 18: lista('Show\\BDMV\\STREAM\\00001.m2ts') } });
  assert.match(avisos(await pedir(ctx, 1, 1))[0].description, /disco/i);
});

test('não suportado: MiXED e nomes ambíguos (vários SxxExx no mesmo nome) não são adivinhados', async () => {
  const ctx = montar({ rows: [row(14, 'Show MiXED')], files: { 14: lista('Show.S01E01.S02E01.MiXED.mkv', 'Show.S01E02.S02E02.MiXED.mkv') } });
  const streams = await pedir(ctx, 1, 1);
  assert.deepEqual(tocaveis(streams), []);
  assert.equal(avisos(streams).length, 1);
});

test('não oferecido (sem aviso): dois arquivos dizem ser o mesmo episódio -> conflito, não escolhe', async () => {
  const ctx = montar({ rows: [row(15, 'Show S01')], files: { 15: lista('Show.S01E01.1080p.mkv', 'Show.S01E01.720p.mkv') } });
  assert.deepEqual(await pedir(ctx, 1, 1), []);
});

test('legado com caminhos do Windows (barra invertida) também é não suportado', async () => {
  const ctx = montar({ rows: [row(16, 'Série Completo')], files: { 16: lista('Série\\EP01\\Série.EP01.mkv', 'Série\\EP01\\Legenda\\Série.EP01.srt') } });
  assert.equal(avisos(await pedir(ctx, 1, 1)).length, 1);
});

// ---- Quando mostrar o aviso ---------------------------------------------------------------------

test('Band of Brothers: com fonte tocável (47552) o aviso do release 70 é ruído e não aparece', async () => {
  const legado = [];
  for (let n = 1; n <= 10; n += 1) legado.push(`Irmaos.de.Guerra.2001.EP${p2(n)}.BRRip/Irmaos.de.Guerra.2001.EP${p2(n)}.BRRip.mkv`);
  const ctx = montar({
    rows: [row(70, 'Irmãos de Guerra - Completo', 16), row(47552, 'Band of Brothers - S01', 6)],
    files: { 70: lista(...legado), 47552: lista(...seq(10, (n) => `Band.of.Brothers.S01E${p2(n)}.mkv`)) },
  });
  const streams = await pedir(ctx, 1, 5, 'tt0185906');
  assert.deepEqual(tocaveis(streams).map((s) => s.url), ['http://x/e/47552/1/5']);
  assert.deepEqual(avisos(streams), []);
});

test('sem nenhuma fonte tocável o aviso é essencial: diz quantos releases e por quê, sem prometer nada', async () => {
  const ctx = montar({
    rows: [row(70, 'Irmãos de Guerra - Completo'), row(71, 'Outra Versão Completo'), row(72, 'Mais Uma Completo')],
    files: Object.fromEntries([70, 71, 72].map((id) => [id, lista('Raiz/EP01/ep01.mkv', 'Raiz/EP02/ep02.mkv')])),
  });
  const streams = await pedir(ctx, 1, 2);
  assert.equal(streams.length, 1, 'um item agregado, não um por release');
  const [aviso] = streams;
  assert.equal(aviso.url, undefined, 'item informativo: não toca');
  assert.ok(aviso.externalUrl);
  assert.match(aviso.name, /não suportado/i);
  assert.match(aviso.description, /3 releases/);
  assert.match(aviso.description, /EP01/);
  assert.doesNotMatch(aviso.description, /em breve|futuro|será|passkey|ratio|cookie|\?k=/i);
});

test('o aviso abre o painel quando o status está liberado e o site do ASC quando não está', async () => {
  const dados = { rows: [row(1, 'Show Completo')], files: { 1: lista('Raiz/EP01/ep01.mkv') } };
  // Com o status liberado o alerta de risco (se houver) vem primeiro; o aviso fica por último.
  const com = await pedir(montar({ ...dados, panel: true }), 1, 1);
  assert.equal(avisos(com).at(-1).externalUrl, 'http://127.0.0.1:7020/');
  const sem = await pedir(montar(dados), 1, 1);
  assert.equal(avisos(sem)[0].externalUrl, 'https://amigos-share.club/');
});

test('motivos diferentes viram linhas diferentes no mesmo item', async () => {
  const ctx = montar({
    rows: [row(1, 'Show Completo'), row(2, 'Show Temporada 1 Full Disc')],
    files: { 1: lista('Raiz/EP01/ep01.mkv'), 2: lista('Show.iso') },
  });
  const streams = await pedir(ctx, 1, 1);
  assert.equal(streams.length, 1);
  assert.match(streams[0].description, /2 releases/);
  assert.match(streams[0].description, /• nomes dos arquivos/);
  assert.match(streams[0].description, /• imagem ou estrutura de disco/);
});

test('release de outra temporada ou episódio (excluído pelo nome) nunca gera aviso', async () => {
  const ctx = montar({ rows: [row(1, 'Show S02 EP01'), row(2, 'Show S01E09')], files: { 1: lista('EP01/a.mkv'), 2: lista('EP01/b.mkv') } });
  assert.deepEqual(await pedir(ctx, 1, 1), []);
  assert.deepEqual(ctx.calls.files, [], 'e nem lê a página deles');
});

test('lista de arquivos incompleta não prova nada: segue candidato a confirmar, sem aviso', async () => {
  const ctx = montar({ rows: [row(1, 'Show Completo')], files: { 1: { files: [{ path: 'Raiz/EP01/ep01.mkv', size: GB }], total: 150, complete: false } } });
  const streams = await pedir(ctx, 1, 1);
  assert.equal(tocaveis(streams).length, 1);
  assert.deepEqual(avisos(streams), []);
});

test('release com parte dos vídeos identificada é suportado: sem aviso, mesmo sem o episódio pedido', async () => {
  const ctx = montar({ rows: [row(1, 'Show Completo')], files: { 1: lista('Show.S01E01.mkv', 'Extras/making-of.mkv') } });
  assert.deepEqual(await pedir(ctx, 1, 2), []);
});

test('sem listar a página (lista vazia e completa) não há o que dizer: sem aviso', async () => {
  const ctx = montar({ rows: [row(1, 'Show Completo')], files: { 1: lista('leia-me.nfo', 'capa.jpg') } });
  assert.deepEqual(await pedir(ctx, 1, 1), []);
});

// ---- Listar não baixa nem consulta mais nada ------------------------------------------------------

test('o aviso não custa requisição: uma busca, uma página por release, nenhum .torrent', async () => {
  const ctx = montar({
    rows: [row(70, 'Irmãos de Guerra - Completo'), row(71, 'Outra Completo')],
    files: { 70: lista('A/EP01/a.mkv'), 71: lista('B/EP01/b.mkv') },
  });
  const streams = await pedir(ctx, 1, 1);
  assert.equal(avisos(streams).length, 1);
  assert.equal(ctx.calls.searches, 1);
  assert.deepEqual(ctx.calls.files.sort(), ['70', '71'], 'mesma leitura de página que já existia, sem chamada extra');
  assert.equal(ctx.calls.downloads, 0);
  assert.equal(ctx.calls.outras, 0, 'nada de history/idioma só por causa do aviso');
  await pedir(ctx, 1, 2); // segundo pedido: as listas completas vêm do cache
  assert.equal(ctx.calls.files.length, 2);
  assert.equal(ctx.calls.downloads, 0);
});
