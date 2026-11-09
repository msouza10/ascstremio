const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { tmpdir } = require('./tmp-helper');
const { Logger } = require('../src/logger');
const A = require('../src/alerts');
const settings = require('../src/settings');

const SECRET_URL = 'https://ntfy.example.org/topico-super-secreto-123456';
const BASE = { enabled: true, allowedHosts: ['ntfy.example.org'], cooldownMinutes: 60, trackerMinutes: 15, noPeersMinutes: 15 };
const MIN = 60_000;

function setup(extra = {}) {
  const dataDir = tmpdir('alerts-');
  const logger = new Logger({ echo: false });
  const sent = [];
  const clock = { t: 1_000_000_000_000 };
  const behavior = { fail: null };
  const transport = async (req) => {
    if (behavior.fail) throw behavior.fail;
    sent.push({ ...req, parsed: req.headers['Content-Type'].startsWith('application/json') ? JSON.parse(req.body) : null });
    return { status: 200 };
  };
  const mgr = new A.AlertManager({
    dataDir, env: {}, config: { ...BASE, ...extra }, transport, now: () => clock.t, random: () => 0.5,
    log: logger.child('alertas'), addSecret: (s) => logger.addSecret(s), timers: false,
  });
  assert.equal(mgr.setDestination({ url: SECRET_URL, bearerToken: 'bearer-muito-secreto' }).ok, true);
  return { mgr, dataDir, logger, sent, clock, behavior };
}
const snap = (over = {}) => ({ titles: [], summary: { freeBytes: 500 * 1024 ** 3 }, notices: [], ...over });
const diskLow = () => snap({ summary: { freeBytes: 1024 ** 3 } });

test('classifyAddress: loopback, metadata, privados e formas IPv6', () => {
  assert.equal(A.classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(A.classifyAddress('169.254.169.254'), 'linklocal');
  assert.equal(A.classifyAddress('10.1.2.3'), 'private');
  assert.equal(A.classifyAddress('192.168.0.9'), 'private');
  assert.equal(A.classifyAddress('8.8.8.8'), 'public');
  assert.equal(A.classifyAddress('::1'), 'loopback');
  assert.equal(A.classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(A.classifyAddress('::ffff:7f00:1'), 'loopback');
  assert.equal(A.classifyAddress('fe80::1'), 'linklocal');
  assert.equal(A.classifyAddress('fd00:ec2::254'), 'metadata');
  assert.equal(A.classifyAddress('fc00::1'), 'private');
  assert.equal(A.classifyAddress('2606:4700::1111'), 'public');
  assert.equal(A.classifyAddress('0.0.0.0'), 'unspecified');
});

test('parseDestination: esquema, userinfo, fragmento, lista de hosts, loopback e http', () => {
  const ok = { allowedHosts: ['ntfy.example.org', '127.0.0.1', '10.0.0.5', '169.254.169.254'] };
  assert.equal(A.parseDestination(SECRET_URL, ok).ok, true);
  for (const bad of ['ftp://ntfy.example.org/x', 'https://u:p@ntfy.example.org/x', 'https://ntfy.example.org/x#f', 'nao-url', '', 'https://outro.example.org/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'http://ntfy.example.org/x', 'https://0x7f.1/x', 'https://10.0.0.5/x']) {
    assert.equal(A.parseDestination(bad, ok).ok, false, bad);
  }
  assert.equal(A.parseDestination('http://10.0.0.5:8080/t', { ...ok, allowPrivate: true }).ok, true);
  assert.equal(A.parseDestination('https://127.0.0.1/x', { ...ok, allowPrivate: true }).ok, false);
});

// ---- transporte real contra servidor local (loopback só com a opção de teste)
function server(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }); handler(req, res, hits); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port }));
  });
}
const fakeLookup = (addrs) => (host, opts, cb) => cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

