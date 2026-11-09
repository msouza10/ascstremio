const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PlaybackLimiter } = require('../src/play-limit');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const settings = require('../src/settings');
const { tmpdir } = require('./tmp-helper');

const relogio = (t0 = 1_000_000) => { const r = { t: t0, now: () => r.t, avancar(ms) { r.t += ms; } }; return r; };

// ---------------------------------------------------------------- limitador

test('limitador: sem limite configurado nada é recusado', () => {
  const l = new PlaybackLimiter();
  for (let i = 0; i < 50; i++) assert.equal(l.acquire('c_1', `s:${i}`).ok, true);
});

test('limitador: seeks, multi-Range e retentativas da mesma credencial e conteúdo dividem uma vaga', () => {
  const l = new PlaybackLimiter({ maxSessions: 1 });
  const a = l.acquire('c_1', 's:x:0');
  const b = l.acquire('c_1', 's:x:0'); // segundo Range aberto ao mesmo tempo
  assert.equal(a.ok && b.ok, true);
  assert.equal(l.snapshot().active, 1);
  a.lease.release(); b.lease.release();
  assert.equal(l.acquire('c_1', 's:x:0').ok, true, 'reconexão logo depois do seek reaproveita a sessão');
  assert.equal(l.snapshot().active, 1);
});

test('limitador: global e por credencial; clientes distintos não são agrupados', () => {
  const l = new PlaybackLimiter({ maxSessions: 3, maxPerCredential: 2 });
  assert.equal(l.acquire('c_1', 'a').ok, true);
  assert.equal(l.acquire('c_1', 'b').ok, true);
  const porCred = l.acquire('c_1', 'c');
  assert.equal(porCred.ok, false);
  assert.equal(porCred.scope, 'credencial');
  assert.equal(l.acquire('c_2', 'a').ok, true, 'outra credencial tem a sua cota');
  const global = l.acquire('c_3', 'a');
  assert.equal(global.ok, false);
  assert.equal(global.scope, 'global');
  assert.ok(global.retryAfter >= 1);
});

test('limitador: expira depois da janela sem requisições e libera a vaga (relógio simulado)', () => {
  const rel = relogio();
  const l = new PlaybackLimiter({ maxSessions: 1, graceMs: 30_000, now: rel.now });
  const a = l.acquire('c_1', 'a');
  a.lease.release();
  rel.avancar(29_000);
  const recusa = l.acquire('c_2', 'b');
  assert.equal(recusa.ok, false);
  assert.equal(recusa.retryAfter, 1, 'Retry-After aponta o fim da janela da vaga ociosa');
  rel.avancar(1_000);
  assert.equal(l.acquire('c_2', 'b').ok, true);
  assert.equal(l.snapshot().active, 1);
});

test('limitador: resposta aberta mantém a sessão além da janela', () => {
  const rel = relogio();
  const l = new PlaybackLimiter({ maxSessions: 1, graceMs: 5_000, now: rel.now });
  const a = l.acquire('c_1', 'a');
  rel.avancar(60_000);
  assert.equal(l.acquire('c_2', 'b').ok, false, 'filme em curso não expira por estar aberto');
  a.lease.release();
  rel.avancar(5_000);
  assert.equal(l.acquire('c_2', 'b').ok, true);
});

test('limitador: erro não deixa vaga presa e a liberação é idempotente', () => {
  const l = new PlaybackLimiter({ maxSessions: 1 });
  const a = l.acquire('c_1', 'a');
  a.lease.release({ keep: false }); // 504/416/erro
  a.lease.release({ keep: false });
  assert.equal(l.snapshot().active, 0);
  assert.equal(l.acquire('c_2', 'b').ok, true);

  // erro numa requisição extra de uma sessão que já tocou não derruba a sessão
  const l2 = new PlaybackLimiter({ maxSessions: 1 });
  const ok = l2.acquire('c_1', 'a');
  ok.lease.release({ keep: true });
  const ruim = l2.acquire('c_1', 'a');
  ruim.lease.release({ keep: false });
  assert.equal(l2.snapshot().active, 1);
});

