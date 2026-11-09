// Retomada por risco de seed e medição do custo da verificação (issue #32).
// Cofre, tracker, relógio e getTorrent são simulados: nada de rede, de torrent real ou de dados da conta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const settings = require('../src/settings');
const { rankPending, runLimited, CLASS } = require('../src/resume-policy');
const { tmpdir } = require('./tmp-helper');

const H = (n) => String(n).padStart(40, '0');
const DIA = 86_400_000;
const NOW = Date.parse('2026-06-01T12:00:00Z');

function cofre() {
  return new SeedVault({ file: path.join(tmpdir('retomada-'), 'vault.json'), now: () => NOW });
}

// Cria uma entrada concluída. `tracker` (opcional) imita o resumo do myHistory.
function add(vault, n, { completed = true, tracker, lastSeenAt, background, completedAt } = {}) {
  const e = vault.markSeen(H(n), { name: `filme ${n}`, torrentPath: `asc-${n}.torrent` });
  if (completed) { vault.markCompleted(H(n)); e.completedAt = completedAt ?? NOW - n * 1000; }
  if (lastSeenAt !== undefined) e.lastSeenAt = lastSeenAt;
  if (background) e.backgroundComplete = true;
  if (tracker) e.tracker = { checkedAt: NOW, ...tracker };
  return e;
}

const ordem = (r) => r.map((x) => x.infoHash);

test('ordena por classe: tracker, local, segundo plano, sem obrigação', () => {
  const v = cofre();
  const local = add(v, 1);
  const bg = add(v, 2, { completed: false, background: true });
  const feito = add(v, 3, { tracker: { satisfied: true, deadlineMs: NOW + DIA } });
  const trk = add(v, 4, { tracker: { deadlineMs: NOW + 9 * DIA, remainingMs: 1000 } });
  const r = rankPending([local, bg, feito, trk], { vault: v, now: NOW });
  assert.deepEqual(ordem(r), [H(4), H(1), H(2), H(3)]);
  assert.deepEqual(r.map((x) => x.klass), [CLASS.TRACKER, CLASS.LOCAL, CLASS.BACKGROUND, CLASS.NONE]);
});

test('dentro da classe, o prazo mais próximo vem primeiro; o do tracker vale mais que o do cofre', () => {
  const v = cofre();
  const a = add(v, 1, { tracker: { deadlineMs: NOW + 5 * DIA } });
  const b = add(v, 2, { tracker: { deadlineMs: NOW + 1 * DIA } });
  // Cofre acha que está folgado (visto agora), mas o tracker diz que vence em 2 h: o tracker vence.
  const c = add(v, 3, { lastSeenAt: NOW, tracker: { deadlineMs: NOW + 2 * 3_600_000 } });
  const r = rankPending([a, b, c], { vault: v, now: NOW });
  assert.deepEqual(ordem(r), [H(3), H(2), H(1)]);
  assert.equal(r[0].deadlineSource, 'tracker');
  assert.equal(r[0].hoursToDeadline, 2);
});

test('prazo já vencido vem antes de qualquer prazo futuro', () => {
  const v = cofre();
  const a = add(v, 1, { lastSeenAt: NOW - 3 * DIA }); // prazo local daqui a 9 dias
  const b = add(v, 2, { lastSeenAt: NOW - 20 * DIA }); // vencido há 8 dias
  assert.deepEqual(ordem(rankPending([a, b], { vault: v, now: NOW })), [H(2), H(1)]);
});

test('dados ausentes são tratados de forma conservadora (iminente), nunca empurrados para o fim', () => {
  const v = cofre();
  const conhecido = add(v, 1, { tracker: { deadlineMs: NOW + DIA } });
  const sem = add(v, 2, { tracker: {} });
  // Sem nenhuma data no cofre: o prazo é desconhecido.
  delete sem.lastSeenAt; delete sem.firstSeenAt;
  v.deadlineMs = ((orig) => (h) => (h === H(2) ? null : orig.call(v, h)))(v.deadlineMs);
  const r = rankPending([conhecido, sem], { vault: v, now: NOW });
  assert.deepEqual(ordem(r), [H(2), H(1)]);
  assert.equal(r[0].deadlineSource, 'desconhecido');
  assert.equal(r[0].hoursToDeadline, null);
});

