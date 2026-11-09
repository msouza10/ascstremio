const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UploadPolicy, SEED_PENDING_FLOOR, minCap } = require('../src/upload-policy');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const settings = require('../src/settings');
const { tmpdir } = require('./tmp-helper');

const relogio = (t0 = 1_000_000) => { const r = { t: t0, now: () => r.t, avancar(ms) { r.t += ms; } }; return r; };

// Política com motor simulado: registra cada chamada de throttleUpload.
function politica(over = {}) {
  const rel = relogio();
  const motor = { chamadas: [], recusa: false };
  const estado = { sessoes: 0, pendente: false };
  const p = new UploadPolicy({
    normal: -1, stream: 262144, restoreMs: 15_000, now: rel.now,
    apply: (r) => { if (motor.recusa) return false; motor.chamadas.push(r); },
    activeSessions: () => estado.sessoes, seedPending: () => estado.pendente, ...over,
  });
  return { p, rel, motor, estado };
}

test('minCap: menor teto finito; -1 é sem teto; 0 vence', () => {
  assert.equal(minCap(-1, -1), -1);
  assert.equal(minCap(-1, 5), 5);
  assert.equal(minCap(7, -1), 7);
  assert.equal(minCap(7, 5), 5);
  assert.equal(minCap(0, 5), 0);
});

test('exemplos da issue: o teto de streaming nunca aumenta o do operador', () => {
  for (const [normal, stream, esperado] of [[-1, 262144, 262144], [1048576, 262144, 262144], [131072, 262144, 131072]]) {
    const { p, estado, motor } = politica({ normal, stream });
    estado.sessoes = 1;
    p.evaluate();
    assert.equal(p.applied, esperado, `${normal}/${stream}`);
    assert.equal(motor.chamadas.at(-1) ?? normal, esperado);
  }
});

test('padrão (sem teto de streaming): política inerte, o motor nunca é chamado', () => {
  const { p, estado, motor } = politica({ stream: -1 });
  estado.sessoes = 2;
  p.evaluate();
  estado.sessoes = 0;
  p.evaluate();
  assert.deepEqual(motor.chamadas, []);
  assert.equal(p.state, 'normal');
});

test('teto normal 0 legado é preservado: nada é reduzido nem "consertado"', () => {
  const { p, estado, motor } = politica({ normal: 0 });
  estado.sessoes = 1;
  p.evaluate();
  assert.deepEqual(motor.chamadas, []);
  assert.equal(p.applied, 0);
});

test('transições com relógio simulado: streaming, restoring, normal e cancelamento', () => {
  const { p, rel, estado, motor } = politica();
  p.evaluate();
  assert.equal(p.state, 'normal');
  assert.deepEqual(motor.chamadas, []);

  estado.sessoes = 1; // primeira reprodução
  assert.equal(p.evaluate().policyState, 'streaming');
  estado.sessoes = 3; // mais reproduções/seek: não multiplica nem reaplica
  rel.avancar(5000);
  p.evaluate();
  assert.deepEqual(motor.chamadas, [262144]);

  estado.sessoes = 0; // última encerrada
  const r = p.evaluate();
  assert.equal(r.policyState, 'restoring');
  assert.equal(r.restoreAt, rel.t + 15_000);
  rel.avancar(14_000);
  assert.equal(p.evaluate().policyState, 'restoring');
  assert.equal(p.applied, 262144, 'ainda reduzido antes do prazo');

  estado.sessoes = 1; // nova reprodução antes do prazo: cancela a restauração
  assert.equal(p.evaluate().policyState, 'streaming');
  estado.sessoes = 0;
  p.evaluate();
  rel.avancar(15_000); // prazo recomeça a contar da última atividade
  const fim = p.evaluate();
  assert.equal(fim.policyState, 'normal');
  assert.equal(fim.effectiveUploadLimit, -1);
  assert.deepEqual(motor.chamadas, [262144, -1]);
});

test('restoreMs 0 restaura assim que as sessões acabam', () => {
  const { p, estado } = politica({ restoreMs: 0 });
  estado.sessoes = 1;
  p.evaluate();
  estado.sessoes = 0;
  assert.equal(p.evaluate().policyState, 'normal');
  assert.equal(p.applied, -1);
});

test('piso: com seed pendente o teto de streaming não cai abaixo de 64 KiB/s, mas respeita o teto do operador', () => {
  const { p, estado } = politica({ stream: 16384 });
  estado.sessoes = 1;
  p.evaluate();
  assert.equal(p.applied, 16384, 'sem obrigação aberta vale o mínimo configurado');
  estado.pendente = true; // reavalia no próximo tick
  const r = p.evaluate();
  assert.equal(r.effectiveUploadLimit, SEED_PENDING_FLOOR);
  assert.equal(r.seedPendingFloor, SEED_PENDING_FLOOR);
  estado.pendente = false;
  assert.equal(p.evaluate().effectiveUploadLimit, 16384);

  const baixo = politica({ normal: 20000, stream: 16384 });
  baixo.estado.sessoes = 1;
  baixo.estado.pendente = true;
  baixo.p.evaluate();
  assert.equal(baixo.p.applied, 20000, 'o piso nunca passa do teto explícito do operador');
});

