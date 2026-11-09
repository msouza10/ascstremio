// Medição de stalls, seeks, primeiro byte e 504 (issue #33). Relógio, streams e torrent simulados:
// sem rede, sem torrent real e sem dados da conta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const { StreamMetrics, Histogram } = require('../src/stream-metrics');
const { tmpdir } = require('./tmp-helper');

const MiB = 1024 * 1024;
function relogio() {
  const c = { t: 1000, now: () => c.t, avanca(ms) { c.t += ms; } };
  return c;
}
function logFalso() {
  const linhas = [];
  const f = (nivel) => (msg, campos) => linhas.push({ nivel, msg, campos });
  return { linhas, debug: f('debug'), info: f('info'), warn: f('warn'), error: f('error') };
}

test('histograma estima P50/P95 pelo limite da faixa e nunca passa do máximo', () => {
  const h = new Histogram();
  assert.equal(h.snapshot().p50Ms, null);
  for (const ms of [50, 60, 70, 80, 3000]) h.add(ms);
  const s = h.snapshot();
  assert.equal(s.count, 5);
  assert.equal(s.p50Ms, 100);
  assert.equal(s.p95Ms, 3000);
  assert.equal(s.maxMs, 3000);
});

test('primeiro byte é medido uma vez; espera abaixo do limite não é stall', () => {
  const c = relogio();
  const m = new StreamMetrics({ now: c.now, stallMs: 2000 });
  const t = m.begin('a:0', { start: 0 });
  t.waiting();
  c.avanca(300);
  t.received(1000);
  t.waiting();
  c.avanca(1999);
  t.received(1000);
  t.finish('ok');
  const s = m.snapshot();
  assert.equal(s.firstByte.count, 1);
  assert.equal(s.firstByte.maxMs, 300);
  assert.equal(s.stalls.count, 0);
  assert.equal(s.bytes, 2000);
});

test('stall detectado, medido e encerrado quando os dados voltam', () => {
  const c = relogio();
  const m = new StreamMetrics({ now: c.now, stallMs: 2000 });
  const t = m.begin('a:0', { start: 0 });
  t.waiting(); c.avanca(100); t.received(10);
  t.waiting();
  c.avanca(2500);
  assert.equal(m.snapshot().stalledNow, 1, 'em andamento aparece no snapshot');
  t.received(10);
  assert.equal(m.snapshot().stalledNow, 0, 'encerrado quando o dado chega');
  t.finish('ok');
  const s = m.snapshot();
  assert.equal(s.stalls.count, 1);
  assert.equal(s.stalls.maxMs, 2500);
  assert.equal(s.stalls.abandoned, 0);
});

test('fechar o player no meio de um stall conta o stall como abandonado', () => {
  const c = relogio();
  const m = new StreamMetrics({ now: c.now, stallMs: 1000 });
  const t = m.begin('a:0', { start: 0 });
  t.waiting(); t.received(10);
  t.waiting();
  c.avanca(4000);
  t.finish('fechado');
  const s = m.snapshot();
  assert.equal(s.stalls.count, 1);
  assert.equal(s.stalls.abandoned, 1);
  assert.equal(s.outcomes.fechado, 1);
  assert.equal(s.open, 0);
});

test('seeks: continuação, avanço e recuo distantes são classificados; salto curto não é seek', () => {
  const c = relogio();
  const m = new StreamMetrics({ now: c.now, seekBytes: 4 * MiB });
  const r1 = m.begin('a:0', { start: 0 });
  r1.waiting(); r1.received(10 * MiB); r1.finish('fechado');
  const r2 = m.begin('a:0', { start: 10 * MiB + 1000 }); // continua de onde parou (dentro da tolerância)
  r2.waiting(); r2.received(MiB); r2.finish('fechado');
  const r3 = m.begin('a:0', { start: 500 * MiB }); // avanço
  r3.waiting(); r3.received(MiB); r3.finish('fechado');
  const r4 = m.begin('a:0', { start: 20 * MiB }); // recuo
  r4.finish('fechado');
  const s = m.snapshot();
  assert.deepEqual(s.kinds, { inicial: 1, continuo: 1, avanco: 1, recuo: 1 });
  assert.equal(s.sessions[0].seeks, 2);
  assert.equal(s.sessions.length, 1, 'mesmo arquivo = mesma sessão');
});

test('504 por timeout conta, não entra no histograma de primeiro byte e fecha a resposta', () => {
  const c = relogio();
  const m = new StreamMetrics({ now: c.now });
  const t = m.begin('a:0', { start: 0 });
  t.waiting();
  c.avanca(60_000);
  t.timeout();
  t.finish('fechado'); // o 'close' posterior é inócuo
  const s = m.snapshot();
  assert.equal(s.timeouts504, 1);
  assert.equal(s.outcomes['504'], 1);
  assert.equal(s.outcomes.fechado, undefined);
  assert.equal(s.firstByte.count, 0);
  assert.equal(s.stalls.count, 0);
  assert.equal(s.open, 0);
});

test('contadores por sessão não vazam entre arquivos e a sessão ociosa é descartada com resumo', () => {
  const c = relogio();
  const log = logFalso();
  const m = new StreamMetrics({ now: c.now, log, stallMs: 1000, idleMs: 60_000 });
  const a = m.begin('a:0', { start: 0 });
  a.waiting(); a.received(1); a.waiting(); c.avanca(1500); a.received(1); a.finish('ok');
  const b = m.begin('b:0', { start: 0 });
  b.waiting(); b.received(1); b.finish('ok');
  const [sa, sb] = m.snapshot().sessions;
  assert.equal(sa.stalls, 1);
  assert.equal(sb.stalls, 0, 'stall de um arquivo não aparece no outro');
  c.avanca(61_000);
  const outro = m.begin('c:0', { start: 0 }); // dispara a limpeza
  outro.finish('ok');
  assert.deepEqual(m.snapshot().sessions.map((s) => s.id), [3]);
  const resumos = log.linhas.filter((l) => l.msg === 'reprodução: sessão encerrada');
  assert.equal(resumos.length, 2);
  assert.equal(resumos.find((l) => l.campos.sessao === 1).campos.stalls, 1);
  // Reabrir o arquivo depois da limpeza começa uma sessão nova (não herda contadores nem posição).
  const d = m.begin('a:0', { start: 900 * MiB });
  assert.equal(d.kind, 'inicial');
});

