const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./tmp-helper');
const { CredentialStore, currentToken, currentCredential } = require('../src/credentials');
const { createAddonHandler } = require('../src/addon-auth');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { logger } = require('../src/logger');
const cli = require('../src/credenciais-cli');

const newStore = () => new CredentialStore({ file: path.join(tmpdir('cred-'), 'credentials.json') });
const ADMIN = 'ad'.repeat(16);
const HASH = 'a'.repeat(40);

test('emissão: token forte, só o verificador vai ao disco e a verificação acerta', () => {
  const store = newStore();
  const { credential, token } = store.create({ name: '  Sala   de TV ' });
  assert.match(token, /^ascc_[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.name, 'Sala de TV');
  assert.equal(credential.status, false, 'status negado por padrão');
  assert.equal(store.verify(token).id, credential.id);
  const onDisk = fs.readFileSync(store.file, 'utf8');
  assert.ok(!onDisk.includes(token), 'o token nunca é gravado');
  assert.ok(!JSON.stringify(store.list()).includes('verifier'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  // sobrevive ao reinício
  const again = new CredentialStore({ file: store.file });
  assert.equal(again.verify(token).id, credential.id);
});

test('verificação recusa token ausente, malformado, errado e de outra credencial', () => {
  const store = newStore();
  const a = store.create({ name: 'a' });
  for (const ruim of [undefined, null, '', 'ascc_curto', `${a.token}x`, `ascc_${'A'.repeat(43)}`, 'a'.repeat(32), a.credential.id]) {
    assert.equal(store.verify(ruim), null, String(ruim));
  }
});

test('revogação é individual e imediata; rotação troca o token mantendo nome e permissão', () => {
  const store = newStore();
  const a = store.create({ name: 'A', status: true });
  const b = store.create({ name: 'B' });
  const revoked = [];
  store.on('revoked', (id) => revoked.push(id));
  assert.equal(store.revoke(a.credential.id), true);
  assert.equal(store.verify(a.token), null);
  assert.ok(store.verify(b.token), 'as demais continuam valendo');
  assert.deepEqual(revoked, [a.credential.id]);
  assert.equal(store.revoke('c_00000000'), false);
  const next = store.rotate(b.credential.id);
  assert.notEqual(next.token, b.token);
  assert.equal(store.verify(b.token), null);
  assert.ok(store.verify(next.token));
  assert.equal(store.rotate(b.credential.id), null, 'não gira credencial já revogada');
  assert.equal(new CredentialStore({ file: store.file }).verify(b.token), null, 'a revogação persiste');
});

test('arquivo corrompido ou inexistente: nenhuma credencial vale (fail-closed)', () => {
  const dir = tmpdir('cred-');
  const file = path.join(dir, 'credentials.json');
  assert.equal(new CredentialStore({ file }).hasActive(), false);
  fs.writeFileSync(file, '{ não é json');
  assert.equal(new CredentialStore({ file }).hasActive(), false);
  assert.throws(() => new CredentialStore({ file }).create({ name: '' }), /nome da credencial/);
  assert.throws(() => new CredentialStore({ file }).create({ name: 'x'.repeat(41) }), /nome da credencial/);
});

// --------------------------------------------------------------- porta do addon

function fakeRes() {
  const r = { status: 0, headers: {}, body: '' };
  r.writeHead = (s, h) => { r.status = s; r.headers = h ?? {}; };
  r.end = (b) => { r.body = b ?? ''; };
  return r;
}

function addonHarness() {
  const store = newStore();
  const manifest = { id: 'x', catalogs: [{ id: 'asc-status' }, { id: 'asc' }], idPrefixes: ['asc:', 'ascstatus:'] };
  const seen = [];
  const router = (req, res) => {
    seen.push({ url: req.url, token: currentToken(), credential: currentCredential() });
    res.writeHead(200, {});
    res.end('{"metas":[]}');
  };
  const status = { snapshot: () => ({}), panelUrl: 'http://127.0.0.1:7020' };
  const handler = createAddonHandler({ addon: { manifest }, router, store, status });
  const call = (url, method = 'GET') => { const res = fakeRes(); handler({ url, method, headers: {} }, res); return res; };
  return { store, call, seen };
}

test('addon: sem credencial, errada ou revogada nada é entregue (manifesto e recursos)', () => {
  const { store, call, seen } = addonHarness();
  const { credential, token } = store.create({ name: 'tv' });
  const errada = `ascc_${'B'.repeat(43)}`;
  for (const url of ['/manifest.json', '/catalog/movie/asc.json', '/stream/movie/tt1.json', `/${errada}/manifest.json`, `/${errada}/catalog/movie/asc.json`, '/status/poster/resumo.svg', '/']) {
    const r = call(url);
    assert.equal(r.status, 403, url);
    assert.ok(!r.body.includes('metas'), url);
  }
  assert.equal(call(`/${token}/catalog/movie/asc.json`).status, 200);
  store.revoke(credential.id);
  for (const url of [`/${token}/manifest.json`, `/${token}/catalog/movie/asc.json`, `/${token}/stream/movie/tt1.json`]) {
    assert.equal(call(url).status, 403, `revogada: ${url}`);
  }
  assert.equal(seen.length, 1, 'o roteador só rodou para o pedido válido');
});

test('addon: o roteador vê o caminho sem o prefixo e o token fica no contexto da requisição', () => {
  const { store, call, seen } = addonHarness();
  const { credential, token } = store.create({ name: 'tv' });
  call(`/${token}/catalog/movie/asc/search=a%20b.json?x=1`);
  assert.equal(seen[0].url, '/catalog/movie/asc/search=a%20b.json?x=1');
  assert.equal(seen[0].token, token);
  assert.equal(seen[0].credential.id, credential.id);
});

test('addon: só rotas conhecidas e métodos de leitura; landing e escrita não passam', () => {
  const { store, call } = addonHarness();
  const { token } = store.create({ name: 'tv' });
  for (const url of [`/${token}/`, `/${token}`, `/${token}/configure`, `/${token}/outra`]) assert.equal(call(url).status, 404, url);
  assert.equal(call(`/${token}/catalog/movie/asc.json`, 'POST').status, 404);
});

test('addon: catálogo de status só aparece para credencial com status; pôster idem', () => {
  const { store, call } = addonHarness();
  const comum = store.create({ name: 'tv' });
  const admin = store.create({ name: 'eu', status: true });
  const man = (t) => JSON.parse(call(`/${t}/manifest.json`).body);
  assert.deepEqual(man(comum.token).catalogs.map((c) => c.id), ['asc']);
  assert.deepEqual(man(comum.token).idPrefixes, ['asc:']);
  assert.deepEqual(man(admin.token).catalogs.map((c) => c.id), ['asc-status', 'asc']);
  assert.equal(call(`/${comum.token}/status/poster/resumo.svg`).status, 404);
});

// ------------------------------------------------------------------------ ponte

function newBridge(store) {
  return new Bridge({
    torrentDir: '/tmp', storeDir: '/tmp', port: 7096, publicUrl: 'http://127.0.0.1:7096',
    credentials: store, adminKey: ADMIN, strictHost: true,
    vault: new SeedVault({ file: path.join(tmpdir('cred-vault-'), 'v.json') }),
  });
}

async function call(b, url, { method = 'GET', headers = {}, remote = '127.0.0.1' } = {}) {
  const out = { status: 0, body: '', destroyed: false };
  const res = {
    setHeader() {}, once() {}, on() {}, off() {}, statusCode: 0, writableFinished: true,
    writeHead(s) { out.status = s; }, end(chunk) { out.body = String(chunk ?? ''); },
    destroy() { out.destroyed = true; this.destroyed = true; },
  };
  await b.handle({ method, url, headers: { host: '127.0.0.1:7096', ...headers }, socket: { remoteAddress: remote } }, res);
  return out;
}

test('ponte: URLs de vídeo usam o token do contexto; sem contexto saem sem token', () => {
  const store = newStore();
  const b = newBridge(store);
  const { credential, token } = store.create({ name: 'tv' });
  assert.ok(!b.urlFor(HASH, 0).includes('k='));
  const { runWith } = require('../src/credentials');
  runWith(credential, token, () => {
    assert.equal(b.urlFor(HASH, 2), `http://127.0.0.1:7096/s/${HASH}/2?k=${token}`);
    assert.equal(b.lazyUrl(12), `http://127.0.0.1:7096/a/12?k=${token}`);
  });
});

test('ponte: /s e /a recusam sem credencial, com token errado ou revogado (GET, HEAD e Range)', async () => {
  const store = newStore();
  const b = newBridge(store);
  const { credential, token } = store.create({ name: 'tv' });
  const errado = `ascc_${'C'.repeat(43)}`;
  for (const method of ['GET', 'HEAD']) {
    for (const q of ['', `?k=${errado}`, '?k=', `?k=${credential.id}`]) {
      assert.equal((await call(b, `/s/${HASH}/0${q}`, { method })).status, 403, `${method} /s${q}`);
      assert.equal((await call(b, `/a/12${q}`, { method })).status, 403, `${method} /a${q}`);
    }
  }
  assert.equal((await call(b, `/a/12?k=${token}`, { method: 'HEAD' })).status, 200, 'credencial válida passa pela autenticação');
  store.revoke(credential.id);
  const range = { range: 'bytes=100-' };
  assert.equal((await call(b, `/a/12?k=${token}`, { method: 'HEAD' })).status, 403);
  assert.equal((await call(b, `/s/${HASH}/0?k=${token}`, { headers: range })).status, 403, 'Range com URL guardada em cache');
});

test('ponte: sem repositório de credenciais tudo é recusado (fail-closed)', async () => {
  const b = newBridge(null);
  assert.equal((await call(b, '/a/12', { method: 'HEAD' })).status, 403);
  assert.equal((await call(b, `/a/12?k=${'ascc_' + 'D'.repeat(43)}`, { method: 'HEAD' })).status, 403);
});

test('ponte: revogar derruba as respostas de vídeo já abertas só dessa credencial', () => {
  const store = newStore();
  const b = newBridge(store);
  const a = store.create({ name: 'a' });
  const c = store.create({ name: 'c' });
  const aberto = (id) => {
    const res = { closed: false, handlers: [], once(ev, fn) { this.handlers.push(fn); }, destroy() { this.closed = true; } };
    b.trackSession(id, res);
    return res;
  };
  const ra = aberto(a.credential.id);
  const rc = aberto(c.credential.id);
  store.revoke(a.credential.id);
  assert.equal(ra.closed, true);
  assert.equal(rc.closed, false);
});

test('ponte: revogar durante a espera do torrent não deixa stream contado nem abre o torrent', async () => {
  const store = newStore();
  const b = newBridge(store);
  const { credential, token } = store.create({ name: 'tv' });
  let abriu = false;
  b.ascResolver = async () => { store.revoke(credential.id); return { infoHash: HASH, fileIdx: 0 }; };
  b.getTorrent = async () => { abriu = true; return null; };
  const r = await call(b, `/a/12?k=${token}`);
  assert.equal(r.destroyed, true);
  assert.equal(abriu, false, 'não abre o torrent para uma credencial revogada');
  assert.equal(b.streams.size, 0);

  // Mesma corrida, agora na espera de getTorrent (fonte já local): o contador não pode ficar em 1.
  const outra = store.create({ name: 'sala' });
  b.getTorrent = async () => { store.revoke(outra.credential.id); return { files: [] }; };
  const r2 = await call(b, `/s/${HASH}/0?k=${outra.token}`);
  assert.equal(r2.destroyed, true);
  assert.equal(b.streams.size, 0);
});

test('administração das credenciais: token administrativo, sem Origin; a credencial de reprodução não vale', async () => {
  const store = newStore();
  const b = newBridge(store);
  const play = store.create({ name: 'tv' });
  const admin = { 'x-admin-token': ADMIN };
  for (const headers of [{}, { 'x-admin-token': play.token }, { ...admin, origin: 'http://evil.example' }]) {
    assert.equal((await call(b, '/credentials', { headers })).status, 403);
    assert.equal((await call(b, '/credentials?name=x', { method: 'POST', headers })).status, 403);
    assert.equal((await call(b, `/credentials/revoke?id=${play.credential.id}`, { method: 'POST', headers })).status, 403);
  }
  assert.equal((await call(b, `/credentials?k=${play.token}`)).status, 403, 'token na query não é credencial administrativa');
  assert.equal((await call(b, '/credentials', { headers: admin, remote: '192.168.0.9' })).status, 403, 'fora do loopback');
  assert.ok(store.verify(play.token), 'recusas não revogam nada');

  const criada = await call(b, '/credentials?name=Quarto&status=1', { method: 'POST', headers: admin });
  assert.equal(criada.status, 201);
  const body = JSON.parse(criada.body);
  assert.equal(body.credential.status, true);
  assert.ok(store.verify(body.token));
  const lista = await call(b, '/credentials', { headers: admin });
  assert.ok(!lista.body.includes(body.token) && !lista.body.includes('verifier'), 'a lista nunca traz token');
  assert.equal(JSON.parse(lista.body).credentials.length, 2);
  assert.equal((await call(b, '/credentials?name=', { method: 'POST', headers: admin })).status, 400);

  const girada = JSON.parse((await call(b, `/credentials/rotate?id=${body.credential.id}`, { method: 'POST', headers: admin })).body);
  assert.equal(store.verify(body.token), null);
  assert.ok(store.verify(girada.token));
  assert.equal((await call(b, `/credentials/revoke?id=${girada.credential.id}`, { method: 'POST', headers: admin })).status, 200);
  assert.equal((await call(b, '/credentials/revoke?id=c_ffffffff', { method: 'POST', headers: admin })).status, 404);
  assert.ok(store.verify(play.token), 'a revogação é individual');
});

// ------------------------------------------------------------------- logs e CLI

test('logs: token de credencial e ?k= são redigidos', () => {
  const token = `ascc_${'E'.repeat(43)}`;
  const text = logger.redact(`GET /${token}/manifest.json e http://x/s/${HASH}/0?k=${token} ok`);
  assert.ok(!text.includes('EEEE'), text);
  assert.match(text, /ascc_\[redigido\]/);
  assert.match(logger.redact('http://x/a/1?k=qualquercoisa&y=1'), /k=\[redigido\]&y=1/);
});

test('CLI: emite com a URL de instalação, lista sem token e fala com a ponte com o token administrativo', async () => {
  const dir = tmpdir('cred-cli-');
  fs.writeFileSync(path.join(dir, 'admin-key'), ADMIN);
  const chamadas = [];
  const respostas = [
    { status: 201, body: { credential: { id: 'c_00000001', name: 'Sala', status: true }, token: `ascc_${'F'.repeat(43)}` } },
    { status: 200, body: { credentials: [{ id: 'c_00000001', name: 'Sala', status: true, createdAt: 0, revokedAt: null }] } },
    { status: 200, body: { credentials: [{ id: 'c_00000001', name: 'Sala', status: true, createdAt: 0, revokedAt: null }] } },
    { status: 404, body: { error: 'credencial inexistente' } },
  ];
  const doFetch = async (url, init) => {
    chamadas.push({ url, init });
    const r = respostas.shift();
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const env = { DATA_DIR: dir, BRIDGE_PORT: '7999', PORT: '7998' };
  const linhas = [];
  const out = (l) => linhas.push(l);
  assert.equal(await cli.run(['criar', 'Sala', '--status'], { env, doFetch, out }), 0);
  assert.equal(chamadas[0].url, 'http://127.0.0.1:7999/credentials?name=Sala&status=1');
  assert.equal(chamadas[0].init.headers['X-Admin-Token'], ADMIN);
  assert.ok(linhas.some((l) => l === `http://127.0.0.1:7998/ascc_${'F'.repeat(43)}/manifest.json`));
  linhas.length = 0;
  assert.equal(await cli.run(['listar'], { env, doFetch, out }), 0);
  assert.ok(linhas[0].includes('c_00000001') && !linhas.join('').includes('ascc_'));
  linhas.length = 0;
  assert.equal(await cli.run(['garantir'], { env, doFetch, out }), 0);
  assert.match(linhas.join('\n'), /Já existe credencial ativa/);
  await assert.rejects(cli.run(['revogar', 'c_ffffffff'], { env, doFetch, out }), /inexistente/);
  assert.equal(await cli.run(['criar'], { env, doFetch, out }), 2);
  await assert.rejects(cli.run(['listar'], { env: { DATA_DIR: tmpdir('vazio-') }, doFetch, out }), /admin-key/);
});

test('último uso: só em memória, por credencial, sem alterar o arquivo nem sobreviver ao reinício', () => {
  let now = 1000;
  const file = path.join(tmpdir('uso-'), 'credentials.json');
  const store = new CredentialStore({ file, now: () => now });
  const a = store.create({ name: 'Sala' });
  const b = store.create({ name: 'Quarto' });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(store.verify(a.token).lastUsedAt, null);
  store.recordUse(a.credential.id);
  assert.equal(store.verify(a.token).lastUsedAt, 1000);
  now = 2000;
  store.recordUse(a.credential.id);
  assert.equal(store.list().find(c => c.id === a.credential.id).lastUsedAt, 2000);
  assert.equal(store.verify(b.token).lastUsedAt, null);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  store.revoke(a.credential.id);
  now = 3000;
  store.recordUse(a.credential.id);
  assert.equal(store.list().find(c => c.id === a.credential.id).lastUsedAt, 2000);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('lastUsedAt'));
  assert.equal(new CredentialStore({ file }).list()[0].lastUsedAt, null);
});

test('rotacionar: falha ao gravar preserva a antiga e não encerra sessões', () => {
  const store = newStore();
  const a = store.create({ name: 'Sala', status: true });
  const before = fs.readFileSync(store.file, 'utf8');
  let revoked = false;
  store.on('revoked', () => { revoked = true; });
  store.save = () => { throw new Error('disco indisponível'); };
  assert.throws(() => store.rotate(a.credential.id), /disco indisponível/);
  assert.equal(store.list().length, 1);
  assert.ok(store.verify(a.token));
  assert.equal(revoked, false);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
});

test('último uso do addon: GET autenticado conta; HEAD, OPTIONS, rota e token inválidos não', () => {
  const store = newStore();
  const a = store.create({ name: 'Sala' });
  const handle = createAddonHandler({ store, addon: { manifest: { catalogs: [] } }, router: () => {} });
  const invoke = (method, url) => handle({ method, url }, { writeHead() {}, end() {} });
  for (const method of ['HEAD', 'OPTIONS']) invoke(method, `/${a.token}/manifest.json`);
  invoke('GET', `/${a.token}/desconhecida`);
  invoke('GET', '/invalido/manifest.json');
  assert.equal(store.verify(a.token).lastUsedAt, null);
  invoke('GET', `/${a.token}/manifest.json`);
  assert.ok(store.verify(a.token).lastUsedAt);
});

test('último uso do vídeo: HEAD não conta; GET autenticado conta', async () => {
  const store = newStore();
  const a = store.create({ name: 'Sala' });
  const b = newBridge(store);
  await call(b, `/a/12?k=${a.token}`, { method: 'HEAD' });
  assert.equal(store.verify(a.token).lastUsedAt, null);
  await call(b, `/a/12?k=${a.token}`);
  assert.ok(store.verify(a.token).lastUsedAt);
});
