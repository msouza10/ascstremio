const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { tmpdir } = require('./tmp-helper');

const HASH = 'a'.repeat(40);
const OUTRO = 'b'.repeat(40);
const MIN = 60_000;

const pack = (hash = HASH, dir = 'P') => ({
  infoHash: hash, name: 'Pack', title: 'Pack', freeleech: true,
  files: [
    { index: 0, path: `${dir}/P.S01E01.mkv`, length: 10, isVideo: true },
    { index: 1, path: `${dir}/P.S01E02.mkv`, length: 10, isVideo: true },
    { index: 2, path: `${dir}/P.S01E03.mkv`, length: 10, isVideo: true },
    { index: 3, path: `${dir}/banner.jpg`, length: 4, isVideo: false },
  ],
});

// Bridge com armazenamento real em disco e motor simulado. `aberto` põe o torrent no motor.
function cenario({ aberto = true, ...over } = {}) {
  const store = tmpdir('excluir-ep-');
  const vault = new SeedVault({ file: path.join(tmpdir('excluir-v-'), 'v.json') });
  const lib = pack();
  fs.mkdirSync(path.join(store, 'P'));
  for (const f of lib.files) fs.writeFileSync(path.join(store, f.path), Buffer.alloc(f.length, 1));
  vault.markSeen(HASH, { name: 'Pack', freeleech: true });
  vault.markCompleted(HASH);
  vault.setBackground(HASH, true);
  const b = new Bridge({ torrentDir: '/tmp', storeDir: store, port: 7094, vault, minFreeBytes: 1000, freeSpace: () => 1e12,
    backgroundMode: 'auto', idleMs: 1000, ...over });
  b.entries.set(HASH, lib);
  const destruidos = [];
  b.client = { torrents: [], get: async () => null };
  if (aberto) {
    b.client.torrents.push({ infoHash: HASH, name: 'Pack', ready: true, done: true, length: 34, progress: 1,
      files: lib.files.map((f) => ({ length: f.length, downloaded: f.length })),
      destroy(opts, cb) { destruidos.push(opts); b.client.torrents.splice(0); cb(); } });
  }
  return { b, vault, store, lib, destruidos, existe: (i) => fs.existsSync(path.join(store, lib.files[i].path)) };
}

test('excluir um episódio apaga só esse arquivo, para o motor e preserva a obrigação', async () => {
  const s = cenario();
  const r = await s.b.excludeFile(HASH, 1);
  assert.equal(r.file, 1);
  assert.deepEqual([0, 1, 2, 3].map(s.existe), [true, false, true, true], 'só o episódio escolhido some');
  assert.deepEqual(s.destruidos, [{ destroyStore: false }], 'o motor é parado sem apagar o armazenamento');
  const e = s.vault.get(HASH);
  assert.deepEqual(e.excluded, [1]);
  assert.equal(e.backgroundComplete, false, 'nada volta a baixar sozinho');
  assert.ok(e.completedAt, 'a obrigação de 72 h continua registrada (o tracker não a cancela)');
  assert.equal(e.satisfiedAt, null);
});

test('a exclusão sobrevive a reiniciar o cofre', async () => {
  const s = cenario();
  await s.b.excludeFile(HASH, 2);
  const reaberto = new SeedVault({ file: s.vault.file });
  assert.deepEqual(reaberto.get(HASH).excluded, [2]);
});

test('sem o torrent no motor também exclui, sem tentar parar nada', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 0);
  assert.equal(s.existe(0), false);
  assert.deepEqual(s.vault.get(HASH).excluded, [0]);
});

test('recusa: índice inválido, arquivo que não é vídeo e conteúdo que não é pack', async () => {
  const s = cenario();
  await assert.rejects(s.b.excludeFile(HASH, -1), { status: 400 });
  await assert.rejects(s.b.excludeFile('xyz', 0), { status: 400 });
  await assert.rejects(s.b.excludeFile(HASH, 3), { status: 404 }, 'o banner não é episódio');
  await assert.rejects(s.b.excludeFile(HASH, 99), { status: 404 });
  await assert.rejects(s.b.excludeFile(OUTRO, 0), { status: 404 }, 'fora da biblioteca');
  const filme = { infoHash: OUTRO, name: 'Filme', title: 'Filme', files: [{ index: 0, path: 'F/F.mkv', length: 10, isVideo: true }] };
  s.b.entries.set(OUTRO, filme);
  s.vault.markSeen(OUTRO, { name: 'Filme' });
  await assert.rejects(s.b.excludeFile(OUTRO, 0), { status: 409 }, 'filme usa a exclusão do torrent');
  assert.deepEqual([0, 1, 2, 3].map(s.existe), [true, true, true, true], 'nada foi apagado');
  assert.equal(s.vault.get(HASH).excluded, undefined);
});

