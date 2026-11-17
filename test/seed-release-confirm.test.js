// Issue #100: a liberação automática (releaseSatisfied) só para o seed ou apaga arquivos com uma
// confirmação RECENTE do tracker (13.1). O tracker é lido pelo mesmo `hnr.reconcile` do index.js,
// com um ASC simulado: nada de rede, de private/ nem de caminhos absolutos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const hnr = require('../src/hnr-guard');
const settings = require('../src/settings');
const { tmpdir } = require('./tmp-helper');

const HASH = 'c'.repeat(40);
const HASH2 = 'd'.repeat(40);
const HORA = 3_600_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

const cumprido = { completedAt: '2026-10-01 00:00:00', remainingSeedTime: 0 };

function setup({ afterSeed = 'delete', history = cumprido, checkedAgoMs = 30 * 24 * HORA, hashes = [HASH], extra = {} } = {}) {
  const dir = tmpdir('liberar-');
  const clock = { t: T0 };
  const vault = new SeedVault({ file: path.join(dir, 'vault.json'), now: () => clock.t });
  const arquivos = {};
  const chamadas = [];
  const torrents = [];
  const biblioteca = new Map();
  hashes.forEach((h, i) => {
    vault.markSeen(h, { name: `Filme ${i}`, torrentPath: path.join(dir, `asc-${100 + i}.torrent`) });
    vault.markCompleted(h);
    vault.addSeedingTime(h, 72 * HORA);
    // Confirmação antiga, gravada quando o relógio estava `checkedAgoMs` atrás.
    const agora = clock.t;
    clock.t = T0 - checkedAgoMs;
    vault.setTracker(h, hnr.normalizeHistory(cumprido));
    clock.t = agora;
    arquivos[h] = path.join(dir, `video${i}.mkv`);
    fs.writeFileSync(arquivos[h], 'vídeo sintético');
    // Biblioteca: o título conhece os arquivos que o .torrent traz (é daí que vem a checagem de compartilhamento).
    biblioteca.set(h, { infoHash: h, files: [{ path: `video${i}.mkv`, length: 1 }] });
    // O motor de verdade apaga o armazenamento com destroyStore: o dublê também, para provar o efeito no disco.
    torrents.push({ infoHash: h, destroy(opts, cb) {
      chamadas.push({ h, ...opts });
      if (opts?.destroyStore) fs.rmSync(arquivos[h], { force: true });
      cb();
    } });
  });
  const asc = { consultas: [], history: async (id) => {
    asc.consultas.push(id);
    if (asc.falha) throw asc.falha;
    return { history: asc.resposta === undefined ? history : asc.resposta };
  } };
  const b = new Bridge({
    torrentDir: dir, storeDir: dir, vault, afterSeed,
    trackerCheck: (hs, opts = {}) => hnr.reconcile({ asc, vault, only: hs, ...opts }),
    ...extra,
  });
  for (const [h, lib] of biblioteca) b.entries.set(h, lib);
  b.client = { torrents };
  const mudo = async () => { const log = console.log; console.log = () => {}; try { return await b.releaseSatisfied(); } finally { console.log = log; } };
  return { b, vault, asc, chamadas, clock, dir, arquivos, liberar: mudo };
}

test('confirmação antiga no cofre: relê o tracker antes de liberar e libera quando ele ainda confirma', async () => {
  const s = setup();
  const r = await s.liberar();
  assert.equal(s.asc.consultas.length, 1, 'tem de reler o tracker, não confiar no cofre antigo');
  assert.equal(r.length, 1);
  assert.deepEqual(s.chamadas.map((c) => c.destroyStore), [true]);
  assert.equal(s.vault.get(HASH).releasedAs, 'delete');
});

test('confirmação antiga e o tracker reabriu a obrigação: conserva seed e arquivos', async () => {
  const s = setup();
  s.asc.resposta = { completedAt: '2026-10-01 00:00:00', remainingSeedTime: 3600 };
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.chamadas.length, 0);
  assert.equal(s.vault.get(HASH).releasedAs, undefined);
  assert.ok(fs.existsSync(s.arquivos[HASH]));
});

