const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/ui/episodes-model');

// Item do snapshot da ponte, com o que a regra de exclusão olha.
const titulo = (over = {}) => ({
  infoHash: 'a'.repeat(40), completedAt: '2026-11-15T05:38:00.000Z',
  tracker: { satisfied: true, hitAndRun: false, checkedAt: '2026-11-15T06:00:00.000Z' },
  episodes: [{ index: 0, season: 1, episode: 1, state: 'completo' }], ...over,
});

test('exclusão liberada com o seed confirmado pelo tracker', () => {
  assert.deepEqual(M.acaoExcluir(titulo()), { permitida: true, motivo: '' });
});

test('pack que nunca concluiu não tem obrigação de seed: exclusão liberada', () => {
  assert.equal(M.acaoExcluir(titulo({ completedAt: null, tracker: null })).permitida, true);
});

test('obrigação aberta no tracker: botão desabilitado, com o motivo', () => {
  const r = M.acaoExcluir(titulo({ tracker: { satisfied: false, hitAndRun: false } }));
  assert.equal(r.permitida, false);
  assert.match(r.motivo, /tracker/i);
  assert.match(r.motivo, /confirm/i);
});

test('concluído mas o tracker ainda não foi lido: fail-closed, nunca "liberado"', () => {
  for (const tracker of [null, undefined, {}]) {
    const r = M.acaoExcluir(titulo({ tracker }));
    assert.equal(r.permitida, false, JSON.stringify(tracker));
    assert.ok(r.motivo.length > 0);
  }
});

test('hit-and-run registrado bloqueia mesmo com o tracker dizendo cumprido', () => {
  const r = M.acaoExcluir(titulo({ tracker: { satisfied: true, hitAndRun: true } }));
  assert.equal(r.permitida, false);
  assert.match(r.motivo, /hit-and-run/i);
});

test('sem título ou sem episódios não há o que excluir', () => {
  assert.equal(M.acaoExcluir(undefined).permitida, false);
  assert.equal(M.acaoExcluir(null).permitida, false);
  assert.equal(M.acaoExcluir(titulo({ episodes: [] })).permitida, false);
  assert.equal(M.acaoExcluir(titulo({ episodes: undefined })).permitida, false);
});

test('rótulo SxxExx com zero à esquerda e episódio duplo', () => {
  assert.equal(M.tag({ season: 1, episode: 3 }), 'S01E03');
  assert.equal(M.tag({ season: 12, episode: 104 }), 'S12E104');
  assert.equal(M.tag({ season: 1, episode: 1, episodeEnd: 2 }), 'S01E01-E02');
  assert.equal(M.tag({ season: 0, episode: 5 }), 'S00E05');
});

test('a interface carrega o módulo antes de views.js e o painel o usa', () => {
  const ui = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8');
  const html = ui('index.html');
  assert.match(html, /<script src="\/episodes-model\.js" defer><\/script>/);
  assert.ok(html.indexOf('episodes-model.js') < html.indexOf('views.js'), 'o módulo vem antes das telas');
  assert.match(ui('views.js'), /EpisodesModel\.acaoExcluir/, 'o card usa a mesma regra testada aqui');
});

test('o card redesenha quando o que decide o botão muda (conclusão e confirmação do tracker)', () => {
  const views = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'views.js'), 'utf8');
  const sig = /const sig = JSON\.stringify\(\[([^\]]*)\]\)/.exec(views.slice(views.indexOf('function renderEps')));
  assert.ok(sig, 'assinatura do card');
  for (const campo of ['t.completedAt', 't.tracker?.satisfied', 't.tracker?.hitAndRun']) {
    assert.ok(sig[1].includes(campo), `a assinatura precisa incluir ${campo}, senão o botão fica desatualizado`);
  }
});