test('transporte: envia POST sem cookies, com bearer, e devolve o status', async () => {
  const { srv, hits, port } = await server((req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    const send = A.createTransport({ lookup: fakeLookup(['127.0.0.1']), unsafeAllowLoopback: true });
    const r = await send({ url: new URL(`http://ntfy.test:${port}/t/abc`), headers: { 'Content-Type': 'text/plain', Authorization: 'Bearer x' }, body: 'oi', allowPrivate: true });
    assert.equal(r.status, 200);
    assert.equal(hits[0].url, '/t/abc');
    assert.equal(hits[0].body, 'oi');
    assert.equal(hits[0].headers.cookie, undefined);
    assert.equal(hits[0].headers.authorization, 'Bearer x');
  } finally { srv.close(); }
});

test('transporte: não segue redirecionamento', async () => {
  const alvo = await server((req, res) => { res.writeHead(200); res.end(); });
  const orig = await server((req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${alvo.port}/pego` }); res.end(); });
  try {
    const send = A.createTransport({ lookup: fakeLookup(['127.0.0.1']), unsafeAllowLoopback: true });
    await assert.rejects(send({ url: new URL(`http://ntfy.test:${orig.port}/x`), headers: {}, body: 'x', allowPrivate: true }), (e) => e.code === 'redirect' && !e.retryable);
    assert.equal(alvo.hits.length, 0);
  } finally { orig.srv.close(); alvo.srv.close(); }
});

test('transporte: 500 e 429 são repetíveis (Retry-After), 401 não; timeout e resposta grande', async () => {
  const { srv, port } = await server((req, res) => {
    if (req.url === '/500') { res.writeHead(500); return res.end(); }
    if (req.url === '/429') { res.writeHead(429, { 'Retry-After': '120' }); return res.end(); }
    if (req.url === '/401') { res.writeHead(401); return res.end('segredo-do-destino'); }
    if (req.url === '/big') { res.writeHead(200); return res.end('x'.repeat(1_000_000)); }
    return undefined; // /hang: nunca responde
  });
  try {
    const send = A.createTransport({ lookup: fakeLookup(['127.0.0.1']), unsafeAllowLoopback: true, timeoutMs: 300 });
    const go = (p) => send({ url: new URL(`http://ntfy.test:${port}${p}`), headers: {}, body: 'x', allowPrivate: true });
    await assert.rejects(go('/500'), (e) => e.code === 'http_5xx' && e.retryable);
    await assert.rejects(go('/429'), (e) => e.retryable && e.retryAfterMs === 120_000);
    await assert.rejects(go('/401'), (e) => e.code === 'http_4xx' && !e.retryable && !e.message.includes('segredo'));
    assert.equal((await go('/big')).status, 200);
    await assert.rejects(go('/hang'), (e) => e.code === 'timeout' && e.retryable);
  } finally { srv.close(); }
});

test('transporte: bloqueia nome que resolve para loopback/link-local/privado e DNS misto (rebinding)', async () => {
  const url = new URL('https://ntfy.example.org/t');
  for (const [addrs, allowPrivate] of [[['127.0.0.1'], true], [['169.254.169.254'], true], [['10.0.0.8'], false], [['93.184.216.34', '127.0.0.1'], false], [['::1'], true]]) {
    const send = A.createTransport({ lookup: fakeLookup(addrs) });
    await assert.rejects(send({ url, headers: {}, body: 'x', allowPrivate }), (e) => e.code === 'blocked', addrs.join());
  }
  // literal e o próprio aplicativo (porta e endereço locais)
  await assert.rejects(A.createTransport({}) ({ url: new URL('https://127.0.0.1/t'), headers: {}, body: 'x', allowPrivate: true }), (e) => e.code === 'blocked');
  const own = A.createTransport({ lookup: fakeLookup(['192.168.1.50']), ownPorts: [7010], addresses: () => new Set(['192.168.1.50']) });
  await assert.rejects(own({ url: new URL('http://nas.lan:7010/x'), headers: {}, body: 'x', allowPrivate: true }), (e) => e.code === 'blocked');
});

// ---- gerente
test('payload JSON só tem os campos permitidos e nada de dados do usuário', async () => {
  const { mgr, sent } = setup();
  const titles = [{ infoHash: 'a'.repeat(40), name: 'Filme Secreto', state: 'seeding', risk: 'crit', daysLeft: 0.5, tracker: { satisfied: false, hitAndRun: false } }];
  mgr.observeSnapshot(snap({ titles }));
  await mgr.pump();
  assert.equal(sent.length, 1);
  const doc = sent[0].parsed;
  assert.deepEqual(Object.keys(doc).sort(), [...A.CAMPOS_JSON].sort());
  assert.equal(doc.type, 'hnr_deadline');
  assert.equal(doc.severity, 'critical');
  assert.equal(doc.count, 1);
  const raw = sent[0].body;
  for (const proibido of ['Filme Secreto', 'a'.repeat(40), 'passkey', 'cookie', 'ratio', '/home', SECRET_URL, 'bearer-muito']) assert.ok(!raw.includes(proibido), proibido);
  assert.equal(sent[0].headers.Authorization, 'Bearer bearer-muito-secreto');
  assert.equal(sent[0].headers.Cookie, undefined);
});

test('format=text envia só a mensagem em text/plain', async () => {
  const { mgr, sent } = setup({ format: 'text' });
  mgr.observeSnapshot(diskLow());
  await mgr.pump();
  assert.equal(sent[0].headers['Content-Type'].split(';')[0], 'text/plain');
  assert.match(sent[0].body, /espaço livre/);
  assert.ok(!sent[0].body.includes('{'));
});

test('deduplicação, lembrete após o cooldown, recuperação única e histerese do disco', async () => {
  const { mgr, sent, clock } = setup();
  for (let i = 0; i < 5; i += 1) { mgr.observeSnapshot(diskLow()); await mgr.pump(); clock.t += MIN; }
  assert.equal(sent.length, 1, 'repetição no mesmo estado não reenvia');
  clock.t += 60 * MIN;
  mgr.observeSnapshot(diskLow()); await mgr.pump();
  assert.equal(sent.length, 2, 'lembrete depois do cooldown');
  // dentro da histerese (limite 10 GiB + 1 GiB): continua aberto
  const perto = snap({ summary: { freeBytes: 10.5 * 1024 ** 3 } });
  clock.t += MIN; mgr.observeSnapshot(perto); await mgr.pump();
  clock.t += 10 * MIN; mgr.observeSnapshot(perto); await mgr.pump();
  assert.equal(sent.length, 2);
  // normalizado e sustentado por 5 min
  mgr.observeSnapshot(snap()); await mgr.pump();
  assert.equal(sent.length, 2, 'ainda não sustentou');
  clock.t += 6 * MIN; mgr.observeSnapshot(snap()); await mgr.pump();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].parsed.state, 'resolved');
  clock.t += 10 * MIN; mgr.observeSnapshot(snap()); await mgr.pump();
  assert.equal(sent.length, 3, 'resolvido uma vez só');
});

