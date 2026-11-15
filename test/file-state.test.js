const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fileStates, bytesOnDisk, BLOCK_SLACK } = require('../src/file-state');
const { tmpdir } = require('./tmp-helper');

const GB = 1024 ** 3;
const FILES = [
  { index: 0, path: 'P/P.S01E01.mkv', length: 10 * GB, isVideo: true },
  { index: 1, path: 'P/P.S01E02.mkv', length: 10 * GB, isVideo: true },
  { index: 2, path: 'P/P.S01E03.mkv', length: 10 * GB, isVideo: true },
  { index: 3, path: 'P/banner.jpg', length: 1000, isVideo: false },
];

// stat simulado: arquivo -> bytes alocados (blocks * 512). Ausente = ENOENT.
const statDe = (alocado) => (full) => {
  const key = Object.keys(alocado).find((k) => full.endsWith(k));
  if (!key) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return { isFile: () => true, size: 10 * GB, blocks: Math.ceil(alocado[key] / 512) };
};

test('motor aberto: o estado vem das peças verificadas, exato', () => {
  const torrent = { ready: true, files: [
    { length: 10 * GB, downloaded: 10 * GB }, { length: 10 * GB, downloaded: 3 * GB },
    { length: 10 * GB, downloaded: 0 }, { length: 1000, downloaded: 1000 }] };
  const r = fileStates({ files: FILES, torrent, storeDir: '/x' });
  assert.deepEqual(r.map((f) => f.state), ['completo', 'parcial', 'ausente', 'completo']);
  assert.deepEqual(r.map((f) => f.verified), [true, true, true, true]);
  assert.equal(r[1].onDisk, 3 * GB);
});

test('motor aberto: downloaded acima do tamanho é limitado ao tamanho', () => {
  const torrent = { ready: true, files: [{ length: 10 * GB, downloaded: 11 * GB }] };
  const [f] = fileStates({ files: [FILES[0]], torrent, storeDir: '/x' });
  assert.equal(f.onDisk, 10 * GB);
  assert.equal(f.state, 'completo');
});

test('só disco: cheio é apenas "provável" e nunca verificado', () => {
  const stat = statDe({ 'S01E01.mkv': 10 * GB, 'S01E02.mkv': 4 * GB });
  const r = fileStates({ files: FILES, storeDir: '/x', statFn: stat });
  assert.deepEqual(r.map((f) => f.state), ['provavel', 'parcial', 'ausente', 'ausente']);
  assert.equal(r.every((f) => f.verified === false), true, 'sem o motor nada é verificado');
});

test('só disco: tamanho aparente não conta, vale o espaço alocado', () => {
  // arquivo com 10 GB aparentes e 150 MB alocados (esparso de um streaming parcial)
  const stat = statDe({ 'S01E01.mkv': 150 * 1024 * 1024 });
  const [f] = fileStates({ files: [FILES[0]], storeDir: '/x', statFn: stat });
  assert.equal(f.state, 'parcial');
  assert.equal(f.onDisk, 150 * 1024 * 1024);
});

test('só disco: a folga de arredondamento do sistema de arquivos não derruba um arquivo cheio', () => {
  const stat = statDe({ 'S01E01.mkv': 10 * GB - BLOCK_SLACK });
  const [f] = fileStates({ files: [FILES[0]], storeDir: '/x', statFn: stat });
  assert.equal(f.state, 'provavel');
  const parcial = statDe({ 'S01E01.mkv': 10 * GB - BLOCK_SLACK - 4096 });
  assert.equal(fileStates({ files: [FILES[0]], storeDir: '/x', statFn: parcial })[0].state, 'parcial');
});

test('motor aberto com arquivo de outro tamanho cai para o disco em vez de confiar', () => {
  const torrent = { ready: true, files: [{ length: 5, downloaded: 5 }] };
  const stat = statDe({ 'S01E01.mkv': 2 * GB });
  const [f] = fileStates({ files: [FILES[0]], torrent, storeDir: '/x', statFn: stat });
  assert.equal(f.verified, false);
  assert.equal(f.state, 'parcial');
});

test('motor ainda abrindo (sem ready) usa o disco', () => {
  const torrent = { ready: false, files: [{ length: 10 * GB, downloaded: 10 * GB }] };
  const stat = statDe({ 'S01E01.mkv': GB });
  const [f] = fileStates({ files: [FILES[0]], torrent, storeDir: '/x', statFn: stat });
  assert.equal(f.verified, false);
  assert.equal(f.onDisk, GB);
});

test('arquivo que não é comum e erros de leitura contam como ausente, sem derrubar', () => {
  assert.equal(bytesOnDisk('/x/a', 100, () => ({ isFile: () => false, size: 100 })), 0);
  assert.equal(bytesOnDisk('/x/a', 100, () => { throw new Error('EACCES'); }), 0);
  assert.equal(fileStates({ files: undefined, storeDir: '/x' }).length, 0);
});

test('arquivo real: o espaço alocado manda, não o tamanho aparente', { skip: process.platform === 'win32' }, () => {
  const dir = tmpdir('file-state-');
  const full = path.join(dir, 'ep.mkv');
  const size = 4 * 1024 * 1024;
  const fd = fs.openSync(full, 'w');
  fs.ftruncateSync(fd, size); // esparso: tamanho aparente cheio, nada alocado
  const file = { index: 0, path: 'ep.mkv', length: size, isVideo: true };
  const vazio = fileStates({ files: [file], storeDir: dir })[0];
  assert.notEqual(vazio.state, 'provavel', 'esparso vazio não pode parecer cheio');
  fs.writeSync(fd, Buffer.alloc(size, 1), 0, size, 0);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const cheio = fileStates({ files: [file], storeDir: dir })[0];
  assert.equal(cheio.state, 'provavel');
  assert.equal(cheio.verified, false);
});
