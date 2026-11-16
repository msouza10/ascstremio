const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyFilesByPieces } = require('../src/piece-check');
const { tmpdir } = require('./tmp-helper');

const PL = 16; // peça pequena para exercitar as bordas

// Pack de 3 arquivos: 20, 12 e 30 bytes (as bordas das peças caem no meio dos arquivos).
const DADOS = [Buffer.alloc(20, 1), Buffer.alloc(12, 2), Buffer.alloc(30, 3)];
const arquivos = DADOS.map((d, i) => ({ path: `P/e${i}.mkv`, length: d.length }));
const tudo = Buffer.concat(DADOS);
const pieces = [];
for (let o = 0; o < tudo.length; o += PL) pieces.push(createHash('sha1').update(tudo.subarray(o, o + PL)).digest('hex'));
const meta = { pieceLength: PL, pieces, files: arquivos, length: tudo.length };

function disco(conteudos = DADOS) {
  const dir = tmpdir('piece-check-');
  fs.mkdirSync(path.join(dir, 'P'));
  conteudos.forEach((d, i) => { if (d) fs.writeFileSync(path.join(dir, arquivos[i].path), d); });
  return dir;
}

test('tudo em disco e íntegro: todos os arquivos conferem peça a peça', async () => {
  const r = await verifyFilesByPieces({ meta, storeDir: disco(), fileIdxs: [0, 1, 2] });
  assert.deepEqual([...r], [[0, true], [1, true], [2, true]]);
});

test('arquivo esparso (tamanho cheio, conteúdo zerado) não conta, mesmo parecendo completo', async () => {
  const r = await verifyFilesByPieces({ meta, storeDir: disco([DADOS[0], Buffer.alloc(12, 0), DADOS[2]]), fileIdxs: [1] });
  assert.equal(r.get(1), false);
});

test('um byte corrompido derruba só o arquivo dono daquela peça', async () => {
  const ruim = Buffer.from(DADOS[2]); ruim[29] ^= 0xff; // última peça, só do arquivo 2
  const r = await verifyFilesByPieces({ meta, storeDir: disco([DADOS[0], DADOS[1], ruim]), fileIdxs: [0, 1, 2] });
  assert.deepEqual([...r], [[0, true], [1, true], [2, false]]);
});

test('peça de borda compartilhada: sem o vizinho em disco o arquivo não se confirma', async () => {
  // o arquivo 0 (0-19) divide a peça 1 (16-31) com o arquivo 1: sem o 1, não dá para conferir o 0
  const r = await verifyFilesByPieces({ meta, storeDir: disco([DADOS[0], null, DADOS[2]]), fileIdxs: [0] });
  assert.equal(r.get(0), false, 'conservador: não afirma o que não consegue provar');
});

test('arquivo ausente ou menor que o esperado é falso, sem lançar', async () => {
  const curto = DADOS[2].subarray(0, 10);
  const r = await verifyFilesByPieces({ meta, storeDir: disco([DADOS[0], DADOS[1], curto]), fileIdxs: [2] });
  assert.equal(r.get(2), false);
  const vazio = await verifyFilesByPieces({ meta, storeDir: disco([null, null, null]), fileIdxs: [0, 1, 2] });
  assert.deepEqual([...vazio.values()], [false, false, false]);
});

test('só verifica os arquivos pedidos e lê cada peça uma vez', async () => {
  const lidos = [];
  const r = await verifyFilesByPieces({ meta, storeDir: disco(), fileIdxs: [0, 1], onRead: (info) => lidos.push(info.piece) });
  assert.deepEqual([...r.keys()], [0, 1]);
  assert.equal(new Set(lidos).size, lidos.length, 'a peça compartilhada não é lida duas vezes');
});

test('recusa symlink no lugar do arquivo (não segue link para fora do armazenamento)', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink exige privilégio no Windows');
  const dir = disco([DADOS[0], DADOS[1], null]);
  const fora = path.join(tmpdir('piece-fora-'), 'x.mkv');
  fs.writeFileSync(fora, DADOS[2]);
  fs.symlinkSync(fora, path.join(dir, arquivos[2].path));
  const r = await verifyFilesByPieces({ meta, storeDir: dir, fileIdxs: [2] });
  assert.equal(r.get(2), false);
});

test('arquivo de tamanho zero e índice fora do torrent', async () => {
  const m = { ...meta, files: [...arquivos, { path: 'P/vazio.txt', length: 0 }] };
  const dir = disco(); fs.writeFileSync(path.join(dir, 'P/vazio.txt'), '');
  const r = await verifyFilesByPieces({ meta: m, storeDir: dir, fileIdxs: [3, 9] });
  assert.equal(r.get(3), true);
  assert.equal(r.get(9), false);
});

test('metadados incoerentes (peças a menos) não verificam nada', async () => {
  const r = await verifyFilesByPieces({ meta: { ...meta, pieces: pieces.slice(1) }, storeDir: disco(), fileIdxs: [0, 2] });
  assert.deepEqual([...r.values()], [false, false]);
});

test('nunca mantém abertos mais descritores que o limite, mesmo com muitos arquivos (EMFILE)', async () => {
  const N = 60;
  const dados = Array.from({ length: N }, (_, i) => Buffer.alloc(PL * 2, (i % 250) + 1));
  const todos = Buffer.concat(dados);
  const pecas = [];
  for (let o = 0; o < todos.length; o += PL) pecas.push(createHash('sha1').update(todos.subarray(o, o + PL)).digest('hex'));
  const dir = tmpdir('piece-emfile-');
  const fm = dados.map((d, i) => ({ path: `e${i}.mkv`, length: d.length }));
  fm.forEach((f, i) => fs.writeFileSync(path.join(dir, f.path), dados[i]));
  let abertos = 0; let pico = 0;
  const openFn = async (...args) => {
    const h = await fs.promises.open(...args);
    abertos += 1; pico = Math.max(pico, abertos);
    const close = h.close.bind(h);
    h.close = async () => { abertos -= 1; return close(); };
    return h;
  };
  const r = await verifyFilesByPieces({ meta: { pieceLength: PL, pieces: pecas, files: fm, length: todos.length }, storeDir: dir, fileIdxs: fm.map((_, i) => i), maxOpen: 4, openFn });
  assert.ok([...r.values()].every(Boolean), 'todos íntegros continuam provados');
  assert.ok(pico <= 4, `pico de descritores abertos: ${pico}`);
  assert.equal(abertos, 0, 'tudo fechado no fim');
});

test('falha de abertura por falta de descritores não vira "sem prova" calada: a verificação para com erro', async () => {
  const dir = disco();
  const emfile = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
  await assert.rejects(verifyFilesByPieces({ meta, storeDir: dir, fileIdxs: [0], openFn: async () => { throw emfile; } }), (e) => e.code === 'EMFILE');
});
