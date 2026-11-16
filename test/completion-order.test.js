const test = require('node:test');
const assert = require('node:assert/strict');
const { completionPlan, selectCompletion } = require('../src/completion-order');

function pack() {
  // Ordem física embaralhada, com peça compartilhada: E03, E01, E02, auxiliar.
  const files = [
    { index: 0, path: 'P/S02E03.mkv', length: 15, isVideo: true },
    { index: 1, path: 'P/S02E01.mkv', length: 15, isVideo: true },
    { index: 2, path: 'P/S02E02.mkv', length: 15, isVideo: true },
    { index: 3, path: 'P/capa.jpg', length: 5, isVideo: false },
  ];
  return { entry: { files }, torrent: { files, pieceLength: 10, pieces: new Array(5) } };
}

test('começar no meio: trecho à frente, episódio seguinte, trecho atrás e episódio anterior', () => {
  const { entry, torrent } = pack();
  const plan = completionPlan(torrent, entry, { fileIdx: 2, start: 10 });
  assert.deepEqual(plan, [[4, 4], [0, 1], [3, 3], [2, 2]]);
  assert.deepEqual(plan.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)).sort(), [0, 1, 2, 3, 4], 'todas as peças exatamente uma vez, inclusive auxiliares e bordas');
});

test('filme iniciado no meio termina à frente e depois busca o início', () => {
  const torrent = { files: [{ length: 100 }], pieces: new Array(10), pieceLength: 10 };
  assert.deepEqual(completionPlan(torrent, {}, { fileIdx: 0, start: 60 }), [[6, 9], [0, 5]]);
});

test('arquivo atual vazio ou posição inválida cai na fila do torrent inteiro, sem intervalo negativo', () => {
  const torrent = { files: [{ length: 0 }, { length: 100 }], pieces: new Array(10), pieceLength: 10 };
  assert.deepEqual(completionPlan(torrent, {}, { fileIdx: 0, start: 0 }), [[0, 9]]);
  assert.deepEqual(completionPlan(torrent, {}, { fileIdx: 7, start: 0 }), [[0, 9]]);
});

test('posição além do fim do arquivo é limitada e arquivos auxiliares com peças próprias vêm por último', () => {
  const files = [
    { index: 0, path: 'S01E01.mkv', length: 20, isVideo: true },
    { index: 1, path: 'S01E02.mkv', length: 20, isVideo: true },
    { index: 2, path: 'extra.nfo', length: 20, isVideo: false },
  ];
  const torrent = { files, pieces: new Array(6), pieceLength: 10 };
  // `start` vem do Range do cliente: um valor absurdo não pode gerar peça fora do torrent.
  assert.deepEqual(completionPlan(torrent, { files }, { fileIdx: 0, start: 1e9 }), [[1, 1], [2, 3], [0, 0], [4, 5]]);
});

test('ordena temporadas e episódios numericamente, preservando índices físicos', () => {
  const files = ['S02E01', 'S01E10', 'S01E02', 'S01E01'].map((id, index) => ({ index, path: `${id}.mkv`, length: 10, isVideo: true }));
  const torrent = { files, pieces: new Array(4), pieceLength: 10 };
  assert.deepEqual(completionPlan(torrent, { files }, { fileIdx: 2, start: 0 }), [[2, 2], [1, 1], [0, 0], [3, 3]]);
});

test('motor real: reordenar após seek preserva a seleção de streaming e a ordem de fundo', async () => {
  // Exercita a mesma coleção usada pelo WebTorrent, sem cliente, peers, rede ou dados reais.
  const { Selections } = await import('../node_modules/webtorrent/lib/selections.js');
  const selections = new Selections();
  const { entry, torrent } = pack();
  torrent.deselect = (from, to) => selections.remove({ from, to });
  torrent.select = (from, to, priority, notify) => {
    selections.insert({ from, to, priority, notify, offset: 0 });
    selections.sort((a, b) => b.priority - a.priority);
  };
  const stream = { from: 4, to: 4, priority: 1, isStreamSelection: true, offset: 0 };
  selections.insert(stream);
  selectCompletion(torrent, completionPlan(torrent, entry, { fileIdx: 2, start: 10 }));
  assert.equal(selections.get(0), stream);
  assert.deepEqual([...selections].slice(1).map(({ from, to }) => [from, to]), [[4, 4]]);
  selectCompletion(torrent, completionPlan(torrent, entry, { fileIdx: 1, start: 0 }));
  assert.equal(selections.get(0), stream, 'seek não cancela o iterador de reprodução');
  assert.deepEqual([...selections].slice(1).map(({ from, to }) => [from, to]), [[1, 2]]);
});

test('libera etapas só após verificação e ignora notificação antiga depois de seek', async () => {
  const { entry, torrent } = pack();
  const verified = new Set();
  const selected = [];
  torrent.bitfield = { get: (piece) => verified.has(piece) };
  torrent.deselect = () => {};
  torrent.select = (from, to, priority, notify) => selected.push({ from, to, priority, notify });
  const flush = async () => { await Promise.resolve(); };
  selectCompletion(torrent, completionPlan(torrent, entry, { fileIdx: 2, start: 10 }));
  assert.deepEqual(selected.map(({ from, to }) => [from, to]), [[4, 4]]);
  selected.at(-1).notify();
  await flush();
  assert.equal(selected.length, 1, 'nenhuma peça verificada: não passa à próxima etapa');
  verified.add(4);
  selected.at(-1).notify();
  await flush();
  assert.deepEqual(selected.map(({ from, to }) => [from, to]), [[4, 4], [0, 1]]);
  const stale = selected.at(-1).notify;
  selectCompletion(torrent, completionPlan(torrent, entry, { fileIdx: 1, start: 0 }));
  const count = selected.length;
  verified.add(0); verified.add(1);
  stale();
  await flush();
  assert.equal(selected.length, count, 'seek invalida o plano anterior');
  verified.add(2);
  selected.at(-1).notify();
  await flush();
  assert.deepEqual([selected.at(-1).from, selected.at(-1).to], [3, 4]);
  verified.add(3);
  selected.at(-1).notify();
  await flush();
  assert.equal(selected.length, count + 1, 'todas as peças verificadas: nenhuma nova seleção');
});
