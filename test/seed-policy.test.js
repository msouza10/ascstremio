// Regra 13.1 do ASC: "Depois de CONCLUIR um download, semeie por 72 horas ou
// até chegar a ratio 1.0 no torrent, o que vier primeiro."
// Regra 13.2: vale para downloads concluídos.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { tmpdir } = require('./tmp-helper');

const tmpFile = () => path.join(tmpdir('vault-'), 'vault.json');
const HASH = 'a'.repeat(40);
const LOCAL = { remoteAddress: '127.0.0.1' };
const ADMIN_KEY = 'cd'.repeat(16);
const ADMIN = { 'x-admin-token': ADMIN_KEY };

function bridgeCom(vault) {
  return new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', port: 7098, vault, adminKey: ADMIN_KEY });
}

const torrent = (over = {}) => ({ infoHash: HASH, uploaded: 0, downloaded: 0, ...over });

test('streaming parcial não cria obrigação (13.1 exige conclusão)', () => {
  const vault = new SeedVault({ file: tmpFile() });
  const b = bridgeCom(vault);
  vault.markSeen(HASH, { name: 'teste' });
  const s = b.seedState(torrent({ downloaded: 6 * 1024 * 1024 }));
  assert.equal(s.concluded, false);
  assert.equal(s.obligation, false);
  assert.equal(s.met, true);
});

test('download concluído abre 72 h de obrigação', () => {
  const vault = new SeedVault({ file: tmpFile() });
  const b = bridgeCom(vault);
  vault.markSeen(HASH, { name: 'teste' });
  vault.markCompleted(HASH);
  const s = b.seedState(torrent({ downloaded: 1000, uploaded: 0 }));
  assert.equal(s.concluded, true);
  assert.equal(s.obligation, true);
  assert.equal(s.met, false);
  assert.equal(s.missingHours, 72);
});

test('tempo de seed acumulado satisfaz a obrigação', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  vault.markCompleted(HASH);
  vault.addSeedingTime(HASH, 40 * 3600 * 1000);
  let s = bridgeCom(vault).seedState(torrent({ downloaded: 1000 }));
  assert.equal(s.met, false);
  assert.equal(s.missingHours, 32);

  vault.addSeedingTime(HASH, 32 * 3600 * 1000);
  s = bridgeCom(vault).seedState(torrent({ downloaded: 1000 }));
  assert.equal(s.met, true);
  assert.equal(s.obligation, false);
});

test('tempo de seed não conta antes de concluir', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  vault.addSeedingTime(HASH, 10 * 3600 * 1000);
  assert.equal(vault.get(HASH).seedMs, 0);
});

test('ratio 1.0 no torrent cumpre antes das 72 h', () => {
  const vault = new SeedVault({ file: tmpFile() });
  const b = bridgeCom(vault);
  vault.markSeen(HASH, {});
  vault.markCompleted(HASH);
  const s = b.seedState(torrent({ downloaded: 1000, uploaded: 1000 }));
  assert.equal(s.ratioMet, true);
  assert.equal(s.met, true);
});

test('contagem sobrevive a reinício do processo', () => {
  const file = tmpFile();
  const primeiro = new SeedVault({ file });
  primeiro.markSeen(HASH, { name: 'teste' });
  primeiro.markCompleted(HASH);
  primeiro.addSeedingTime(HASH, 50 * 3600 * 1000);

  const segundo = new SeedVault({ file }); // simula `npm start` de novo
  assert.equal(segundo.get(HASH).seedMs, 50 * 3600 * 1000);
  assert.equal(segundo.needsSeed(HASH), true);
});

test('prazo de 12 dias da regra 13.3 é calculado do último contato', () => {
  const now = 1_700_000_000_000;
  const vault = new SeedVault({ file: tmpFile(), now: () => now });
  vault.markSeen(HASH, {});
  const deadline = vault.deadlineMs(HASH);
  assert.equal(deadline - now, 12 * 86400000);
});

test('cleanup recusa encerrar torrent com obrigação pendente', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  vault.markCompleted(HASH);
  const b = bridgeCom(vault);
  b.client = {
    torrents: [{ ...torrent({ downloaded: 500 }), destroy: () => { throw new Error('não devia destruir'); } }],
  };

  const res = { status: 0, body: null, setHeader() {}, writeHead(s) { this.status = s; }, end(p) { this.body = p; } };
  await b.handle({ method: 'POST', url: `/cleanup?hash=${HASH}`, headers: ADMIN, socket: LOCAL }, res);

  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).blocked.length, 1);
});

