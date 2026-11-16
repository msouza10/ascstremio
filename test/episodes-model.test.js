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
  assert.match(ui('views.js'), /const EM = window\.EpisodesModel;/);
  assert.match(ui('views.js'), /EM\.acaoExcluir/, 'o card usa a mesma regra testada aqui');
});

test('o card redesenha quando o que decide o botão muda (conclusão e confirmação do tracker)', () => {
  const views = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'views.js'), 'utf8');
  const sig = /const sig = JSON\.stringify\(\[([^\]]*)\]\)/.exec(views.slice(views.indexOf('function renderEps')));
  assert.ok(sig, 'assinatura do card');
  for (const campo of ['t.completedAt', 't.tracker?.satisfied', 't.tracker?.hitAndRun']) {
    assert.ok(sig[1].includes(campo), `a assinatura precisa incluir ${campo}, senão o botão fica desatualizado`);
  }
});

// ---- Máquina de estados do card (confirmar, cancelar, ocupado) e pedidos -----------------------------
const HASH = 'a'.repeat(40);

test('escolher uma ação abre a confirmação e limpa o resultado anterior', () => {
  const s0 = { ...M.estadoInicial(), result: 'antigo' };
  const s1 = M.escolher(s0, { kind: 'exclude', file: 2, tag: 'S01E03' });
  assert.deepEqual(s1.action, { kind: 'exclude', file: 2, tag: 'S01E03' });
  assert.equal(s1.result, '');
  assert.equal(s1.busy, false);
});

test('cancelar fecha a confirmação, mas não enquanto há pedido em andamento', () => {
  const aberta = M.escolher(M.estadoInicial(), { kind: 'restore' });
  assert.equal(M.cancelar(aberta).action, null);
  const ocupada = { ...aberta, busy: true };
  assert.equal(M.cancelar(ocupada), ocupada, 'ocupado: nada muda');
});

test('com pedido em andamento não se escolhe outra ação nem se confirma de novo (sem clique duplo)', () => {
  const ocupada = { ...M.escolher(M.estadoInicial(), { kind: 'restore' }), busy: true };
  assert.equal(M.escolher(ocupada, { kind: 'exclude', file: 0, tag: 'S01E01' }), ocupada);
  assert.equal(M.confirmar(ocupada), null);
  assert.equal(M.confirmar(M.estadoInicial()), null, 'sem ação escolhida não há o que confirmar');
});

test('confirmar marca ocupado, e o fim (sucesso ou erro) sempre libera e fecha a ação', () => {
  const aberta = M.escolher(M.estadoInicial(), { kind: 'exclude', file: 1, tag: 'S01E02' });
  const indo = M.confirmar(aberta);
  assert.equal(indo.busy, true);
  assert.deepEqual(indo.action, aberta.action, 'a ação continua visível enquanto aguarda');
  const ok = M.concluido(indo, { message: 'Episódio excluído.' });
  assert.deepEqual(ok, { action: null, busy: false, result: 'Episódio excluído.' });
  const erro = M.falhou(indo, new Error('O tracker ainda não confirmou.'));
  assert.deepEqual(erro, { action: null, busy: false, result: 'O tracker ainda não confirmou.' });
  assert.match(M.falhou(indo, {}).result, /Não foi possível/);
});

test('mensagem de sucesso: usa a do servidor; senão o aviso de custo; senão a padrão', () => {
  assert.equal(M.mensagem({ message: 'feito' }), 'feito');
  assert.equal(M.mensagem({ aviso: 'conta no ratio' }), 'Iniciado. conta no ratio');
  assert.equal(M.mensagem({}), 'Iniciado. O restante baixa em segundo plano.');
});

test('cada ação vira o pedido certo, só com números e o infoHash', () => {
  const p = (action) => M.pedido(action, HASH);
  assert.deepEqual(p({ kind: 'exclude', file: 3 }), { route: 'exclude', body: { infoHash: HASH, file: 3 } });
  assert.deepEqual(p({ kind: 'excludeSeason', season: 2 }), { route: 'exclude', body: { infoHash: HASH, season: 2 } });
  assert.deepEqual(p({ kind: 'completeFile', file: 4 }), { route: 'complete', body: { infoHash: HASH, file: 4 } });
  assert.deepEqual(p({ kind: 'completeSeason', season: 1 }), { route: 'complete', body: { infoHash: HASH, season: 1 } });
  assert.deepEqual(p({ kind: 'verify' }), { route: 'verify-pieces', body: { infoHash: HASH } });
  assert.deepEqual(p({ kind: 'restore' }), { route: 'complete', body: { infoHash: HASH } });
  assert.throws(() => p({ kind: 'qualquer' }));
});