test('reinício não reenvia avisos já entregues e envia a recuperação pendente', async () => {
  const a = setup();
  a.mgr.observeSnapshot(diskLow()); await a.mgr.pump();
  assert.equal(a.sent.length, 1);
  const sent2 = [];
  const mgr2 = new A.AlertManager({
    dataDir: a.dataDir, env: {}, config: BASE, transport: async (r) => { sent2.push(r); return { status: 200 }; },
    now: () => a.clock.t + 5 * MIN, timers: false,
  });
  mgr2.observeSnapshot(diskLow()); await mgr2.pump();
  assert.equal(sent2.length, 0, 'sem tempestade após reiniciar');
  mgr2.observeSnapshot(snap()); await mgr2.pump();
  assert.equal(sent2.length, 0, 'recuperação sustentada ainda não');
});

test('tracker indisponível só alerta após o período sustentado e recupera com observação explícita', async () => {
  const { mgr, sent, clock } = setup();
  mgr.trackerResult(false);
  clock.t += 10 * MIN; mgr.observeSnapshot(snap()); await mgr.pump();
  assert.equal(sent.length, 0);
  mgr.trackerResult(true); clock.t += MIN; mgr.observeSnapshot(snap()); await mgr.pump();
  mgr.trackerResult(false); clock.t += MIN; mgr.observeSnapshot(snap());
  clock.t += 16 * MIN; mgr.observeSnapshot(snap()); await mgr.pump();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parsed.type, 'tracker_unavailable');
  mgr.trackerResult(true); clock.t += MIN; mgr.observeSnapshot(snap()); await mgr.pump();
  assert.equal(sent.at(-1).parsed.state, 'resolved');
});

test('download sem peers só conta em conclusão ativa e sem progresso', async () => {
  const { mgr, sent, clock } = setup();
  const seed = snap({ titles: [{ state: 'seeding', active: true, progress: 1, peers: 0, downSpeed: 0 }] });
  mgr.observeSnapshot(seed); clock.t += 20 * MIN; mgr.observeSnapshot(seed); await mgr.pump();
  assert.equal(sent.length, 0);
  const parado = snap({ titles: [{ state: 'completing', active: true, progress: 0.4, peers: 0, downSpeed: 0 }] });
  mgr.observeSnapshot(parado); clock.t += 16 * MIN; mgr.observeSnapshot(parado); await mgr.pump();
  assert.equal(sent[0].parsed.type, 'download_no_peers');
});