test('cleanup libera torrent que já cumpriu', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  vault.markCompleted(HASH);
  vault.addSeedingTime(HASH, 72 * 3600 * 1000);
  const b = bridgeCom(vault);
  let destruiu = false;
  b.client = { torrents: [{ ...torrent(), destroy: (opts, cb) => { destruiu = true; cb(); } }] };

  const res = { status: 0, body: null, setHeader() {}, writeHead(s) { this.status = s; }, end(p) { this.body = p; } };
  await b.handle({ method: 'POST', url: '/cleanup', headers: ADMIN, socket: LOCAL }, res);

  assert.equal(res.status, 200);
  assert.equal(destruiu, true);
});

test('HEAD responde pelos metadados locais, sem abrir o torrent', async () => {
  const b = bridgeCom(new SeedVault({ file: tmpFile() }));
  b.entries.set(HASH, {
    infoHash: HASH,
    files: [{ index: 0, path: 'Filme.mkv', length: 123456, isVideo: true }],
  });
  let abriu = false;
  b.client = { torrents: [], add: () => { abriu = true; throw new Error('não deveria anunciar'); } };

  const res = {
    status: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); },
    end() {},
  };
  const { CredentialStore } = require('../src/credentials');
  b.credentials = new CredentialStore({ file: path.join(tmpdir('head-cred-'), 'credentials.json') });
  const { token } = b.credentials.create({ name: 'teste' });
  await b.handle({ method: 'HEAD', url: `/s/${HASH}/0?k=${token}`, headers: {}, socket: LOCAL }, res);

  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Length'], '123456');
  assert.equal(res.headers['Content-Type'], 'video/x-matroska');
  assert.equal(abriu, false, 'HEAD não pode criar snatch');
});

test('rotas administrativas exigem o token, e endereço privado não basta', async () => {
  const destruidos = [];
  const b = bridgeCom(new SeedVault({ file: tmpFile() }));
  b.client = { torrents: [{ infoHash: HASH, destroy: (_o, cb) => { destruidos.push(HASH); cb(); } }] };
  const tentar = async (req) => {
    const res = { status: 0, setHeader() {}, writeHead(s) { this.status = s; }, end() {} };
    await b.handle(req, res);
    return res.status;
  };
  const lan = { remoteAddress: '192.168.0.20' };
  const rotas = [['POST', '/cleanup?force=1'], ['POST', '/cleanup'], ['POST', `/complete?hash=${HASH}`], ['GET', '/seed-status'], ['GET', '/status']];
  for (const container of [false, true]) {
    if (container) process.env.ASCSTREMIO_CONTAINER = '1';
    try {
      for (const [method, url] of rotas) {
        const errado = { 'x-admin-token': 'ef'.repeat(16) };
        assert.equal(await tentar({ method, url, headers: {}, socket: LOCAL }), 403, `${method} ${url} sem token`);
        assert.equal(await tentar({ method, url, headers: errado, socket: LOCAL }), 403, `${method} ${url} token errado`);
        assert.equal(await tentar({ method, url, headers: { 'x-admin-token': 'curto' }, socket: LOCAL }), 403);
        assert.equal(await tentar({ method, url, headers: {}, socket: lan }), 403, `${method} ${url} LAN sem token`);
        assert.equal(await tentar({ method, url, headers: { ...ADMIN, origin: 'https://exemplo.org' }, socket: LOCAL }), 403, 'Origin bloqueia mesmo com token');
        assert.equal(await tentar({ method, url, headers: {} }), 403, 'sem socket');
      }
    } finally {
      delete process.env.ASCSTREMIO_CONTAINER;
    }
  }
  assert.deepEqual(destruidos, [], 'recusa nunca destrói torrent');
  // A chave de streaming (?k=) não administra.
  assert.equal(await tentar({ method: 'GET', url: `/seed-status?k=${ADMIN_KEY}`, headers: {}, socket: LOCAL }), 403);
  // Nativo: token + loopback (IPv4, IPv6 e mapeado). LAN com token correto segue recusada.
  assert.equal(await tentar({ method: 'GET', url: '/seed-status', headers: ADMIN, socket: LOCAL }), 200);
  assert.equal(await tentar({ method: 'GET', url: '/seed-status', headers: ADMIN, socket: { remoteAddress: '::ffff:127.0.0.1' } }), 200);
  assert.equal(await tentar({ method: 'GET', url: '/seed-status', headers: ADMIN, socket: { remoteAddress: '::1' } }), 200);
  assert.equal(await tentar({ method: 'GET', url: '/seed-status', headers: ADMIN, socket: lan }), 403);
  // Contêiner: o endereço é o do gateway/outro contêiner, então vale só o token.
  process.env.ASCSTREMIO_CONTAINER = '1';
  try {
    assert.equal(await tentar({ method: 'GET', url: '/seed-status', headers: ADMIN, socket: { remoteAddress: '172.18.0.1' } }), 200);
    assert.equal(await tentar({ method: 'GET', url: '/seed-status', headers: {}, socket: { remoteAddress: '172.18.0.5' } }), 403);
  } finally {
    delete process.env.ASCSTREMIO_CONTAINER;
  }
});