test('falha do motor: mantém o último teto válido, sinaliza e tenta de novo', () => {
  const { p, estado, motor } = politica();
  estado.sessoes = 1;
  motor.recusa = true;
  const r = p.evaluate();
  assert.equal(r.applicationError, 'bandwidth_apply_failed');
  assert.equal(r.effectiveUploadLimit, -1, 'não declara aplicado o que o motor recusou');
  motor.recusa = false;
  assert.equal(p.evaluate().applicationError, null);
  assert.equal(p.applied, 262144);

  const lanca = politica({ apply: () => { throw new Error('boom'); } });
  lanca.estado.sessoes = 1;
  assert.doesNotThrow(() => lanca.p.evaluate());
  assert.equal(lanca.p.snapshot().applicationError, 'bandwidth_apply_failed');
});

test('configuração concorrente: recalcula na hora com as sessões existentes', () => {
  const { p, estado } = politica();
  estado.sessoes = 1;
  p.evaluate();
  assert.equal(p.applied, 262144);
  assert.equal(p.configure({ stream: 100000 }).effectiveUploadLimit, 100000);
  assert.equal(p.configure({ stream: -1 }).effectiveUploadLimit, -1, 'desligar o teto de streaming restaura já');
  assert.equal(p.configure({ stream: 50000, normal: 40000 }).effectiveUploadLimit, 40000);
  estado.sessoes = 0;
  p.configure({ restoreMs: 0 });
  assert.equal(p.applied, 40000, 'restaura o normal NOVO, não um valor capturado antes da edição');
});

// ------------------------------------------------------------------- ponte

const HASH = 'b'.repeat(40);
const store = new CredentialStore({ file: path.join(tmpdir('up-cred-'), 'credentials.json') });

function ponte(over = {}) {
  const rel = relogio();
  const vault = new SeedVault({ file: path.join(tmpdir('up-'), 'v.json') });
  const b = new Bridge({
    torrentDir: tmpdir('up-t-'), storeDir: tmpdir('up-s-'), freeSpace: () => ({ free: 1024 ** 4, total: 1024 ** 4 }),
    port: 7097, publicUrl: 'http://127.0.0.1:7097', credentials: store, vault, clock: rel.now,
    streamUploadLimit: 262144, uploadRestoreMs: 15_000, playbackGraceMs: 30_000, ...over,
  });
  const chamadas = [];
  b.client = { torrents: [], throttleUpload: (r) => { chamadas.push(r); } };
  return { b, rel, chamadas, vault };
}
function resposta(status = 200) {
  const r = new EventEmitter();
  Object.assign(r, { statusCode: status, headersSent: true, destroyed: false, destroy() { this.destroyed = true; this.emit('close'); } });
  return r;
}

test('ponte: admitir reduz antes de transferir; fechar + carência + espera restaura', () => {
  const { b, rel, chamadas } = ponte();
  const a = store.create({ name: 'tv' });
  const res = resposta();
  assert.ok(b.admitPlayback(res, a, `s:${HASH}:0`));
  assert.deepEqual(chamadas, [262144]);
  res.emit('close'); // Range fechou: a sessão fica pela carência
  rel.avancar(29_000);
  b.uploadPolicy.evaluate();
  assert.equal(b.uploadPolicy.state, 'streaming');
  rel.avancar(2_000); // carência de 30 s acabou
  assert.equal(b.uploadPolicy.evaluate().policyState, 'restoring');
  rel.avancar(15_000);
  assert.equal(b.uploadPolicy.evaluate().policyState, 'normal');
  assert.deepEqual(chamadas, [262144, -1]);
});

test('ponte: resposta de erro não reduz por muito tempo; 429 não altera o teto', () => {
  const { b, rel, chamadas } = ponte({ maxPlaybacks: 1, uploadRestoreMs: 0 });
  const a = store.create({ name: 'tv' });
  const c = store.create({ name: 'outra' });
  const erro = resposta(404);
  erro.headersSent = false;
  b.admitPlayback(erro, a, `s:${HASH}:0`);
  assert.equal(b.uploadPolicy.state, 'streaming');
  erro.emit('close'); // só houve erro: a vaga some
  assert.equal(b.uploadPolicy.state, 'normal');
  assert.deepEqual(chamadas, [262144, -1]);

  const ok = resposta();
  b.admitPlayback(ok, a, `s:${HASH}:0`);
  const recusada = { statusCode: 0, writeHead(s) { this.statusCode = s; }, end() {}, once() {}, get destroyed() { return false; } };
  assert.equal(b.admitPlayback(recusada, c, 'outro'), null);
  assert.equal(recusada.statusCode, 429);
  assert.equal(b.uploadPolicy.state, 'streaming');
  assert.equal(chamadas.length, 3);
  rel.avancar(0);
});