test('limitador: revogação libera tudo da credencial e liberações tardias não corrompem', () => {
  const l = new PlaybackLimiter({ maxSessions: 2 });
  const a = l.acquire('c_1', 'a');
  l.acquire('c_2', 'b');
  l.dropCredential('c_1');
  assert.equal(l.snapshot().active, 1);
  assert.equal(l.acquire('c_3', 'c').ok, true);
  a.lease.release(); // resposta derrubada fecha depois
  assert.equal(l.snapshot().active, 2);
});

test('limitador: rekey troca a chave provisória pela do torrent, inclusive com sessão já existente', () => {
  const l = new PlaybackLimiter({ maxSessions: 1 });
  const a = l.acquire('c_1', 'a:7');
  a.lease.rekey('s:h:0');
  assert.equal(l.acquire('c_1', 's:h:0').ok, true, 'o mesmo filme não vira outra TV');
  assert.equal(l.snapshot().active, 1);

  const l2 = new PlaybackLimiter({ maxSessions: 5 });
  const x = l2.acquire('c_1', 's:h:0');
  const y = l2.acquire('c_1', 'a:7');
  y.lease.rekey('s:h:0'); // funde na sessão existente
  assert.equal(l2.snapshot().active, 1);
  x.lease.release(); y.lease.release();
  assert.equal(l2.snapshot().credentials[0].open, 0);
});

test('limitador: concorrência, só o limite passa e tudo volta a zero', async () => {
  const l = new PlaybackLimiter({ maxSessions: 3 });
  const tentativas = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
    await null;
    return l.acquire(`c_${i % 10}`, `k${i}`);
  }));
  const aceitas = tentativas.filter((t) => t.ok);
  assert.equal(aceitas.length, 3);
  aceitas.forEach((t) => t.lease.release({ keep: false }));
  assert.equal(l.snapshot().active, 0);
});

test('limitador: o diagnóstico traz só contagens por credencial', () => {
  const l = new PlaybackLimiter({ maxSessions: 4 });
  l.acquire('c_1', 'segredo-do-titulo');
  const s = l.snapshot();
  assert.deepEqual(Object.keys(s.credentials[0]).sort(), ['credentialId', 'open', 'sessions']);
  assert.ok(!JSON.stringify(s).includes('segredo-do-titulo'));
});

// ------------------------------------------------------------------- ponte

const HASH = 'b'.repeat(40);
const HASH2 = 'c'.repeat(40);
const store = new CredentialStore({ file: path.join(tmpdir('play-cred-'), 'credentials.json') });

function ponte(over = {}) {
  const b = new Bridge({
    torrentDir: tmpdir('play-t-'), storeDir: tmpdir('play-s-'), freeSpace: () => ({ free: 1024 ** 4, total: 1024 ** 4 }), port: 7098, publicUrl: 'http://127.0.0.1:7098', credentials: store,
    vault: new SeedVault({ file: path.join(tmpdir('play-'), 'v.json') }), ...over,
  });
  b.client = { torrents: [] };
  b.entries.set(HASH, { infoHash: HASH, files: [{ index: 0, path: 'f.mkv', length: 100, isVideo: true }] });
  b.entries.set(HASH2, { infoHash: HASH2, files: [{ index: 0, path: 'g.mkv', length: 100, isVideo: true }] });
  return b;
}
function resposta() {
  const r = new EventEmitter();
  Object.assign(r, {
    statusCode: 0, headers: {}, body: '', destroyed: false, headersSent: false, writableFinished: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); this.headersSent = true; },
    write() { return true; },
    end(c) { if (c) this.body += c; this.writableFinished = true; this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); },
  });
  return r;
}
const get = (token, url, method = 'GET') => ({ method, url: `${url}?k=${token}`, headers: { host: '127.0.0.1:7098' }, socket: { remoteAddress: '127.0.0.1' } });