test('ponte sem token administrativo configurado recusa as rotas administrativas', async () => {
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', port: 7098, vault: new SeedVault({ file: tmpFile() }) });
  b.client = { torrents: [] };
  const res = { status: 0, setHeader() {}, writeHead(s) { this.status = s; }, end() {} };
  await b.handle({ method: 'GET', url: '/seed-status', headers: {}, socket: LOCAL }, res);
  assert.equal(res.status, 403);
});

test('cleanup ignora force=1: sem o tracker confirmar, nada é destruído', async () => {
  const b = bridgeCom(new SeedVault({ file: tmpFile() }));
  b.client = { torrents: [{ infoHash: HASH, name: 'x', ready: true, done: true, length: 10, downloaded: 10, uploaded: 0, destroy: () => { throw new Error('não devia destruir'); } }] };
  const res = { status: 0, setHeader() {}, writeHead(s) { this.status = s; }, end() {} };
  await b.handle({ method: 'POST', url: '/cleanup?force=1', headers: ADMIN, socket: LOCAL }, res);
  assert.equal(res.status, 409);
});

test('/seed-status inclui avisos da conta', async () => {
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', vault: new SeedVault({ file: tmpFile() }), adminKey: ADMIN_KEY,
    accountNotice: () => 'entre no site' });
  b.client = { torrents: [] };
  const res = { body: null, setHeader() {}, writeHead() {}, end(p) { this.body = p; } };
  await b.handle({ method: 'GET', url: '/seed-status', headers: ADMIN, socket: LOCAL }, res);
  assert.deepEqual(JSON.parse(res.body).avisos, ['entre no site']);
});

// --- Anti-HnR: o tracker (myHistory) vence a estimativa local ---
const hnr = require('../src/hnr-guard');
const ID_PATH = '/x/asc-123.torrent';
const DIA = 86_400_000;

test('normalizeHistory aceita ISO/epoch e reconhece cumprimento, HnR e perdão', () => {
  assert.equal(hnr.normalizeHistory(null), null);
  const aberto = hnr.normalizeHistory({ status: 'seeding', completedAt: '2026-11-01T00:00:00Z',
    remainingSeedTime: 3600, deadline: 1_800_000_000, hitAndRunAt: null });
  assert.equal(aberto.satisfied, false);
  assert.equal(aberto.remainingMs, 3_600_000);
  assert.equal(aberto.deadlineMs, 1_800_000_000_000);
  const ok = hnr.normalizeHistory({ completedAt: '2026-11-01T00:00:00Z', remainingSeedTime: 0 });
  assert.equal(ok.satisfied, true);
  assert.equal(hnr.normalizeHistory({ remainingSeedTime: 0 }).satisfied, false, 'sem conclusão não cumpre');
  assert.equal(hnr.normalizeHistory({ hitAndRunAt: '2026-11-02T00:00:00Z' }).hitAndRun, true);
  assert.equal(hnr.normalizeHistory({ hitAndRunAt: '2026-11-02T00:00:00Z', forgivenAt: '2026-11-03T00:00:00Z' }).hitAndRun, false);
});

