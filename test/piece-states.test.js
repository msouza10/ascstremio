const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { tmpdir } = require('./tmp-helper');

const HASH = 'a'.repeat(40);
// Arquivos de 16 KiB: no NTFS, arquivo minúsculo é gravado na MFT e não aloca blocos (estado seria 'ausente').
const PL = 8192;
const DADOS = [Buffer.alloc(16384, 1), Buffer.alloc(16384, 2), Buffer.alloc(16384, 3)]; // peças alinhadas: sem borda
const tudo = Buffer.concat(DADOS);
const pieces = [];
for (let o = 0; o < tudo.length; o += PL) pieces.push(createHash('sha1').update(tudo.subarray(o, o + PL)).digest('hex'));

function cenario({ conteudos = DADOS, aberto = false } = {}) {
  const store = tmpdir('piece-states-');
  const lib = { infoHash: HASH, name: 'Pack', title: 'Pack', freeleech: true, torrentPath: '/x/asc-1.torrent',
    files: DADOS.map((d, i) => ({ index: i, path: `P/P.S01E0${i + 1}.mkv`, length: d.length, isVideo: true })) };
  fs.mkdirSync(path.join(store, 'P'));
  lib.files.forEach((f, i) => conteudos[i] && fs.writeFileSync(path.join(store, f.path), conteudos[i]));
  const vault = new SeedVault({ file: path.join(tmpdir('piece-states-v-'), 'v.json') });
  vault.markSeen(HASH, { name: 'Pack', freeleech: true });
  const lidos = [];
  const b = new Bridge({ torrentDir: '/tmp', storeDir: store, port: 7097, vault, minFreeBytes: 1000, freeSpace: () => 1e12,
    loadPieceMeta: async (file) => { lidos.push(file); return { pieceLength: PL, pieces, length: tudo.length, files: lib.files.map((f) => ({ path: f.path, length: f.length })) }; } });
  b.entries.set(HASH, lib);
  b.client = { torrents: aberto ? [{ infoHash: HASH, ready: true, files: lib.files.map((f) => ({ length: f.length, downloaded: f.length })) }] : [] };
  const eps = () => b.snapshot().titles.find((t) => t.infoHash === HASH).episodes;
  return { b, store, lib, eps, lidos };
}

test('sem verificar, um arquivo cheio em disco é só "provável"', () => {
  const s = cenario();
  assert.deepEqual(s.eps().map((e) => [e.state, e.verified]), [['provavel', false], ['provavel', false], ['provavel', false]]);
});

test('verificar por peças promove a "completo" só o que confere, e o esparso continua sem prova', async () => {
  const s = cenario({ conteudos: [DADOS[0], Buffer.alloc(16384, 0), DADOS[2]] });
  const r = await s.b.verifyEpisodes(HASH);
  assert.deepEqual(s.eps().map((e) => [e.state, e.verified, e.pieceCheck]), [['completo', true, 'ok'], ['provavel', false, 'falhou'], ['completo', true, 'ok']]);
  assert.deepEqual({ ok: r.ok, failed: r.failed }, { ok: 2, failed: 1 });
  assert.deepEqual(s.lidos, ['/x/asc-1.torrent']);
});

test('a prova vale só para o arquivo como estava: mudou depois, volta a "provável"', async () => {
  const s = cenario();
  await s.b.verifyEpisodes(HASH);
  assert.equal(s.eps()[0].state, 'completo');
  const f = path.join(s.store, s.lib.files[0].path);
  fs.writeFileSync(f, Buffer.alloc(16384, 9));
  const depois = new Date(Date.now() + 5000);
  fs.utimesSync(f, depois, depois);
  assert.deepEqual(s.eps().map((e) => e.state), ['provavel', 'completo', 'completo']);
});

test('a prova não sobrevive a reiniciar a ponte (reverifica após reinício)', async () => {
  const s = cenario();
  await s.b.verifyEpisodes(HASH);
  const novo = new Bridge({ torrentDir: '/tmp', storeDir: s.store, port: 7098, vault: s.b.vault, minFreeBytes: 1000, freeSpace: () => 1e12 });
  novo.entries.set(HASH, s.lib);
  novo.client = { torrents: [] };
  assert.equal(novo.snapshot().titles.find((t) => t.infoHash === HASH).episodes[0].state, 'provavel');
});

test('torrent aberto no motor já é exato: não lê disco nem .torrent', async () => {
  const s = cenario({ aberto: true });
  await assert.rejects(s.b.verifyEpisodes(HASH), (e) => e.status === 409);
  assert.deepEqual(s.lidos, []);
});

test('filme, conteúdo desconhecido e verificação já em andamento são recusados', async () => {
  const s = cenario();
  await assert.rejects(s.b.verifyEpisodes('b'.repeat(40)), (e) => e.status === 404);
  await assert.rejects(s.b.verifyEpisodes('zz'), (e) => e.status === 400);
  s.b.entries.set(HASH, { ...s.lib, files: [s.lib.files[0]] });
  await assert.rejects(s.b.verifyEpisodes(HASH), (e) => e.status === 409, 'só pack');
  s.b.entries.set(HASH, s.lib);
  const primeira = s.b.verifyEpisodes(HASH);
  await assert.rejects(s.b.verifyEpisodes(HASH), (e) => e.status === 409);
  await primeira;
});

test('episódio excluído ou ausente não é lido', async () => {
  const s = cenario({ conteudos: [DADOS[0], null, DADOS[2]] });
  const r = await s.b.verifyEpisodes(HASH);
  assert.deepEqual({ ok: r.ok, failed: r.failed }, { ok: 2, failed: 0 }, 'ausente não é falha: não há o que verificar');
  assert.equal(s.eps()[1].state, 'ausente');
});

test('falta de descritores na verificação vira erro claro (503), sem marcar episódios como sem prova', async (t) => {
  const s = cenario();
  const emfile = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
  t.mock.method(fs.promises, 'open', async () => { throw emfile; });
  await assert.rejects(s.b.verifyEpisodes(HASH), (e) => e.status === 503 && e.expose === true);
  t.mock.restoreAll();
  assert.deepEqual(s.eps().map((e) => e.pieceCheck), [null, null, null], 'nada foi gravado como falha');
});