// Torrent que fica "carregando" até liberar: simula o await antes de o stream abrir.
function segurado() {
  let liberar; const p = new Promise((r) => { liberar = r; });
  return { p, liberar };
}

test('ponte: recusa o excesso com 429 e Retry-After antes de resolver, baixar ou abrir torrent', async () => {
  const b = ponte({ maxPlaybacks: 1 });
  const a = store.create({ name: 'sala' });
  const c = store.create({ name: 'quarto' });
  const seg = segurado();
  b.getTorrent = async () => { await seg.p; return null; };
  const r1 = resposta();
  const p1 = b.handle(get(a.token, `/s/${HASH}/0`), r1);

  let efeitos = 0;
  b.ascResolver = async () => { efeitos++; return { infoHash: HASH2, fileIdx: 0 }; };
  const abrir = b.getTorrent;
  b.getTorrent = async (...args) => { efeitos++; return abrir(...args); };
  const r2 = resposta();
  await b.handle(get(c.token, '/a/99'), r2);
  assert.equal(r2.statusCode, 429);
  assert.ok(Number(r2.headers['Retry-After']) >= 1);
  assert.equal(JSON.parse(r2.body).limite, 'global');
  assert.equal(efeitos, 0, 'nenhum .torrent baixado nem torrent aberto para o pedido recusado');

  // HEAD segue sem vaga e sem efeitos, mesmo com o limite cheio
  const h = resposta();
  await b.handle(get(c.token, `/s/${HASH2}/0`, 'HEAD'), h);
  assert.equal(h.statusCode, 200);
  assert.equal(efeitos, 0);

  seg.liberar();
  await p1;
});

test('ponte: seek do mesmo aparelho (outro Range, mesmo filme) não consome vaga nova', async () => {
  const b = ponte({ maxPlaybacks: 1 });
  const a = store.create({ name: 'tv' });
  const seg = segurado();
  b.getTorrent = async () => { await seg.p; return null; };
  const r1 = resposta(); const r2 = resposta();
  const p1 = b.handle(get(a.token, `/s/${HASH}/0`), r1);
  const p2 = b.handle(get(a.token, `/s/${HASH}/0`), r2);
  assert.equal(r2.statusCode, 0, 'não foi recusada');
  assert.equal(b.limiter.snapshot().active, 1);
  seg.liberar();
  await Promise.all([p1, p2]);
});

test('ponte: resposta destruída durante o await libera a vaga (sem contador preso)', async () => {
  const b = ponte({ maxPlaybacks: 1 });
  const a = store.create({ name: 'tv' });
  const seg = segurado();
  b.getTorrent = async () => { await seg.p; return { files: [] }; };
  const r1 = resposta();
  const p1 = b.handle(get(a.token, `/s/${HASH}/0`), r1);
  assert.equal(b.limiter.snapshot().active, 1);
  r1.destroy(); // cliente saiu durante a espera
  seg.liberar();
  await p1;
  assert.equal(b.limiter.snapshot().active, 0);
  assert.equal(b.streams.get(HASH) ?? 0, 0);
});

test('ponte: erro do resolvedor (503/502) não segura a vaga', async () => {
  const b = ponte({ maxPlaybacks: 1 });
  const a = store.create({ name: 'tv' });
  b.ascResolver = async () => { const e = new Error('sem seeders'); e.status = 503; throw e; };
  const r1 = resposta();
  await b.handle(get(a.token, '/a/5'), r1);
  assert.equal(r1.statusCode, 503);
  assert.equal(b.limiter.snapshot().active, 0);
});