test('recusa com reprodução aberta ou operação em andamento, sem tocar em nada', async () => {
  const s = cenario();
  s.b.streams.set(HASH, 1);
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  s.b.streams.delete(HASH);
  s.b.retention.retiring.add(HASH);
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  s.b.retention.retiring.delete(HASH);
  assert.equal(s.existe(1), true);
  assert.equal(s.destruidos.length, 0, 'o motor nem foi parado');
  assert.equal(s.vault.get(HASH).backgroundComplete, true, 'a escolha anterior não mudou');
});

test('recusa arquivo compartilhado com outro conteúdo', async () => {
  const s = cenario();
  s.b.entries.set(OUTRO, pack(OUTRO, 'P')); // mesmos caminhos
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  assert.equal(s.existe(1), true);
});

test('recusa link simbólico no lugar do arquivo', { skip: process.platform === 'win32' }, async () => {
  const s = cenario();
  const alvo = path.join(s.store, 'P', 'alvo.bin');
  fs.writeFileSync(alvo, 'x');
  fs.rmSync(path.join(s.store, s.lib.files[1].path));
  fs.symlinkSync(alvo, path.join(s.store, s.lib.files[1].path));
  await assert.rejects(s.b.excludeFile(HASH, 1), { status: 409 });
  assert.equal(fs.existsSync(alvo), true, 'o alvo do link está intacto');
});

test('com exclusão registrada a conclusão automática não baixa o pack sozinha', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 1);
  const selecoes = [];
  s.b.client.torrents.push({ infoHash: HASH, name: 'Pack', ready: true, done: false, length: 34, downloaded: 24, progress: 0.7, pieces: new Array(4),
    files: s.lib.files.map((f, i) => ({ length: f.length, downloaded: i === 1 ? 0 : f.length, select: (p) => selecoes.push([i, p]) })),
    select: (...a) => selecoes.push(['t', ...a]) });
  s.b.startedAt.set(HASH, 0);
  s.b.packFiles.set(HASH, new Map([[0, 10]])); // episódio aberto já inteiro: sem exclusão, começaria agora
  s.b.completionTick(30 * MIN);
  assert.deepEqual(selecoes, [], 'a escolha do usuário vale');
});

test('pedir para concluir limpa a exclusão e volta a baixar o que falta', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 1);
  s.b.getTorrent = async () => ({ name: 'Pack', done: false });
  const r = await s.b.requestCompletion(HASH);
  assert.equal(r.infoHash, HASH);
  assert.deepEqual(s.vault.get(HASH).excluded, [], 'exclusões removidas');
  assert.equal(s.vault.get(HASH).backgroundComplete, true);
});

test('o snapshot marca o episódio excluído e lista as exclusões do título', async () => {
  const s = cenario({ aberto: false });
  await s.b.excludeFile(HASH, 1);
  const item = s.b.snapshot().titles.find((t) => t.infoHash === HASH);
  assert.deepEqual(item.excluded, [1]);
  assert.deepEqual(item.episodes.map((e) => [e.episode, e.excluded]), [[1, false], [2, true], [3, false]]);
  assert.equal(item.episodes[1].state, 'ausente');
  assert.equal(item.state, 'missing', 'concluído no tracker mas sem o arquivo inteiro: sem arquivo para semear');
});

test('liberar uma exclusão devolve só aquele arquivo', () => {
  const vault = new SeedVault({ file: path.join(tmpdir('excluir-v2-'), 'v.json') });
  vault.markSeen(HASH, {});
  vault.setExcluded(HASH, 2, true); vault.setExcluded(HASH, 0, true);
  assert.deepEqual(vault.get(HASH).excluded, [0, 2], 'ordenado');
  vault.setExcluded(HASH, 2, false);
  assert.deepEqual(vault.get(HASH).excluded, [0]);
  assert.equal(vault.setExcluded(HASH, -1, true), null, 'índice inválido é ignorado');
  vault.clearExcluded(HASH);
  assert.deepEqual(vault.get(HASH).excluded, []);
});