test('ponte: revogar a credencial derruba a vaga e não deixa o teto reduzido para sempre', () => {
  const { b, rel } = ponte({ uploadRestoreMs: 1000 });
  const a = store.create({ name: 'tv' });
  const res = resposta();
  b.admitPlayback(res, a, `s:${HASH}:0`);
  assert.equal(b.uploadPolicy.state, 'streaming');
  b.dropSessions(a.id);
  assert.equal(b.uploadPolicy.state, 'restoring');
  rel.avancar(1000);
  assert.equal(b.uploadPolicy.evaluate().policyState, 'normal');
  assert.equal(b.client.torrents.length, 0);
});

test('ponte: duas sessões simultâneas aplicam o teto uma vez; só a última a sair inicia a restauração', () => {
  const { b, chamadas } = ponte({ uploadRestoreMs: 0, playbackGraceMs: 5_000 });
  const a = store.create({ name: 'tv1' });
  const c = store.create({ name: 'tv2' });
  const r1 = resposta();
  const r2 = resposta();
  b.admitPlayback(r1, a, `s:${HASH}:0`);
  b.admitPlayback(r2, c, `s:${HASH}:0`);
  assert.deepEqual(chamadas, [262144]);
  r1.emit('close');
  assert.equal(b.uploadPolicy.state, 'streaming');
});

test('ponte: reinício começa em normal e sem teto de streaming nada muda (padrão)', () => {
  const { b, chamadas } = ponte({ streamUploadLimit: -1 });
  const a = store.create({ name: 'tv' });
  b.admitPlayback(resposta(), a, `s:${HASH}:0`);
  assert.deepEqual(chamadas, []);
  const novo = ponte();
  assert.equal(novo.b.uploadPolicy.state, 'normal');
  assert.equal(novo.b.uploadPolicy.applied, -1);
  assert.deepEqual(novo.chamadas, []);
});

test('ponte: seed pendente no cofre eleva o piso e o cofre não é tocado', () => {
  const { b, vault } = ponte({ streamUploadLimit: 16384 });
  vault.markSeen(HASH, { name: 'x' });
  vault.markCompleted(HASH);
  const antes = JSON.stringify(vault.list());
  const a = store.create({ name: 'tv' });
  b.admitPlayback(resposta(), a, `s:${HASH}:0`);
  assert.equal(b.uploadPolicy.applied, SEED_PENDING_FLOOR);
  assert.equal(JSON.stringify(vault.list()), antes, 'a política não altera as obrigações do cofre');
  assert.equal(b.playbackSnapshot().upload.policyState, 'streaming');
});

test('ponte: sem client (antes de iniciar) a falha é sinalizada sem lançar', () => {
  const { b } = ponte();
  b.client = null;
  const a = store.create({ name: 'tv' });
  assert.doesNotThrow(() => b.admitPlayback(resposta(), a, `s:${HASH}:0`));
  assert.equal(b.uploadPolicy.snapshot().applicationError, 'bandwidth_apply_failed');
});

test('configuração: chaves novas, padrão sem mudança e faixa válida', () => {
  const dir = tmpdir('up-cfg-');
  const r = settings.resolve({ dataDir: dir, env: {} });
  assert.equal(r.values.BRIDGE_STREAM_UPLOAD_LIMIT, -1);
  assert.equal(r.values.BRIDGE_UPLOAD_RESTORE_SECONDS, 15);
  assert.equal(settings.resolve({ dataDir: dir, env: { BRIDGE_STREAM_UPLOAD_LIMIT: '262144' } }).values.BRIDGE_STREAM_UPLOAD_LIMIT, 262144);
  for (const ruim of ['0', '100', '16383', '-2', 'x']) {
    assert.ok(settings.resolve({ dataDir: dir, env: { BRIDGE_STREAM_UPLOAD_LIMIT: ruim } }).problems.length >= 1, ruim);
  }
  assert.ok(settings.resolve({ dataDir: dir, env: { BRIDGE_UPLOAD_RESTORE_SECONDS: '301' } }).problems.length >= 1);
  assert.equal(settings.resolve({ dataDir: dir, env: { BRIDGE_UPLOAD_RESTORE_SECONDS: '0' } }).values.BRIDGE_UPLOAD_RESTORE_SECONDS, 0);
});
