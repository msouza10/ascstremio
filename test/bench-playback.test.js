// O benchmark em si (scripts/bench-playback.js) sobe dois clientes WebTorrent e depende de tempo real:
// roda sob demanda, não aqui. Testa só as partes puras, para o script não quebrar sem ninguém ver.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, prng, pct } = require('../scripts/bench-playback');

test('parseArgs aceita --opção valor e --opção=valor e recusa o desconhecido', () => {
  const o = parseArgs(['--size-mib', '16', '--pattern=sequential', '--seed-rate-kib', '512,2048']);
  assert.equal(o['size-mib'], 16);
  assert.equal(o.pattern, 'sequential');
  assert.equal(o['seed-rate-kib'], '512,2048');
  assert.throws(() => parseArgs(['--nao-existe', '1']), /desconhecida/);
  assert.throws(() => parseArgs(['--size-mib', 'abc']), /inválido/);
  assert.throws(() => parseArgs(['--pattern', 'x']), /--pattern/);
  assert.throws(() => parseArgs(['--format']), /falta o valor/);
});

test('o gerador pseudoaleatório é determinístico por semente', () => {
  const a = prng(1); const b = prng(1); const c = prng(2);
  const sa = [a(), a(), a()]; const sb = [b(), b(), b()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, [c(), c(), c()]);
});

test('percentil por posto', () => {
  assert.equal(pct([], 0.5), null);
  assert.equal(pct([1, 2, 3, 4], 0.5), 2);
  assert.equal(pct([1, 2, 3, 4], 0.95), 4);
});