test('tracker indisponível ou sessão expirada: não libera nem registra liberação no cofre', async () => {
  const s = setup();
  s.asc.falha = new Error('sessão expirada');
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.chamadas.length, 0);
  assert.equal(s.vault.get(HASH).releasedAs, undefined);
});

test('sem registro no tracker (resposta vazia ou incompleta): não libera', async () => {
  for (const resposta of [null, {}, { completedAt: null }]) {
    const s = setup();
    s.asc.resposta = resposta;
    assert.deepEqual(await s.liberar(), [], JSON.stringify(resposta));
    assert.equal(s.chamadas.length, 0);
  }
});

test('hit-and-run conservado no tracker: não libera, mesmo com o cumprimento marcado', async () => {
  const s = setup();
  s.asc.resposta = { ...cumprido, hitAndRunAt: '2026-10-20 00:00:00' };
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.chamadas.length, 0);
});

test('hit-and-run já no cofre: não libera nem consulta o tracker à toa', async () => {
  const s = setup({ checkedAgoMs: 60_000 });
  s.vault.get(HASH).tracker.hitAndRun = true;
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.chamadas.length, 0);
});

test('confirmação recente (dentro do limite) dispensa nova consulta', async () => {
  const s = setup({ checkedAgoMs: 60_000 });
  s.asc.falha = new Error('não deveria consultar');
  const r = await s.liberar();
  assert.equal(r.length, 1);
  assert.equal(s.asc.consultas.length, 0);
});

test('confirmação logo além do limite volta a exigir a consulta', async () => {
  const s = setup({ checkedAgoMs: 6 * 60_000 }); // padrão: 5 min
  s.asc.falha = new Error('fora do ar');
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.asc.consultas.length, 1);
});

test('relógio que voltou (confirmação "do futuro") não vale como recente', async () => {
  const s = setup({ checkedAgoMs: -2 * HORA });
  s.asc.falha = new Error('fora do ar');
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.chamadas.length, 0);
  assert.equal(s.asc.consultas.length, 1);
});

test('relógio que saltou para a frente: a confirmação passa a ser antiga e é relida', async () => {
  const s = setup({ checkedAgoMs: 60_000 });
  s.clock.t += 3 * 24 * HORA;
  s.asc.falha = new Error('fora do ar');
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.asc.consultas.length, 1);
});

test('estado legado sem checkedAt é tratado como não confirmado agora', async () => {
  const s = setup({ checkedAgoMs: 60_000 });
  delete s.vault.get(HASH).tracker.checkedAt;
  s.asc.falha = new Error('fora do ar');
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.asc.consultas.length, 1);
  assert.equal(s.chamadas.length, 0);
  assert.equal(s.vault.get(HASH).satisfiedAt !== null, true, 'a migração não zera o que o cofre já sabia');
});

test('nunca confirmado pelo tracker: não libera e não consulta', async () => {
  const s = setup();
  s.vault.get(HASH).satisfiedAt = null;
  s.vault.get(HASH).tracker = undefined;
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.chamadas.length, 0);
});

test('reprodução que começa durante a consulta ao tracker impede o descarte', async () => {
  const s = setup();
  const original = s.asc.history;
  s.asc.history = async (id) => { const r = await original(id); s.b.streams.set(HASH, 1); return r; };
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.chamadas.length, 0);
  assert.ok(fs.existsSync(s.arquivos[HASH]));
});

test('torrent em abertura não é consultado nem liberado', async () => {
  const s = setup();
  s.b.loading.set(HASH, Promise.resolve());
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.asc.consultas.length, 0);
  assert.equal(s.chamadas.length, 0);
});

test('sessão de reprodução recente (do vídeo ou da fonte /a/) adia a liberação', async () => {
  for (const chave of [`s:${HASH}:0`, 'a:100']) {
    const s = setup();
    s.b.limiter.acquire('cred', chave);
    assert.deepEqual(await s.liberar(), [], chave);
    assert.equal(s.asc.consultas.length, 0);
    assert.equal(s.chamadas.length, 0);
  }
});