test('empate de prazo: mais horas devidas primeiro, depois conclusão mais antiga, depois infoHash', () => {
  const v = cofre();
  const prazo = NOW + 3 * DIA;
  const a = add(v, 1, { tracker: { deadlineMs: prazo, remainingMs: 10 * 3_600_000 }, completedAt: NOW - 5 });
  const b = add(v, 2, { tracker: { deadlineMs: prazo, remainingMs: 60 * 3_600_000 }, completedAt: NOW - 5 });
  const c = add(v, 3, { tracker: { deadlineMs: prazo, remainingMs: 10 * 3_600_000 }, completedAt: NOW - 100 });
  const d = add(v, 4, { tracker: { deadlineMs: prazo, remainingMs: 10 * 3_600_000 }, completedAt: NOW - 100 });
  const esperado = [H(2), H(3), H(4), H(1)];
  assert.deepEqual(ordem(rankPending([a, b, c, d], { vault: v, now: NOW })), esperado);
  // Estável e determinístico: a ordem de entrada não muda o resultado.
  assert.deepEqual(ordem(rankPending([d, c, b, a], { vault: v, now: NOW })), esperado);
  assert.deepEqual(ordem(rankPending([c, a, d, b], { vault: v, now: NOW })), esperado);
});

test('runLimited respeita o limite, preserva a ordem de partida e isola falhas', async () => {
  let ativos = 0;
  let maximo = 0;
  const comecou = [];
  await runLimited([1, 2, 3, 4, 5], 2, async (n) => {
    comecou.push(n);
    ativos += 1; maximo = Math.max(maximo, ativos);
    await new Promise((r) => setTimeout(r, 5));
    ativos -= 1;
    if (n === 2) throw new Error('falhou');
  });
  assert.equal(maximo, 2);
  assert.deepEqual(comecou, [1, 2, 3, 4, 5]);
  // Limite inválido cai para 1; lista vazia não trava.
  await runLimited([], 0, async () => assert.fail());
  const seq = [];
  await runLimited([1, 2], NaN, async (n) => { seq.push(n); });
  assert.deepEqual(seq, [1, 2]);
});

// ---- ponte ----

function ponte(v, { hashes, abrir, concurrency = 1, monotonic, full = true } = {}) {
  const b = new Bridge({ torrentDir: '/nao/existe', storeDir: '/nao/existe/store', port: 7097, vault: v, resumeConcurrency: concurrency, monotonic, clock: () => NOW });
  b.client = { torrents: [] };
  for (const h of hashes) b.entries.set(h, { infoHash: h, files: [] });
  b.diskState = () => (full ? 'full' : 'none');
  b.getTorrent = abrir ?? (async (h) => { const t = { infoHash: h, length: 1000 }; b.client.torrents.push(t); return t; });
  return b;
}

test('a ponte abre na ordem de risco e mede cada abertura', async () => {
  const v = cofre();
  add(v, 1, { tracker: { deadlineMs: NOW + 8 * DIA } });
  add(v, 2, { tracker: { deadlineMs: NOW + 1 * DIA } });
  add(v, 3, { lastSeenAt: NOW - DIA });
  const abertos = [];
  let t = 0;
  const b = ponte(v, {
    hashes: [H(1), H(2), H(3)],
    monotonic: () => (t += 10),
    abrir: async (h) => { abertos.push(h); const x = { infoHash: h, length: 5_000 }; b.client.torrents.push(x); return x; },
  });
  assert.equal(b.resumeSnapshot(), null);
  await b.resumePending();
  assert.deepEqual(abertos, [H(2), H(1), H(3)]);
  const s = b.resumeSnapshot();
  assert.equal(s.running, false);
  assert.equal(s.queued, 3);
  assert.equal(s.opened, 3);
  assert.equal(s.bytes, 15_000);
  assert.equal(s.items.length, 3);
  assert.deepEqual(s.items.map((i) => i.classe), ['tracker', 'tracker', 'local']);
  assert.ok(s.items.every((i) => i.resultado === 'ok' && i.ms > 0 && i.bytes === 5_000));
  assert.ok(s.totalMs >= s.slowestMs && s.firstOpenMs > 0);
  assert.equal(typeof s.loopLagMaxMs, 'number');
  assert.ok(s.rssPeakMB >= s.rssStartMB);
  // Sem caminho absoluto, nome nem hash completo no que vai ao painel.
  const json = JSON.stringify(s);
  assert.ok(!json.includes('/nao/existe') && !json.includes('filme') && !json.includes(H(2)));
  assert.equal(b.snapshot().resume.opened, 3);
});