test('temporadas: agrupa por temporada e diz o que dá para excluir e o que falta baixar', () => {
  const eps = [
    { index: 0, season: 1, episode: 1, state: 'completo', excluded: false },
    { index: 1, season: 1, episode: 2, state: 'ausente', excluded: false },
    { index: 2, season: 2, episode: 1, state: 'parcial', excluded: false },
    { index: 3, season: 2, episode: 2, state: 'ausente', excluded: true },
    { index: 4, season: 3, episode: 1, state: 'completo', excluded: false },
  ];
  const t = M.temporadas(eps);
  assert.deepEqual(t.map((x) => x.season), [1, 2, 3], 'em ordem');
  const por = Object.fromEntries(t.map((x) => [x.season, x]));
  assert.equal(por[1].podeExcluir, true, 'tem episódio em disco');
  assert.equal(por[1].falta, true);
  assert.equal(por[2].podeExcluir, true, 'o parcial também ocupa disco');
  assert.equal(por[2].falta, true, 'parcial e excluído faltam');
  assert.equal(por[3].falta, false);
  assert.equal(por[3].podeExcluir, true);
  const vazia = M.temporadas([{ index: 0, season: 4, episode: 1, state: 'ausente', excluded: true }])[0];
  assert.equal(vazia.podeExcluir, false, 'nada em disco, nada a excluir');
  assert.deepEqual(M.temporadas(undefined), []);
});

test('texto da confirmação: alcance visível e aviso de ratio quando o release não é freeleech', () => {
  const t = (freeleech) => ({ freeleech });
  assert.match(M.descricao({ kind: 'excludeSeason', season: 2 }, t(true)).texto, /temporada 2/i);
  assert.equal(M.descricao({ kind: 'excludeSeason', season: 2 }, t(true)).perigo, true);
  assert.match(M.descricao({ kind: 'exclude', tag: 'S01E03' }, t(true)).titulo, /S01E03/);
  const completar = M.descricao({ kind: 'completeSeason', season: 1 }, t(false));
  assert.match(completar.texto, /ratio/i, 'não freeleech conta no ratio');
  assert.match(completar.texto, /72 h/, 'deixa claro que não abre a obrigação do pack');
  assert.doesNotMatch(M.descricao({ kind: 'completeFile', tag: 'S01E01' }, t(true)).texto, /ratio/i);
  assert.match(M.descricao({ kind: 'restore' }, t(false)).texto, /ratio/i);
});

test('views.js usa o modelo do card em vez de repetir a lógica', () => {
  const views = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'views.js'), 'utf8');
  assert.match(views, /const EM = window\.EpisodesModel;/);
  for (const fn of ['escolher', 'cancelar', 'confirmar', 'concluido', 'falhou', 'pedido', 'temporadas', 'descricao']) {
    assert.match(views, new RegExp(`EM\\.${fn}\\b`), fn);
  }
  assert.doesNotMatch(views, /app\(\)\.call\('POST', 'exclude'/, 'o pedido sai do modelo');
});

test('"Verificar peças" só se oferece quando há episódio apenas provável e nenhum pedido em voo', () => {
  const eps = (...states) => states.map((state, index) => ({ index, state }));
  assert.equal(M.podeVerificar(eps('completo', 'provavel')), true);
  assert.equal(M.podeVerificar(eps('completo', 'parcial', 'ausente')), false, 'nada a provar');
  assert.equal(M.podeVerificar(eps('provavel'), { verified: true }), false, 'motor aberto já é exato');
  assert.equal(M.podeVerificar(undefined), false);
  assert.match(M.descricao({ kind: 'verify' }, {}).texto, /não baixa/i);
  assert.equal(M.descricao({ kind: 'verify' }, {}).perigo, false);
});