test('tempo local de 72 h não cumpre sozinho um torrent conferido no tracker', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, { torrentPath: ID_PATH });
  vault.markCompleted(HASH);
  vault.setTracker(HASH, hnr.normalizeHistory({ completedAt: '2026-11-01T00:00:00Z', remainingSeedTime: 5 * 3600 }));
  vault.addSeedingTime(HASH, 80 * 3600 * 1000);
  const s = bridgeCom(vault).seedState(torrent({ downloaded: 1000 }));
  assert.equal(s.met, false);
  assert.equal(s.awaitingTracker, true);

  vault.setTracker(HASH, hnr.normalizeHistory({ completedAt: '2026-11-01T00:00:00Z', remainingSeedTime: 0 }));
  assert.equal(bridgeCom(vault).seedState(torrent({ downloaded: 1000 })).met, true);
});

test('tracker reabre obrigação que o cofre local julgava cumprida', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, { torrentPath: ID_PATH });
  vault.markCompleted(HASH);
  vault.addSeedingTime(HASH, 72 * 3600 * 1000);
  assert.ok(vault.get(HASH).satisfiedAt);
  vault.setTracker(HASH, hnr.normalizeHistory({ completedAt: '2026-11-01T00:00:00Z', remainingSeedTime: 20 * 3600 }));
  assert.equal(vault.get(HASH).satisfiedAt, null);
  assert.equal(vault.remainingMs(HASH), 20 * 3600 * 1000);
});

test('conclusão revelada pelo tracker cria a obrigação (outra sessão/cliente)', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, { torrentPath: ID_PATH });
  assert.equal(vault.needsSeed(HASH), false);
  vault.setTracker(HASH, hnr.normalizeHistory({ completedAt: '2026-11-01T00:00:00Z', remainingSeedTime: 72 * 3600 }));
  assert.equal(vault.needsSeed(HASH), true);
});

test('reconcile usa o id do arquivo, ignora o resto e para na primeira falha', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, { torrentPath: ID_PATH });
  vault.markSeen('b'.repeat(40), { torrentPath: '/x/Outro.torrent' });
  const pedidos = [];
  const asc = { history: async (id) => { pedidos.push(id); return { history: { completedAt: '2026-11-01T00:00:00Z', remainingSeedTime: 0 }, freeleech: true }; } };
  const r = await hnr.reconcile({ asc, vault });
  assert.deepEqual(pedidos, ['123']);
  assert.equal(r.checked, 1);
  assert.equal(vault.get(HASH).satisfiedAt !== null, true);
  // já confirmado: não consulta de novo
  await hnr.reconcile({ asc, vault });
  assert.equal(pedidos.length, 1);

  const v2 = new SeedVault({ file: tmpFile() });
  v2.markSeen(HASH, { torrentPath: ID_PATH });
  const r2 = await hnr.reconcile({ asc: { history: async () => { throw new Error('sessão'); } }, vault: v2 });
  assert.equal(r2.failed, 1);
});

test('avisos: inativo com pendência, prazo curto, vencido, HnR registrado', () => {
  const now = 1_800_000_000_000;
  const vault = new SeedVault({ file: tmpFile(), now: () => now });
  vault.markSeen(HASH, { name: 'Filme', torrentPath: ID_PATH });
  vault.markCompleted(HASH);
  vault.setTracker(HASH, hnr.normalizeHistory({ completedAt: now / 1000, remainingSeedTime: 10 * 3600, deadline: (now + 2 * DIA) / 1000 }));

  const inativo = hnr.warnings({ vault, active: new Set(), now });
  assert.ok(inativo.some((w) => /NÃO está ativo/.test(w)));
  const ativo = hnr.warnings({ vault, active: new Set([HASH]), now });
  assert.ok(ativo.some((w) => /prazo em 2\.0 dia/.test(w)));
  const vencido = hnr.warnings({ vault, active: new Set([HASH]), now: now + 3 * DIA });
  assert.ok(vencido.some((w) => /vencido/.test(w)));

  vault.setTracker(HASH, hnr.normalizeHistory({ completedAt: now / 1000, remainingSeedTime: 10 * 3600, hitAndRunAt: now / 1000 }));
  assert.ok(hnr.warnings({ vault, active: new Set([HASH]), now }).some((w) => /reincidência/.test(w)));
});

