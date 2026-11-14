const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseEpisode, buildEpisodeIndex, findEpisode, scopeOfName, nameExcludes } = require('../src/episodes');
const { describeEntry } = require('../src/library');

const GB = 1024 ** 3;
// Arquivos sintéticos no formato de `readTorrent`; o índice é a posição REAL no torrent.
const files = (...items) => items.map(([path, length = GB, isVideo = true], index) => ({ index, path, length, isVideo }));
const entryOf = (list) => ({ infoHash: 'a'.repeat(40), name: 'Release', size: 1, files: list });

test('parseEpisode: formatos comuns de SxxExx', () => {
  assert.deepEqual(parseEpisode('Show.S01E07.1080p.mkv'), { season: 1, episode: 7, confidence: 'media', source: 'arquivo' });
  assert.equal(parseEpisode('show s02e10 web.mkv').season, 2);
  assert.equal(parseEpisode('Show.S03.E04.mkv').episode, 4);
  assert.equal(parseEpisode('Show.S03-E04.mkv').episode, 4);
});

test('parseEpisode: resolução depois do episódio não vira episódio duplo', () => {
  for (const nome of ['Show.S01E07.1080p.mkv', 'Show.S01E07-720p.mkv', 'Show.S01E07.2160p.x265.mkv', 'Show S01E07 480i.mkv']) {
    const id = parseEpisode(nome);
    assert.equal(id.episode, 7, nome);
    assert.equal(id.episodeEnd, undefined, nome);
  }
});

test('parseEpisode: o título do episódio depois do identificador não confunde (The Bear)', () => {
  const id = parseEpisode('The.Bear.S01E01.System.mkv');
  assert.equal(id.season, 1);
  assert.equal(id.episode, 1);
  assert.equal(id.episodeEnd, undefined);
});

test('parseEpisode: episódio de quatro dígitos e temporada zero', () => {
  assert.deepEqual(
    (({ season, episode }) => ({ season, episode }))(parseEpisode('One.Piece.S23E1180.mkv')),
    { season: 23, episode: 1180 },
  );
  assert.equal(parseEpisode('Show.S00E03.Especial.mkv').season, 0);
});

test('parseEpisode: episódio duplo', () => {
  for (const nome of ['Show.S01E01E02.mkv', 'Show.S01E01-E02.mkv', 'Show.S01E01-02.mkv']) {
    const id = parseEpisode(nome);
    assert.equal(id.episode, 1, nome);
    assert.equal(id.episodeEnd, 2, nome);
  }
  // intervalo absurdo ou invertido não é duplo
  assert.equal(parseEpisode('Show.S01E01-E90.mkv'), null);
  assert.equal(parseEpisode('Show.S01E05-E02.mkv'), null);
});

test('parseEpisode: pasta de temporada confirma (alta) ou contradiz (recusa)', () => {
  assert.equal(parseEpisode('Stranger Things (2016)/Temporada 02/Stranger.Things.S02E03.mkv').confidence, 'alta');
  assert.equal(parseEpisode('Show/Season 1/Show.S01E02.mkv').confidence, 'alta');
  assert.equal(parseEpisode('Show\\S04\\Show.S04E02.mkv').confidence, 'alta', 'separador do Windows');
  assert.equal(parseEpisode('Show/Temporada 03/Show.S02E02.mkv'), null, 'pasta e arquivo discordam');
  assert.equal(parseEpisode('Show/Season 1/Season 2/Show.S01E02.mkv'), null, 'pastas que se contradizem');
});

test('parseEpisode: recusa nome sem SxxExx, com vários ou com episódio zero', () => {
  assert.equal(parseEpisode('Breaking Bad A Química Do Mal 01 Piloto.mkv'), null);
  assert.equal(parseEpisode('Show.S01E01.S02E05.mkv'), null);
  assert.equal(parseEpisode('Show.S01E00.mkv'), null);
  assert.equal(parseEpisode('Filme.2160p.x265.mkv'), null);
  assert.equal(parseEpisode(''), null);
  assert.equal(parseEpisode(undefined), null);
});

test('buildEpisodeIndex: ordem embaralhada mantém o índice real do torrent', () => {
  // Caso real da issue: o índice 0 não é o primeiro episódio.
  const index = buildEpisodeIndex(files(
    ['Show/Show.S01E03.mkv'], ['Show/Show.S01E01.mkv'], ['Show/banner.jpg', 1000, false], ['Show/Show.S01E02.mkv'],
  ));
  assert.equal(findEpisode(index, 1, 1).file.index, 1);
  assert.equal(findEpisode(index, 1, 2).file.index, 3);
  assert.equal(findEpisode(index, 1, 3).file.index, 0);
  assert.deepEqual(index.auxiliary, [2]);
  assert.deepEqual(index.conflicts, []);
});

test('buildEpisodeIndex: temporada 2 e episódio ausente', () => {
  const index = buildEpisodeIndex(files(['The.Last.of.Us.S02E01.mkv'], ['The.Last.of.Us.S02E02.mkv']));
  assert.equal(findEpisode(index, 2, 2).file.index, 1);
  assert.equal(findEpisode(index, 1, 2), null, 'outra temporada');
  assert.equal(findEpisode(index, 2, 9), null, 'episódio que o torrent não tem');
});

test('buildEpisodeIndex: números repetidos entre temporadas ficam separados', () => {
  const index = buildEpisodeIndex(files(
    ['Show/Temporada 01/Show.S01E01.mkv'], ['Show/Temporada 02/Show.S02E01.mkv'],
  ));
  assert.equal(findEpisode(index, 1, 1).file.index, 0);
  assert.equal(findEpisode(index, 2, 1).file.index, 1);
});