test('falha de uma retomada não bloqueia as demais e entra na medição', async () => {
  const v = cofre();
  add(v, 1, { tracker: { deadlineMs: NOW + DIA } });
  add(v, 2, { tracker: { deadlineMs: NOW + 2 * DIA } });
  add(v, 3, { tracker: { deadlineMs: NOW + 3 * DIA } });
  const b = ponte(v, {
    hashes: [H(1), H(2), H(3)],
    abrir: async (h) => {
      if (h === H(1)) { const e = new Error('Falha ao abrir torrent'); throw e; }
      if (h === H(2)) { const e = new Error('sem espaço'); e.expose = true; throw e; }
      const x = { infoHash: h, length: 7 }; b.client.torrents.push(x); return x;
    },
  });
  const antes = console.error;
  console.error = () => {};
  try { await b.resumePending(); } finally { console.error = antes; }
  const s = b.resumeSnapshot();
  assert.deepEqual([s.opened, s.failed, s.deferred], [1, 1, 1]);
  assert.deepEqual(s.items.map((i) => i.resultado), ['erro', 'adiado', 'ok']);
});

test('arquivo ausente: não chama getTorrent (nada de download novo) e conta como sem arquivo', async () => {
  const v = cofre();
  add(v, 1, { tracker: { deadlineMs: NOW + DIA } });
  let chamadas = 0;
  const b = ponte(v, { hashes: [H(1)], full: false, abrir: async () => { chamadas++; } });
  const antes = console.warn;
  console.warn = () => {};
  try { await b.resumePending(); } finally { console.warn = antes; }
  assert.equal(chamadas, 0);
  assert.equal(b.resumeSnapshot().noData, 1);
});

test('já no motor ou fora da biblioteca: ignora', async () => {
  const v = cofre();
  add(v, 1, { tracker: { deadlineMs: NOW + DIA } });
  add(v, 2, { tracker: { deadlineMs: NOW + DIA } }); // não está em entries
  const abertos = [];
  const b = ponte(v, { hashes: [H(1)], abrir: async (h) => { abertos.push(h); } });
  b.client.torrents.push({ infoHash: H(1) });
  await b.resumePending();
  assert.deepEqual(abertos, []);
  assert.equal(b.resumeSnapshot(), null); // passada ociosa não cria medição
});

test('passada ociosa (tudo já aberto) preserva a medição da retomada real', async () => {
  const v = cofre();
  add(v, 1, { tracker: { deadlineMs: NOW + DIA } });
  const b = ponte(v, { hashes: [H(1)] });
  await b.resumePending();
  const antes = JSON.stringify(b.resumeSnapshot());
  assert.equal(b.resumeSnapshot().opened, 1);
  await b.resumePending(); // conciliação horária: o torrent segue pendente e já está no motor
  assert.equal(JSON.stringify(b.resumeSnapshot()), antes);
});