test('cleanup consulta o tracker antes e não libera se ele diz que falta seed', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, { torrentPath: ID_PATH });
  vault.markCompleted(HASH);
  vault.addSeedingTime(HASH, 72 * 3600 * 1000); // local acha que cumpriu
  const b = bridgeCom(vault);
  b.trackerCheck = (hashes) => hnr.reconcile({
    asc: { history: async () => ({ history: { completedAt: '2026-11-01T00:00:00Z', remainingSeedTime: 3 * 3600 } }) },
    vault, only: hashes,
  });
  b.client = { torrents: [{ ...torrent({ downloaded: 500 }), destroy: () => { throw new Error('não devia destruir'); } }] };
  const res = { status: 0, body: null, setHeader() {}, writeHead(s) { this.status = s; }, end(p) { this.body = p; } };
  await b.handle({ method: 'POST', url: '/cleanup', headers: ADMIN, socket: LOCAL }, res);
  assert.equal(res.status, 409);
});

test('datas do site sem fuso são UTC, em qualquer fuso da máquina (myHistory real)', () => {
  // Valores reais de myHistory (Resident Evil, 08/11/2026)
  const h = hnr.normalizeHistory({
    status: 'downloading', completedAt: null, seedTime: 0, remainingSeedTime: 259200,
    deadline: '2026-11-20 17:30:25', hitAndRunAt: null, forgivenAt: null,
  });
  assert.equal(h.deadlineMs, Date.UTC(2026, 10, 20, 17, 30, 25));
  assert.equal(h.satisfied, false, 'parcial não conta como cumprido');
  assert.equal(h.hitAndRun, false);
  assert.equal(h.remainingMs, 259_200_000);
});

// --- Conclusão em segundo plano (§4.5) ---
const MIN = 60_000;

function bridgeBg(vault, over = {}) {
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', port: 7098, vault, adminKey: ADMIN_KEY,
    backgroundMode: 'auto', idleMs: 10 * MIN, minFreeBytes: 1000, freeSpace: () => 1e12, ...over });
  const selecoes = [];
  const t = { infoHash: HASH, name: 'Filme', ready: true, done: false, length: 5000, downloaded: 1000,
    pieces: new Array(10), progress: 0.2, select: (...a) => selecoes.push(a) };
  b.client = { torrents: [t] };
  b.entries.set(HASH, { infoHash: HASH, freeleech: true });
  b.startedAt.set(HASH, 0);
  return { b, t, selecoes };
}

test('auto: freeleech parado há mais que o limite é concluído, com prioridade baixa', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  const { b, selecoes } = bridgeBg(vault);
  b.completionTick(11 * MIN);
  assert.deepEqual(selecoes, [[0, 9, 0]]);
  assert.equal(vault.get(HASH).backgroundComplete, true);
  b.completionTick(12 * MIN); // não repete
  assert.equal(selecoes.length, 1);
});

test('auto: não conclui com player assistindo, antes do limite, fora do freeleech ou com modo off', () => {
  const novo = (over, ajuste) => {
    const vault = new SeedVault({ file: tmpFile() });
    vault.markSeen(HASH, {});
    const r = bridgeBg(vault, over);
    ajuste?.(r);
    r.b.completionTick(11 * MIN);
    return r.selecoes.length;
  };
  assert.equal(novo({}, ({ b }) => b.streams.set(HASH, 1)), 0, 'stream aberto');
  assert.equal(novo({}, ({ b }) => b.lastStreamEnd.set(HASH, 5 * MIN)), 0, 'parou há 6 min');
  assert.equal(novo({}, ({ b }) => b.entries.set(HASH, { infoHash: HASH, freeleech: false })), 0, 'não freeleech');
  assert.equal(novo({}, ({ b }) => b.entries.set(HASH, { infoHash: HASH })), 0, 'freeleech desconhecido');
  assert.equal(novo({ backgroundMode: 'off' }), 0, 'modo off');
  assert.equal(novo({}, ({ b }) => b.lastStreamEnd.set(HASH, 0)), 1, 'controle: parado há 11 min');
});

