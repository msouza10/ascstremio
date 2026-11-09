const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainVideo } = require('../src/library');

const v = (path, length, isVideo = true) => ({ path, length, isVideo });
const GB = 1024 ** 3;

test('mainVideo: um vídeo só, com ou sem arquivos que não são vídeo', () => {
  assert.equal(mainVideo([v('a.mkv', 5 * GB)]).path, 'a.mkv');
  assert.equal(mainVideo([v('a.mkv', 5 * GB), v('leia.nfo', 10, false), v('legenda.srt', 90, false)]).path, 'a.mkv');
});

test('mainVideo: filme + extras pequenos = o filme (caso real do asc-467)', () => {
  const real = [v('The.Martian.mkv', 6.59 * GB), v('ARES archive.mkv', 0.02 * GB), v('ARES live.mkv', 0.02 * GB), v('Occupy Mars.mkv', 0.07 * GB), v('Making of.mkv', 0.07 * GB)];
  assert.equal(mainVideo(real).path, 'The.Martian.mkv');
  assert.equal(mainVideo([...real].reverse()).path, 'The.Martian.mkv', 'a ordem dos arquivos não importa');
});

test('mainVideo: vídeos de tamanho parecido (trilogia, CD1/CD2, pack) não têm filme principal', () => {
  assert.equal(mainVideo([v('1.mkv', 4 * GB), v('2.mkv', 4.2 * GB), v('3.mkv', 3.9 * GB)]), null);
  assert.equal(mainVideo([v('cd1.avi', 700e6), v('cd2.avi', 700e6)]), null);
  // o maior domina pouco: 60% do total e só 1,5x o segundo
  assert.equal(mainVideo([v('a.mkv', 6 * GB), v('b.mkv', 4 * GB)]), null);
});

test('mainVideo: sem vídeo (ISO, RAR) ou lista vazia devolve null', () => {
  assert.equal(mainVideo([v('disco.iso', 20 * GB, false)]), null);
  assert.equal(mainVideo([]), null);
  assert.equal(mainVideo(undefined), null);
});
