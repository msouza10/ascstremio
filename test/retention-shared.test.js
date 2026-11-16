// `sharedWith` é a única definição de "arquivo compartilhado entre títulos" (issue #134): exclusão
// individual, retenção, verificação de seed e liberação automática dependem dela.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sharedWith, pathKey } = require('../src/retention');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const biblioteca = (obj) => new Map(Object.entries(obj).map(([h, paths]) => [h, { files: paths.map((p) => ({ path: p })) }]));

test('devolve o outro título que usa o mesmo caminho e ignora o próprio', () => {
  const e = biblioteca({ [A]: ['pack/a.mkv'], [B]: ['pack/a.mkv'], [C]: ['outro/c.mkv'] });
  assert.equal(sharedWith(e, A, ['pack/a.mkv']), B);
  assert.equal(sharedWith(e, C, ['outro/c.mkv']), null);
});

test('um único arquivo em comum já basta (episódio dentro de outro pack)', () => {
  const e = biblioteca({ [A]: ['S1/e1.mkv', 'S1/e2.mkv'], [B]: ['S1/e2.mkv'] });
  assert.equal(sharedWith(e, A, ['S1/e1.mkv', 'S1/e2.mkv']), B);
});

test('"./" na frente não esconde o compartilhamento', () => {
  const e = biblioteca({ [A]: ['x.mkv'], [B]: ['./x.mkv'] });
  assert.equal(sharedWith(e, A, ['x.mkv']), B);
});

test('maiúsculas só contam como o mesmo arquivo onde o disco as ignora (mesma regra do pathKey)', () => {
  const e = biblioteca({ [A]: ['Filme/A.mkv'], [B]: ['filme/a.mkv'] });
  const mesmo = pathKey('Filme/A.mkv') === pathKey('filme/a.mkv');
  assert.equal(sharedWith(e, A, ['Filme/A.mkv']), mesmo ? B : null);
});

test('lista vazia ou ausente não aponta ninguém; entradas sem files são toleradas', () => {
  const e = new Map([[A, { files: [{ path: 'x.mkv' }] }], [B, {}], [C, null]]);
  assert.equal(sharedWith(e, A, []), null);
  assert.equal(sharedWith(e, A, undefined), null);
  assert.equal(sharedWith(e, A, ['x.mkv']), null);
});

test('caminho que não normaliza (chave nula) casa com outro igual: na dúvida, é compartilhado', () => {
  const e = biblioteca({ [A]: ['../fora.mkv'], [B]: ['../fora.mkv'] });
  assert.equal(sharedWith(e, A, ['../fora.mkv']), B);
});