test('espaço em disco insuficiente impede começar a conclusão', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  const { b, selecoes } = bridgeBg(vault, { freeSpace: () => 4000, minFreeBytes: 1000 }); // faltam 4000 + 1000
  const warn = console.warn; console.warn = () => {};
  try { b.completionTick(11 * MIN); } finally { console.warn = warn; }
  assert.equal(selecoes.length, 0);
  assert.equal(vault.get(HASH).backgroundComplete ?? false, false);
});

test('pedido manual conclui mesmo com modo off, e avisa se não for freeleech', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  const { b, t, selecoes } = bridgeBg(vault, { backgroundMode: 'off' });
  b.getTorrent = async () => t;
  b.entries.set(HASH, { infoHash: HASH, freeleech: false });
  const r = await b.requestCompletion(HASH);
  assert.match(r.aviso, /ratio/);
  assert.equal(selecoes.length, 1);
  await assert.rejects(b.requestCompletion('c'.repeat(40)), { status: 404 });
});

test('POST /complete valida o hash e só atende local', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  const { b, t } = bridgeBg(vault);
  b.getTorrent = async () => t;
  vault.markSeen(HASH, {});
  const chamar = async (req) => {
    const res = { status: 0, body: null, setHeader() {}, writeHead(s) { this.status = s; }, end(p) { this.body = p; } };
    await b.handle(req, res);
    return res;
  };
  assert.equal((await chamar({ method: 'POST', url: '/complete', headers: ADMIN, socket: LOCAL })).status, 400);
  assert.equal((await chamar({ method: 'POST', url: `/complete?hash=${HASH}`, headers: {}, socket: { remoteAddress: '10.0.0.5' } })).status, 403);
  const ok = await chamar({ method: 'POST', url: `/complete?hash=${HASH}`, headers: ADMIN, socket: LOCAL });
  assert.equal(ok.status, 202);
  assert.equal(JSON.parse(ok.body).infoHash, HASH);
});

test('concluir o download abre as 72 h e o resumo mostra horas por dia necessárias', () => {
  const now = Date.now();
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  vault.markCompleted(HASH);
  const { b } = bridgeBg(vault);
  const s = b.seedState({ infoHash: HASH, uploaded: 0, downloaded: 1000, progress: 1 });
  assert.equal(s.obligation, true);
  // 72 h para pagar em ~12 dias de prazo: ~6 h por dia
  assert.ok(s.hoursPerDayNeeded > 5.5 && s.hoursPerDayNeeded < 6.5, String(s.hoursPerDayNeeded));
  assert.ok(now > 0);
});

// --- Cumpriu o limite: libera rede e disco, só com o tracker confirmando ---
function bridgeLiberar(afterSeed, trackerOk, over = {}) {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, { name: 'Filme', torrentPath: '/x/asc-5.torrent' });
  vault.markCompleted(HASH);
  vault.addSeedingTime(HASH, 72 * 3600 * 1000);
  if (trackerOk !== null) {
    vault.setTracker(HASH, hnr.normalizeHistory({ completedAt: '2026-11-01 00:00:00', remainingSeedTime: trackerOk ? 0 : 3600 }));
  }
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', vault, afterSeed, adminKey: ADMIN_KEY, ...over });
  const chamadas = [];
  b.client = { torrents: [{ infoHash: HASH, destroy: (opts, cb) => { chamadas.push(opts); cb(); } }] };
  return { b, vault, chamadas };
}
const mudo = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('limite confirmado pelo tracker: encerra e apaga os arquivos (delete)', async () => {
  const { b, vault, chamadas } = bridgeLiberar('delete', true);
  const r = await mudo(() => b.releaseSatisfied());
  assert.equal(r.length, 1);
  assert.deepEqual(chamadas, [{ destroyStore: true }]);
  assert.equal(vault.get(HASH).releasedAs, 'delete');
});

test('limite confirmado: stop encerra mas mantém os arquivos; keep não mexe', async () => {
  const stop = bridgeLiberar('stop', true);
  await mudo(() => stop.b.releaseSatisfied());
  assert.deepEqual(stop.chamadas, [{ destroyStore: false }]);
  const keep = bridgeLiberar('keep', true);
  assert.deepEqual(await keep.b.releaseSatisfied(), []);
  assert.equal(keep.chamadas.length, 0);
});