test('limita o número de sessões guardadas', () => {
  const c = relogio();
  const m = new StreamMetrics({ now: c.now, maxSessions: 3 });
  for (let i = 0; i < 10; i++) m.begin(`h${i}:0`, { start: 0 }).finish('ok');
  m.begin('x:0', { start: 0 }).finish('ok');
  assert.ok(m.sessions.size <= 4);
});

// ---- integração com a ponte: relógio e torrent simulados ----

const HASH = 'ab'.repeat(20);
const store = new CredentialStore({ file: path.join(tmpdir('met-cred-'), 'credentials.json') });
const { token: TOKEN } = store.create({ name: 'teste' });

function ponte(clock, log, over = {}) {
  const b = new Bridge({
    torrentDir: '/tmp', storeDir: '/tmp', port: 7098, publicUrl: 'http://127.0.0.1:7010/', credentials: store,
    vault: new SeedVault({ file: path.join(tmpdir('met-'), 'v.json') }),
    monotonic: clock.now, streamMetrics: { log, stallMs: 2000 }, ...over,
  });
  b.client = { torrents: [] };
  return b;
}
function resposta() {
  const r = new EventEmitter();
  Object.assign(r, { statusCode: 0, headers: {}, chunks: [], writableFinished: false, writableEnded: false, headersSent: false, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); this.headersSent = true; },
    write(c) { this.chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) this.chunks.push(Buffer.from(c)); this.writableEnded = true; this.writableFinished = true; this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); } });
  return r;
}
const pedido = (range) => ({ method: 'GET', url: `/s/${HASH}/0?k=${TOKEN}`, headers: range ? { range } : {}, socket: { remoteAddress: '127.0.0.1' } });

// Iterável sem leitura antecipada (como o FileIterator): cada next() só roda quando a ponte pede.
function iterador(proximo) {
  return { [Symbol.asyncIterator]() { return { next: proximo, return: async () => ({ done: true }) }; } };
}

// Torrent cujo arquivo entrega os trechos de `plano`: { ms, bytes } (o relógio avança `ms` antes de cada trecho).
function torrentCom(clock, plano, tamanho = 100 * MiB) {
  let meu = [];
  return {
    ready: true, numPeers: 3, progress: 0,
    files: [{ length: tamanho, path: 'Filme Secreto.mkv', createReadStream: () => { meu = [...plano]; return iterador(async () => {
      const p = meu.shift();
      if (!p) return { done: true };
      clock.avanca(p.ms);
      return { done: false, value: Buffer.alloc(p.bytes, 1) };
    }); } }],
  };
}

test('ponte: mede primeiro byte, stall e seek numa reprodução simulada, sem vazar hash, caminho ou nome', async () => {
  const c = relogio();
  const log = logFalso();
  const b = ponte(c, log);
  b.getTorrent = async () => torrentCom(c, [{ ms: 400, bytes: 100 }, { ms: 3000, bytes: 100 }, { ms: 50, bytes: 100 }]);
  const r1 = resposta();
  await b.handle(pedido('bytes=0-299'), r1);
  assert.equal(r1.statusCode, 206);
  const r2 = resposta();
  await b.handle(pedido(`bytes=${50 * MiB}-`), r2); // seek para frente
  const s = b.snapshot().streaming;
  assert.equal(s.responses, 2);
  assert.equal(s.firstByte.count, 2);
  assert.equal(s.firstByte.maxMs, 400);
  assert.equal(s.stalls.count, 2, 'um stall de 3 s em cada resposta');
  assert.equal(s.stalls.maxMs, 3000);
  assert.deepEqual(s.kinds, { inicial: 1, continuo: 0, avanco: 1, recuo: 0 });
  assert.equal(s.open, 0);

  const texto = JSON.stringify(s) + JSON.stringify(log.linhas);
  assert.ok(!texto.includes(HASH), 'sem infoHash completo');
  assert.ok(!texto.includes(HASH.slice(0, 8)), 'nem o curto');
  assert.ok(!/Filme Secreto|\.mkv|127\.0\.0\.1|\/tmp/.test(texto), 'sem nome, caminho ou IP');
  assert.ok(!texto.includes(TOKEN));
  assert.ok(log.linhas.some((l) => l.msg === 'reprodução: resposta encerrada' && l.campos.stalls === 1));
});

test('ponte: 504 por timeout do primeiro trecho é contado e o comportamento do 504 não muda', async () => {
  const c = relogio();
  const log = logFalso();
  const b = ponte(c, log, { firstByteTimeoutMs: 20 });
  b.getTorrent = async () => ({
    ready: true, numPeers: 0, progress: 0,
    files: [{ length: 10, path: 'f.mkv', createReadStream: () => iterador(() => new Promise(() => {})) }], // nunca entrega
  });
  const r = resposta();
  await b.handle(pedido('bytes=0-9'), r);
  assert.equal(r.statusCode, 504);
  const s = b.snapshot().streaming;
  assert.equal(s.timeouts504, 1);
  assert.equal(s.outcomes['504'], 1);
  assert.equal(s.firstByte.count, 0);
  assert.equal(s.open, 0);
});