test('ponte: revogar durante a reprodução libera a vaga na hora', async () => {
  const b = ponte({ maxPlaybacks: 1 });
  const a = store.create({ name: 'tv' });
  const outra = store.create({ name: 'outra' });
  const seg = segurado();
  b.getTorrent = async () => { await seg.p; return null; };
  const r1 = resposta();
  const p1 = b.handle(get(a.token, `/s/${HASH}/0`), r1);
  assert.equal(b.limiter.snapshot().active, 1);
  store.revoke(a.credential.id);
  assert.equal(r1.destroyed, true);
  assert.equal(b.limiter.snapshot().active, 0);
  seg.liberar();
  await p1;
  const r2 = resposta();
  b.getTorrent = async () => null;
  await b.handle(get(outra.token, `/s/${HASH2}/0`), r2);
  assert.notEqual(r2.statusCode, 429);
});

test('ponte: /a/<id> sem torrent local passa para a chave do torrent depois de resolver (retentativa não duplica)', async () => {
  const b = ponte({ maxPlaybacks: 1 });
  const a = store.create({ name: 'tv' });
  const seg = segurado();
  b.ascResolver = async () => ({ infoHash: HASH, fileIdx: 0 });
  b.getTorrent = async () => { await seg.p; return null; };
  const r1 = resposta();
  const p1 = b.handle(get(a.token, '/a/12'), r1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...b.limiter.sessions.values()].map((s) => s.key), [`s:${HASH}:0`]);
  const r2 = resposta();
  b.entries.get(HASH).torrentPath = '/x/asc-12.torrent'; // agora o .torrent existe localmente
  const p2 = b.handle(get(a.token, '/a/12'), r2);
  assert.equal(r2.statusCode, 0);
  assert.equal(b.limiter.snapshot().active, 1);
  seg.liberar();
  await Promise.all([p1, p2]);
});

test('ponte: expiração pelo relógio injetado e diagnóstico administrativo só com nomes e contagens', async () => {
  const rel = relogio();
  const b = ponte({ maxPlaybacks: 1, playbackGraceMs: 10_000, clock: rel.now });
  const a = store.create({ name: 'Sala' });
  b.getTorrent = async () => ({ files: [] });
  await b.handle(get(a.token, `/s/${HASH}/0`), resposta()); // 404 sem arquivo: não segura vaga
  assert.equal(b.limiter.snapshot().active, 0);
  const snap = b.playbackSnapshot();
  assert.equal(snap.maxSessions, 1);
  assert.equal(snap.graceSeconds, 10);
});

test('configuração: chaves novas existem com padrão sem limite e validam faixa', () => {
  const dir = tmpdir('play-cfg-');
  const r = settings.resolve({ dataDir: dir, env: {} });
  assert.equal(r.values.PLAYBACK_MAX_SESSIONS, 0);
  assert.equal(r.values.PLAYBACK_MAX_PER_CREDENTIAL, 0);
  assert.equal(r.values.PLAYBACK_SESSION_GRACE_SECONDS, 30);
  const ruim = settings.resolve({ dataDir: dir, env: { PLAYBACK_MAX_SESSIONS: '-1', PLAYBACK_SESSION_GRACE_SECONDS: '1' } });
  assert.ok(ruim.problems.length >= 2);
});

test('ponte: método diferente de GET/HEAD nas rotas de vídeo é recusado sem efeitos nem vaga', async () => {
  const b = ponte({ maxPlaybacks: 1 });
  const a = store.create({ name: 'tv' });
  let efeitos = 0;
  b.ascResolver = async () => { efeitos++; return { infoHash: HASH, fileIdx: 0 }; };
  b.getTorrent = async () => { efeitos++; return null; };
  for (const url of [`/s/${HASH}/0`, '/a/3']) {
    const r = resposta();
    await b.handle(get(a.token, url, 'POST'), r);
    assert.equal(r.statusCode, 405);
  }
  assert.equal(efeitos, 0);
  assert.equal(b.limiter.snapshot().active, 0);
});