test('sessão de OUTRO título cujo id só começa igual (a:1000 vs a:100) não adia a liberação', async () => {
  const s = setup();
  s.b.limiter.acquire('cred', 'a:1000');
  const r = await s.liberar();
  assert.equal(r.length, 1, 'o id 1000 não é o id 100');
  assert.deepEqual(s.chamadas.map((c) => c.destroyStore), [true]);
});

test('sessão de um episódio do mesmo pack (e:<id>:T:E) adia a liberação', async () => {
  const s = setup();
  s.b.limiter.acquire('cred', 'e:100:1:2');
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.asc.consultas.length, 0);
  assert.equal(s.chamadas.length, 0);
});

test('escolha individual keep/stop feita durante a consulta ao tracker vence a liberação automática', async () => {
  for (const escolha of ['keep', 'stop']) {
    const s = setup();
    const original = s.asc.history;
    s.asc.history = async (id) => { const r = await original(id); s.vault.setSeedChoice(HASH, escolha); return r; };
    assert.deepEqual(await s.liberar(), [], escolha);
    assert.equal(s.chamadas.length, 0);
    assert.ok(fs.existsSync(s.arquivos[HASH]));
  }
});

test('bloqueio sem falha de acesso (sem registro) não impede liberar o próximo título', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  const original = s.asc.history;
  s.asc.history = async (id) => (id === '100' ? { history: null } : original(id));
  const r = await s.liberar();
  assert.deepEqual(r.map((x) => x.infoHash), [HASH2]);
});

test('o motivo mostrado no painel não carrega o texto cru do erro de rede', async () => {
  const s = setup();
  s.asc.falha = new Error('GET https://exemplo.invalido/?k=segredo falhou');
  await s.liberar();
  assert.doesNotMatch(JSON.stringify(s.b.snapshot(s.clock.t).titles.find((t) => t.infoHash === HASH)), /segredo|exemplo/);
});

test('a primeira falha do tracker interrompe o ciclo: sem martelar o site', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  s.asc.falha = new Error('desafio do site');
  assert.deepEqual(await s.liberar(), []);
  assert.equal(s.asc.consultas.length, 1);
});

test('stop libera só a rede e respeita a mesma exigência', async () => {
  const s = setup({ afterSeed: 'stop' });
  s.asc.falha = new Error('fora do ar');
  assert.deepEqual(await s.liberar(), []);
  s.asc.falha = null;
  const r = await s.liberar();
  assert.equal(r.length, 1);
  assert.deepEqual(s.chamadas.map((c) => c.destroyStore), [false]);
});

test('keep e manual nunca consultam nem liberam; escolha individual keep/stop é respeitada', async () => {
  for (const afterSeed of ['keep', 'manual']) {
    const s = setup({ afterSeed });
    assert.deepEqual(await s.liberar(), []);
    assert.equal(s.asc.consultas.length, 0);
  }
  for (const escolha of ['keep', 'stop']) {
    const s = setup();
    s.vault.setSeedChoice(HASH, escolha);
    assert.deepEqual(await s.liberar(), []);
    assert.equal(s.asc.consultas.length, 0);
  }
});

test('o painel mostra que a liberação aguarda confirmação do tracker, sem dizer que está em dia', async () => {
  const s = setup();
  s.asc.falha = new Error('fora do ar');
  await s.liberar();
  const titulo = s.b.snapshot(s.clock.t).titles.find((t) => t.infoHash === HASH);
  assert.ok(titulo, 'título presente no estado do painel');
  assert.match(titulo.releaseBlocked.reason, /tracker/i);
  assert.ok(titulo.warnings.some((w) => /aguardando.*tracker/i.test(w)), 'o painel lê title.warnings');
  assert.ok(s.b.hnrWarnings(s.clock.t).some((w) => /aguardando.*tracker|tracker.*confirma/i.test(w)));
  // Quando o tracker volta a confirmar e a liberação ocorre, o aviso some.
  s.asc.falha = null;
  await s.liberar();
  assert.equal(s.b.hnrWarnings(s.clock.t).some((w) => /aguardando.*tracker/i.test(w)), false);
});