test('buildEpisodeIndex: dois arquivos para o mesmo episódio são conflito (recusa)', () => {
  const index = buildEpisodeIndex(files(['Show.S01E01.1080p.mkv'], ['Show.S01E01.720p.mkv'], ['Show.S01E02.mkv']));
  assert.deepEqual(index.conflicts, ['1:1']);
  assert.deepEqual(findEpisode(index, 1, 1), { conflict: true });
  assert.equal(findEpisode(index, 1, 2).file.index, 2);
});

test('buildEpisodeIndex: episódio duplo atende aos dois números', () => {
  const index = buildEpisodeIndex(files(['Show.S01E01E02.mkv'], ['Show.S01E03.mkv']));
  assert.equal(findEpisode(index, 1, 1).file.index, 0);
  assert.equal(findEpisode(index, 1, 2).file.index, 0);
  assert.equal(findEpisode(index, 1, 3).file.index, 1);
  assert.deepEqual(index.conflicts, []);
});

test('buildEpisodeIndex: legado sem SxxExx, filme e imagens não ganham identidade', () => {
  const index = buildEpisodeIndex(files(
    ['Breaking Bad/Temporada 1/Breaking Bad A Química Do Mal 01 Piloto.mkv'],
    ['Breaking Bad/El Camino/El.Camino.mkv', 2 * GB],
    ['Breaking Bad/banner.jpg', 1000, false],
  ));
  assert.deepEqual(index.episodes, []);
  assert.deepEqual(index.unmatched, [0, 1]);
  assert.deepEqual(index.auxiliary, [2]);
});

test('buildEpisodeIndex: lista vazia ou ausente', () => {
  assert.deepEqual(buildEpisodeIndex([]), { episodes: [], conflicts: [], unmatched: [], auxiliary: [] });
  assert.deepEqual(buildEpisodeIndex(undefined).episodes, []);
});

test('describeEntry: episódio avulso (um só MKV) é série, não filme', () => {
  const item = describeEntry(entryOf(files(['Dexter.Resurrection.S02E03.mkv', 1.5 * GB])));
  assert.equal(item.kind, 'series');
  assert.equal(item.videos.length, 1);
  assert.equal(item.episodes.episodes[0].episode, 3);
});

test('describeEntry: temporada vira série com todos os vídeos', () => {
  const item = describeEntry(entryOf(files(['Show.S01E01.mkv'], ['Show.S01E02.mkv'], ['leia.nfo', 10, false])));
  assert.equal(item.kind, 'series');
  assert.equal(item.videos.length, 2);
});

test('describeEntry: filme com extras continua filme (regressão)', () => {
  const item = describeEntry(entryOf(files(['The.Martian.mkv', 6.59 * GB], ['Making of.mkv', 0.07 * GB])));
  assert.equal(item.kind, 'movie');
  assert.deepEqual(item.videos.map((v) => v.path), ['The.Martian.mkv']);
  assert.deepEqual(item.episodes.episodes, []);
});

test('describeEntry: pack sem SxxExx continua série pela heurística antiga', () => {
  const item = describeEntry(entryOf(files(['Trilogia 1.mkv', 4 * GB], ['Trilogia 2.mkv', 4.2 * GB])));
  assert.equal(item.kind, 'series');
  assert.equal(item.videos.length, 2);
  assert.equal(item.episodes.unmatched.length, 2);
});

test('describeEntry: sem vídeo devolve null', () => {
  assert.equal(describeEntry(entryOf(files(['disco.iso', 20 * GB, false]))), null);
});

test('scopeOfName: episódio, temporada e formas em português', () => {
  assert.deepEqual(scopeOfName('Dexter Resurrection S02E03 1080p'), { season: 2, episode: 3 });
  assert.deepEqual(scopeOfName('Breaking.Bad.S01.1080p.BluRay'), { season: 1, episode: null });
  assert.deepEqual(scopeOfName('The Bear - Temporada 2 - 1080p'), { season: 2, episode: null });
  assert.deepEqual(scopeOfName('Stranger Things 3ª Temporada'), { season: 3, episode: null });
  assert.deepEqual(scopeOfName('Show Season 4 WEB-DL'), { season: 4, episode: null });
});

test('scopeOfName: sem escopo, intervalo ou ambíguo devolve null (não afirma nada)', () => {
  assert.equal(scopeOfName('Breaking Bad Completo 1080p'), null);
  assert.equal(scopeOfName('Show S01-S05 Complete'), null);
  assert.equal(scopeOfName('Show Temporadas 1 a 5'), null);
  assert.equal(scopeOfName('Show S01 S02'), null);
  assert.deepEqual(scopeOfName('Show Temporada 2 - 1080p'), { season: 2, episode: null }, 'resolução não é fim de intervalo');
  assert.equal(scopeOfName('Show S01E01 S02E05'), null);
  assert.equal(scopeOfName(undefined), null);
});

test('nameExcludes: só descarta o que o nome contradiz com clareza', () => {
  assert.equal(nameExcludes('Show S02 1080p', 1, 3), true, 'outra temporada');
  assert.equal(nameExcludes('Show S01E05', 1, 3), true, 'outro episódio');
  assert.equal(nameExcludes('Show S01', 1, 3), false, 'a temporada pode ter o episódio');
  assert.equal(nameExcludes('Show S01E01E03', 1, 3), false, 'episódio duplo declarado E01E03 cobre o intervalo 1 a 3');
  assert.equal(nameExcludes('Show Completo', 1, 3), false, 'sem escopo: candidato');
  assert.equal(nameExcludes('Show S01-S05', 4, 1), false, 'intervalo: candidato');
});