test('falha do destino: retentativas 30 s, 2 min, 10 min com Retry-After, depois desiste sem lançar', async () => {
  const { mgr, behavior, clock, logger } = setup();
  behavior.fail = new A.AlertSendError('http_5xx', { retryable: true, status: 503 });
  mgr.observeSnapshot(diskLow());
  await mgr.pump();
  assert.equal(mgr.queue[0].attempts, 1);
  assert.equal(mgr.queue[0].nextAt - clock.t, 30_000);
  clock.t += 30_000; await mgr.pump();
  assert.equal(mgr.queue[0].nextAt - clock.t, 120_000);
  behavior.fail = new A.AlertSendError('http_retry', { retryable: true, retryAfterMs: 400_000, status: 429 });
  clock.t += 120_000; await mgr.pump();
  assert.equal(mgr.queue[0].nextAt - clock.t, 600_000);
  clock.t += 600_000; await mgr.pump();
  assert.equal(mgr.queue.length, 0, 'desistiu depois de 3 retentativas');
  const st = mgr.status();
  assert.match(st.lastError, /HTTP 503|erro|tarde/);
  assert.ok(st.lastFailureAt);
  // backoff do condicional: dobra o cooldown após falha final
  assert.equal(mgr.cooldownMs(), 2 * 60 * MIN);
  assert.ok(!JSON.stringify(logger.entries).includes('topico-super-secreto'));
});

test('erro 4xx não é repetido e a falha nunca lança', async () => {
  const { mgr, behavior } = setup();
  behavior.fail = new A.AlertSendError('http_4xx', { status: 401 });
  mgr.observeSnapshot(diskLow());
  await assert.doesNotReject(mgr.pump());
  assert.equal(mgr.queue.length, 0);
  assert.equal(mgr.status().lastError, 'o destino rejeitou a mensagem (HTTP 401)');
});

test('trocar ou remover o destino cancela o que estava pendente', async () => {
  const { mgr, behavior, sent, clock } = setup();
  behavior.fail = new A.AlertSendError('network', { retryable: true });
  mgr.observeSnapshot(diskLow()); await mgr.pump();
  assert.equal(mgr.queue.length, 1);
  // troca no arquivo por fora (outro processo/CLI): o item guarda o id do destino antigo
  A.saveDestination(mgr.dataDir, { url: 'https://ntfy.example.org/outro-topico-999999' });
  behavior.fail = null; clock.t += 30_000; await mgr.pump();
  assert.equal(mgr.queue.length, 0);
  assert.equal(sent.length, 0);
  mgr.setConfig({ ALERTS_ENABLED: false });
  assert.equal(mgr.removeDestination().ok, true);
  assert.equal(mgr.status().configured, false);
});

test('fila limitada e coalescida; overflow vira aviso local', () => {
  const { mgr } = setup();
  for (let i = 0; i < 300; i += 1) mgr.enqueue({ type: 'disk_low', state: 'open', severity: 'warning' });
  assert.equal(mgr.queue.length, 1, 'mesmo tipo é coalescido');
  mgr.queue = Array.from({ length: A.MAX_QUEUE }, (_, i) => ({ type: 'download_no_peers', state: 'resolved', eventId: String(i), nextAt: 0, attempts: 0 }));
  mgr.enqueue({ type: 'hnr_deadline', state: 'open', severity: 'warning', count: 1 });
  assert.equal(mgr.queue.length, A.MAX_QUEUE);
  assert.ok(mgr.dropped >= 1);
});

test('teste: exige habilitado e destino, limita a 1/min e não aceita conteúdo livre', async () => {
  const { mgr, sent, clock } = setup();
  const r1 = await mgr.test();
  assert.equal(r1.ok, true);
  assert.equal(sent[0].parsed.state, 'test');
  const r2 = await mgr.test();
  assert.equal(r2.status, 429);
  assert.ok(r2.retryAfter > 0);
  clock.t += 61_000;
  assert.equal((await mgr.test()).ok, true);
  mgr.setConfig({ ALERTS_ENABLED: false });
  assert.equal((await mgr.test()).status, 409);
});