test('sem confirmação do tracker não libera (nem tempo local de 72 h basta)', async () => {
  for (const tracker of [false, null]) {
    const { b, chamadas } = bridgeLiberar('delete', tracker);
    assert.deepEqual(await b.releaseSatisfied(), [], `tracker=${tracker}`);
    assert.equal(chamadas.length, 0);
  }
});

test('não libera com alguém assistindo', async () => {
  const { b, chamadas } = bridgeLiberar('delete', true);
  b.streams.set(HASH, 1);
  assert.deepEqual(await b.releaseSatisfied(), []);
  assert.equal(chamadas.length, 0);
});

// --- Manter o PC acordado só com seed pendente ---
const { KeepAwake } = require('../src/keepawake');

function falsoSpawn() {
  const filhos = [];
  const impl = (cmd, args) => {
    const f = { cmd, args, mortos: 0, ouvintes: {}, on(ev, fn) { this.ouvintes[ev] = fn; }, kill() { this.mortos++; this.ouvintes.exit?.(); } };
    filhos.push(f);
    return f;
  };
  return { impl, filhos };
}

test('KeepAwake abre um inibidor ao precisar e solta ao terminar, sem duplicar', () => {
  const { impl, filhos } = falsoSpawn();
  const k = new KeepAwake({ spawnImpl: impl, available: () => true, pid: 4242, platform: 'linux', exists: () => true });
  const log = console.log; console.log = () => {};
  try {
    assert.equal(k.update(false), false);
    assert.equal(k.update(true), true);
    assert.equal(k.update(true), true);
    assert.equal(filhos.length, 1, 'não duplica');
    assert.ok(filhos[0].args.includes('--what=sleep') && filhos[0].args.includes('4242'));
    assert.equal(k.update(false), false);
    assert.equal(filhos[0].mortos, 1);
  } finally { console.log = log; }
});

test('KeepAwake desligado ou sem systemd-inhibit não faz nada', () => {
  const { impl, filhos } = falsoSpawn();
  assert.equal(new KeepAwake({ mode: 'off', spawnImpl: impl, available: () => true }).update(true), false);
  assert.equal(new KeepAwake({ spawnImpl: impl, available: () => false }).update(true), false);
  assert.equal(filhos.length, 0);
});

test('needsAwake: seed cobrado ou download em andamento, nunca com tudo cumprido', () => {
  const vault = new SeedVault({ file: tmpFile() });
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', vault });
  vault.markSeen(HASH, {}); vault.markCompleted(HASH);
  b.client = { torrents: [{ infoHash: HASH, done: true }] };
  assert.equal(b.needsAwake(), true, 'seed cobrado');
  vault.addSeedingTime(HASH, 72 * 3600 * 1000);
  assert.equal(b.needsAwake(), false, 'cumprido');
  b.client = { torrents: [{ infoHash: 'b'.repeat(40), done: false }] };
  assert.equal(b.needsAwake(), false, 'só streaming');
  b.completing.add('b'.repeat(40));
  assert.equal(b.needsAwake(), true, 'concluindo em segundo plano');
});

test('reconcile grava no cofre se o release é freeleech, e a ponte prefere esse dado', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, { torrentPath: ID_PATH });
  const asc = { history: async () => ({ history: null, freeleech: true }) };
  await hnr.reconcile({ asc, vault });
  assert.equal(vault.get(HASH).freeleech, true);
  const b = bridgeCom(vault);
  b.entries.set(HASH, { infoHash: HASH, freeleech: false });
  assert.equal(b.isFreeleech(HASH), true, 'tracker vence o palpite da biblioteca');
  assert.equal(b.isFreeleech('c'.repeat(40)), null);
});

test('conclusão em segundo plano não dispara em torrent já completo (progresso 100% antes do evento done)', () => {
  const vault = new SeedVault({ file: tmpFile() });
  vault.markSeen(HASH, {});
  vault.setBackground(HASH, true);
  const { b, t, selecoes } = bridgeBg(vault);
  t.progress = 1; // verificado, mas `done` ainda não emitido
  b.completionTick(11 * MIN);
  assert.equal(selecoes.length, 0);
  assert.equal(b.completing.has(HASH), false);
  t.progress = 0.5;
  b.completionTick(11 * MIN);
  assert.equal(selecoes.length, 1, 'controle: incompleto continua seguindo');
});