test('limite configurável: SEED_RELEASE_CONFIRM_MAX_AGE_MINUTES (padrão 5, 0 = sempre reler)', () => {
  const dir = tmpdir('cfg-');
  assert.equal(settings.load({ dataDir: dir, env: {} }).values.SEED_RELEASE_CONFIRM_MAX_AGE_MINUTES, 5);
  assert.equal(settings.load({ dataDir: dir, env: { SEED_RELEASE_CONFIRM_MAX_AGE_MINUTES: '0' } }).values.SEED_RELEASE_CONFIRM_MAX_AGE_MINUTES, 0);
});

test('com limite 0 até a confirmação de agora é relida', async () => {
  const s = setup({ checkedAgoMs: 1000, extra: { releaseConfirmMaxAgeMs: 0 } });
  const r = await s.liberar();
  assert.equal(s.asc.consultas.length, 1);
  assert.equal(r.length, 1);
});

test('o aviso de "aguardando confirmação" some assim que o usuário resolve o caso, sem esperar a próxima passada', async () => {
  const aviso = /aguardando.*tracker/i;
  const mostra = (s) => s.b.snapshot(s.clock.t).titles.find((t) => t.infoHash === HASH);
  const s = setup();
  s.asc.falha = new Error('fora do ar');
  await s.liberar();
  assert.ok(mostra(s).warnings.some((w) => aviso.test(w)), 'pré-condição: há aviso');
  s.vault.setSeedChoice(HASH, 'keep'); // o usuário decidiu manter
  assert.equal(mostra(s).releaseBlocked, null);
  assert.equal(mostra(s).warnings.some((w) => aviso.test(w)), false);
  assert.equal(s.b.hnrWarnings(s.clock.t).some((w) => aviso.test(w)), false);
  // Ao voltar atrás, o motivo volta a valer: a próxima passada decide de novo.
  s.vault.setSeedChoice(HASH, null);
  assert.ok(mostra(s).warnings.some((w) => aviso.test(w)));
});

// Issue #134: dois títulos apontando para o MESMO arquivo em disco. O outro título pode ter
// obrigação de seed aberta (13.1) ou ser assistido: a liberação automática só solta a rede.
function compartilhar(s, a = HASH, b = HASH2) {
  s.b.entries.get(b).files = [{ path: s.b.entries.get(a).files[0].path, length: 1 }];
  s.arquivos[b] = s.arquivos[a];
}

test('delete: arquivo usado também por outro título (ainda sem cumprir) NÃO é apagado; só a rede é liberada', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  compartilhar(s);
  s.vault.get(HASH2).satisfiedAt = null; // o outro título não cumpriu: o tracker não confirma
  s.vault.get(HASH2).tracker = undefined;
  const r = await s.liberar();
  assert.deepEqual(r.map((x) => x.infoHash), [HASH]);
  assert.deepEqual(s.chamadas.map((c) => [c.h, c.destroyStore]), [[HASH, false]]);
  assert.ok(fs.existsSync(s.arquivos[HASH]), 'o arquivo compartilhado continua no disco');
  assert.equal(s.vault.get(HASH).releasedAs, 'stop', 'o cofre registra o que de fato ocorreu: rede liberada, arquivos mantidos');
});

test('delete: o aviso do painel e o log dizem que os arquivos foram mantidos por serem compartilhados', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  compartilhar(s);
  s.vault.get(HASH2).satisfiedAt = null;
  s.vault.get(HASH2).tracker = undefined;
  const linhas = [];
  const original = console.log;
  console.log = (...a) => linhas.push(a.join(' '));
  try { await s.b.releaseSatisfied(); } finally { console.log = original; }
  assert.ok(linhas.some((l) => /arquivos mantidos/.test(l) && !/arquivos liberados/.test(l)), linhas.join('\n'));
  const titulo = s.b.snapshot(s.clock.t).titles.find((t) => t.infoHash === HASH);
  assert.ok(titulo.warnings.some((w) => /compartilh/i.test(w) && /mantid/i.test(w)), JSON.stringify(titulo.warnings));
  assert.ok(s.b.hnrWarnings(s.clock.t).some((w) => /compartilh/i.test(w)));
});