test('segredos: arquivo 0600, estado/status/erros e logs sem a URL ou o token', async () => {
  const { mgr, dataDir, logger } = setup();
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, A.DEST_FILE)).mode & 0o777, 0o600);
  mgr.observeSnapshot(diskLow());
  mgr.transport = async () => { throw Object.assign(new Error(`falha em ${SECRET_URL} bearer-muito-secreto`), { code: 'ECONNRESET' }); };
  await mgr.pump();
  await mgr.test();
  const tudo = JSON.stringify([mgr.status(), logger.entries, fs.readFileSync(path.join(dataDir, A.STATE_FILE), 'utf8')]);
  for (const s of ['topico-super-secreto', 'bearer-muito-secreto', 'ntfy.example.org/topico']) assert.ok(!tudo.includes(s), s);
  // texto livre que cite a URL é redigido pelo logger
  assert.ok(!logger.redact(`erro em ${SECRET_URL}?x=1 e /topico-super-secreto-123456`).includes('topico-super-secreto'));
  assert.equal(mgr.status().host, 'ntfy.example.org');
});

test('destino do ambiente prevalece e não é sobrescrito; URL fora da lista é recusada', () => {
  const dataDir = tmpdir('alerts-env-');
  const mgr = new A.AlertManager({ dataDir, env: { ALERT_WEBHOOK_URL: SECRET_URL }, config: BASE, timers: false });
  assert.equal(mgr.destination().valid, true);
  assert.equal(mgr.setDestination({ url: SECRET_URL }).status, 409);
  const m2 = new A.AlertManager({ dataDir, env: {}, config: BASE, timers: false });
  assert.equal(m2.setDestination({ url: 'https://evil.example.com/x' }).status, 422);
  assert.equal(m2.setDestination({ url: 'http://127.0.0.1/x' }).ok, false);
  assert.equal(fs.existsSync(path.join(dataDir, A.DEST_FILE)), false);
});

test('configProblem recusa habilitar sem hosts ou sem destino; settings.resolve também', () => {
  const dataDir = tmpdir('alerts-cfg-');
  const mgr = new A.AlertManager({ dataDir, env: {}, config: { ...BASE, allowedHosts: [] }, timers: false });
  assert.match(mgr.configProblem(), /ALERT_WEBHOOK_ALLOWED_HOSTS/);
  const m2 = new A.AlertManager({ dataDir, env: {}, config: BASE, timers: false });
  assert.match(m2.configProblem(), /destino/i);
  const snapOff = settings.resolve({ dataDir, env: {} });
  assert.equal(snapOff.ok, true);
  const snapOn = settings.resolve({ dataDir, env: { ALERTS_ENABLED: 'true' } });
  assert.equal(snapOn.ok, false);
  const snapOk = settings.resolve({ dataDir, env: { ALERTS_ENABLED: 'true', ALERT_WEBHOOK_ALLOWED_HOSTS: 'ntfy.example.org', ALERT_WEBHOOK_URL: SECRET_URL } });
  assert.equal(snapOk.ok, true, snapOk.problems.join());
  // a URL é segredo: não pode ir ao settings.json
  assert.throws(() => settings.update({ dataDir, env: {}, changes: { ALERT_WEBHOOK_URL: SECRET_URL }, expectedRevision: 0 }), /segredos nunca/);
});

test('disco desconhecido mantém o alerta aberto; abertura pendente obsoleta é cancelada; remover exige desabilitar', async () => {
  const { mgr, sent, clock, behavior } = setup();
  mgr.observeSnapshot(diskLow()); await mgr.pump();
  assert.equal(sent.length, 1);
  const desconhecido = snap({ summary: { freeBytes: null } });
  for (let i = 0; i < 4; i += 1) { clock.t += 3 * MIN; mgr.observeSnapshot(desconhecido); await mgr.pump(); }
  assert.equal(sent.length, 1, 'sem leitura válida não há recuperação');

  const b = setup();
  b.behavior.fail = new A.AlertSendError('network', { retryable: true });
  b.mgr.observeSnapshot(diskLow()); await b.mgr.pump();
  assert.equal(b.mgr.queue.length, 1);
  b.mgr.observeSnapshot(snap());
  assert.equal(b.mgr.queue.length, 0, 'aviso obsoleto cancelado');
  b.behavior.fail = null; b.clock.t += 60 * MIN; await b.mgr.pump();
  assert.equal(b.sent.length, 0);

  assert.equal(mgr.removeDestination().status, 409);
  mgr.setConfig({ ALERTS_ENABLED: false });
  assert.equal(mgr.removeDestination().ok, true);
  void behavior;
});