test('concorrência limitada: o prazo curto não espera o torrent grande e lento', async () => {
  const v = cofre();
  add(v, 1, { tracker: { deadlineMs: NOW + 1 * DIA } }); // grande e lento, o mais urgente
  add(v, 2, { tracker: { deadlineMs: NOW + 2 * DIA } });
  add(v, 3, { tracker: { deadlineMs: NOW + 3 * DIA } });
  let liberar;
  const trava = new Promise((r) => { liberar = r; });
  const terminou = [];
  let ativos = 0;
  let maximo = 0;
  const b = ponte(v, {
    hashes: [H(1), H(2), H(3)],
    concurrency: 2,
    abrir: async (h) => {
      ativos += 1; maximo = Math.max(maximo, ativos);
      if (h === H(1)) await trava;
      ativos -= 1;
      terminou.push(h);
      const x = { infoHash: h, length: 1 }; b.client.torrents.push(x); return x;
    },
  });
  const run = b.resumePending();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(terminou, [H(2), H(3)]); // os outros passaram enquanto o grande verifica
  assert.equal(b.resumeSnapshot().running, true);
  assert.equal(b.resumeSnapshot().inFlight.length, 1);
  liberar();
  await run;
  assert.equal(maximo, 2);
  assert.equal(b.resumeSnapshot().opened, 3);
});

test('padrão de 1: uma abertura por vez, como antes', async () => {
  const v = cofre();
  for (const n of [1, 2, 3]) add(v, n, { tracker: { deadlineMs: NOW + n * DIA } });
  let ativos = 0;
  let maximo = 0;
  const b = ponte(v, {
    hashes: [H(1), H(2), H(3)],
    abrir: async (h) => {
      ativos += 1; maximo = Math.max(maximo, ativos);
      await new Promise((r) => setTimeout(r, 3));
      ativos -= 1;
      const x = { infoHash: h, length: 1 }; b.client.torrents.push(x); return x;
    },
  });
  assert.equal(b.resumeConcurrency, 1);
  await b.resumePending();
  assert.equal(maximo, 1);
});

test('reentrada: chamadas durante a retomada não duplicam a fila e refazem a ordem ao final', async () => {
  const v = cofre();
  add(v, 1, { tracker: { deadlineMs: NOW + 1 * DIA } });
  let liberar;
  const trava = new Promise((r) => { liberar = r; });
  const chamadas = [];
  const b = ponte(v, {
    hashes: [H(1), H(2)],
    abrir: async (h) => {
      chamadas.push(h);
      if (h === H(1)) await trava;
      const x = { infoHash: h, length: 1 }; b.client.torrents.push(x); return x;
    },
  });
  const p1 = b.resumePending();
  await new Promise((r) => setTimeout(r, 5));
  // A conciliação com o tracker revela uma obrigação nova enquanto a primeira ainda verifica.
  add(v, 2, { tracker: { deadlineMs: NOW + 2 * DIA } });
  const p2 = b.resumePending();
  const p3 = b.resumePending();
  assert.equal(p2, p1);
  assert.equal(p3, p1);
  liberar();
  await p1;
  // Cada torrent foi pedido uma única vez, e o novo entrou na passada extra.
  assert.deepEqual(chamadas, [H(1), H(2)]);
  const s = b.resumeSnapshot();
  assert.equal(s.runs, 2);
  // As duas passadas somam na mesma medição (a segunda não apaga a da partida).
  assert.equal(s.opened, 2);
  assert.equal(s.queued, 2);
  assert.deepEqual(s.items.map((i) => i.resultado), ['ok', 'ok']);
  assert.equal(b.resumeRun, null);
  // Nova chamada depois do fim começa outra retomada (nada a fazer: já estão no motor).
  await b.resumePending();
  assert.deepEqual(chamadas, [H(1), H(2)]);
});

test('retomada sem pendências não registra medição nem lança', async () => {
  const v = cofre();
  const b = ponte(v, { hashes: [] });
  await b.resumePending();
  assert.equal(b.resumeSnapshot(), null);
});

test('RESUME_CONCURRENCY: padrão 1, faixa de 1 a 8', () => {
  const dir = tmpdir('retomada-cfg-');
  assert.equal(settings.resolve({ dataDir: dir, env: {} }).values.RESUME_CONCURRENCY, 1);
  assert.equal(settings.resolve({ dataDir: dir, env: { RESUME_CONCURRENCY: '4' } }).values.RESUME_CONCURRENCY, 4);
  for (const ruim of ['0', '9', 'dois', '1.5']) {
    assert.ok(settings.resolve({ dataDir: dir, env: { RESUME_CONCURRENCY: ruim } }).problems.length >= 1, ruim);
  }
});