test('delete: com os dois títulos cumpridos e compartilhando o arquivo, nenhum apaga (o arquivo segue no disco)', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  compartilhar(s);
  const r = await s.liberar();
  assert.equal(r.length, 2);
  assert.deepEqual(s.chamadas.map((c) => c.destroyStore), [false, false]);
  assert.ok(fs.existsSync(s.arquivos[HASH]));
});

test('delete: arquivos que só um título usa continuam sendo apagados', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  const r = await s.liberar();
  assert.equal(r.length, 2);
  assert.deepEqual(s.chamadas.map((c) => c.destroyStore), [true, true]);
  assert.equal(fs.existsSync(s.arquivos[HASH]), false);
  assert.equal(s.vault.get(HASH).releasedAs, 'delete');
  assert.equal(s.b.hnrWarnings(s.clock.t).some((w) => /compartilh/i.test(w)), false);
});

test('delete: caminhos que diferem só em "./" contam como o mesmo arquivo (mesma identidade das ações individuais)', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  s.b.entries.get(HASH2).files = [{ path: './video0.mkv', length: 1 }];
  s.vault.get(HASH2).satisfiedAt = null;
  s.vault.get(HASH2).tracker = undefined;
  await s.liberar();
  assert.deepEqual(s.chamadas.map((c) => c.destroyStore), [false]);
});

test('delete: título fora da biblioteca (sem lista de arquivos) falha fechado e mantém os arquivos', async () => {
  const s = setup();
  s.b.entries.delete(HASH);
  const r = await s.liberar();
  assert.equal(r.length, 1);
  assert.deepEqual(s.chamadas.map((c) => c.destroyStore), [false]);
  assert.ok(fs.existsSync(s.arquivos[HASH]));
});

test('stop com arquivo compartilhado não gera aviso de "mantidos por compartilhamento"', async () => {
  const s = setup({ afterSeed: 'stop', hashes: [HASH, HASH2] });
  compartilhar(s);
  await s.liberar();
  assert.equal(s.b.hnrWarnings(s.clock.t).some((w) => /compartilh/i.test(w)), false);
});

test('arquivos mantidos por falta da lista: o cofre guarda o motivo, sobrevive ao recarregar e o aviso o explica', async () => {
  const s = setup();
  s.b.entries.set(HASH, { infoHash: HASH, files: [] });
  await s.liberar();
  assert.equal(s.vault.get(HASH).releaseFilesKept, 'arquivos-desconhecidos');
  const recarregado = new SeedVault({ file: path.join(s.dir, 'vault.json'), now: () => s.clock.t });
  assert.equal(recarregado.get(HASH).releaseFilesKept, 'arquivos-desconhecidos');
  assert.ok(s.b.hnrWarnings(s.clock.t).some((w) => /não foi possível confirmar quais arquivos/.test(w)));
});

test('o aviso de arquivos compartilhados some quando o outro título sai da biblioteca ou o usuário mantém o seed', async () => {
  const s = setup({ hashes: [HASH, HASH2] });
  compartilhar(s);
  s.vault.get(HASH2).satisfiedAt = null;
  s.vault.get(HASH2).tracker = undefined;
  await s.liberar();
  const aviso = () => s.b.hnrWarnings(s.clock.t).some((w) => /compartilh/i.test(w));
  assert.equal(aviso(), true);
  const outro = s.b.entries.get(HASH2);
  s.b.entries.delete(HASH2);
  assert.equal(aviso(), false, 'sem o outro título o aviso ficaria obsoleto');
  s.b.entries.set(HASH2, outro);
  assert.equal(aviso(), true);
  s.vault.setSeedChoice(HASH, 'keep');
  assert.equal(aviso(), false);
  assert.equal(s.vault.get(HASH).releaseFilesKept, undefined);
});
