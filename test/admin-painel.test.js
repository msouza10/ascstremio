const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const access = require('../src/admin-access');
const auth = require('../src/admin-auth');
const cli = require('../src/admin-cli');
const settings = require('../src/settings');
const { startConfig } = require('../src/config-server');
const { Logger } = require('../src/logger');
const { tmpdir } = require('./tmp-helper');

const NET = { eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] };
const SENHA = 'correto-cavalo-bateria-9';
const LAN_NET = { host: '192.168.1.20', hostKind: 'ipv4', hostSource: 'config' };
let nextPort = 7440;

const baseValues = (extra = {}) => ({
  CONFIG_ALLOW_LAN: true, CONFIG_PUBLIC_URL: null, CONFIG_ADMIN_HTTP_CLEAR: true, CONFIG_BIND_ADDRESS: null,
  CONFIG_SESSION_IDLE_MINUTES: 30, CONFIG_SESSION_MAX_HOURS: 12, CONFIG_PORT: 7020, ...extra,
});
const planOf = (extra = {}, over = {}) => access.plan({
  values: baseValues(extra), mode: 'lan', container: false, net: LAN_NET, credentialConfigured: true, interfaces: NET, port: 7020, ...over,
});

// ---------------------------------------------------------------- plano (pré-condições)
test('plano: desligado por padrão e cada pré-condição faltando recusa (fail-closed)', () => {
  assert.equal(planOf({ CONFIG_ALLOW_LAN: false }).enabled, false);
  assert.deepEqual(planOf({ CONFIG_ALLOW_LAN: false }).hosts, []);
  assert.equal(planOf().enabled, true);
  assert.match(planOf({}, { mode: 'local' }).problems.join(' '), /ASCSTREMIO_MODE=lan/);
  assert.match(planOf({}, { container: true }).problems.join(' '), /contêiner/);
  assert.match(planOf({}, { credentialConfigured: false }).problems.join(' '), /senha de administração/);
  assert.match(planOf({}, { net: { ...LAN_NET, hostSource: 'auto' } }).problems.join(' '), /explícito/);
  assert.match(planOf({}, { net: { host: null } }).problems.join(' '), /explícito/);
  assert.match(planOf({ CONFIG_ADMIN_HTTP_CLEAR: false }).problems.join(' '), /sem criptografia/);
  assert.equal(planOf({ CONFIG_ADMIN_HTTP_CLEAR: false }).enabled, false);
  assert.match(planOf({ CONFIG_BIND_ADDRESS: '0.0.0.0' }).problems.join(' '), /nunca 0\.0\.0\.0/);
  assert.match(planOf({}, { interfaces: { eth0: [{ address: '10.0.0.9', family: 'IPv4' }] } }).problems.join(' '), /não pertence/);
  assert.match(planOf({}, { net: { host: 'nas.casa.lan', hostKind: 'dns', hostSource: 'config' } }).problems.join(' '), /CONFIG_BIND_ADDRESS/);
});

test('plano: Host e Origin exatos, sem curinga; bind só no IPv4 escolhido', () => {
  const p = planOf();
  assert.deepEqual(p.hosts, ['192.168.1.20:7020']);
  assert.deepEqual(p.origins, ['http://192.168.1.20:7020']);
  assert.deepEqual(p.bind, ['127.0.0.1', '192.168.1.20']);
  const dns = planOf({ CONFIG_BIND_ADDRESS: '192.168.1.20' }, { net: { host: 'NAS.casa.lan', hostKind: 'dns', hostSource: 'config' } });
  assert.equal(dns.enabled, true);
  assert.deepEqual(dns.hosts, ['nas.casa.lan:7020']);
});

test('plano: HTTPS por proxy escuta só em loopback, cookie Secure; http:// e caminho são recusados', () => {
  const p = planOf({ CONFIG_PUBLIC_URL: 'https://painel.casa.lan', CONFIG_ADMIN_HTTP_CLEAR: false });
  assert.equal(p.enabled, true);
  assert.equal(p.transport, 'https-proxy');
  assert.equal(p.secureCookie, true);
  assert.deepEqual(p.bind, ['127.0.0.1']);
  assert.deepEqual(p.hosts, ['painel.casa.lan']);
  assert.equal(planOf({ CONFIG_PUBLIC_URL: 'http://painel.casa.lan' }).enabled, false);
  assert.equal(planOf({ CONFIG_PUBLIC_URL: 'https://painel.casa.lan/x' }).enabled, false);
  assert.equal(planOf({ CONFIG_PUBLIC_URL: 'https://painel.casa.lan', CONFIG_BIND_ADDRESS: '192.168.1.20' }).enabled, false);
});

test('esquema: chaves novas são só do terminal e têm padrão seguro', () => {
  const snap = settings.load({ dataDir: tmpdir('adm-sch-'), env: {}, interfaces: NET });
  assert.equal(snap.values.CONFIG_ALLOW_LAN, false);
  assert.equal(snap.values.CONFIG_SESSION_IDLE_MINUTES, 30);
  assert.equal(snap.values.CONFIG_SESSION_MAX_HOURS, 12);
  for (const key of ['CONFIG_ALLOW_LAN', 'CONFIG_PUBLIC_URL', 'CONFIG_ADMIN_HTTP_CLEAR', 'CONFIG_BIND_ADDRESS']) {
    assert.equal(settings.schemaEntry(key).risky, true, `${key} não pode ser alterada pelo painel`);
  }
  assert.throws(() => settings.load({ dataDir: tmpdir('adm-sch2-'), env: { CONFIG_SESSION_IDLE_MINUTES: '1' } }));
});

// ---------------------------------------------------------------- credencial e sessões
test('credencial: scrypt com sal, arquivo 0600, política de senha e comparação correta', async () => {
  const dir = tmpdir('adm-cred-');
  await assert.rejects(() => auth.buildRecord('curta'), /12 caracteres/);
  await assert.rejects(() => auth.buildRecord('aaaaaaaaaaaaaaaa'), /repetidos/);
  const rec = await auth.buildRecord(SENHA);
  auth.writeRecord(dir, rec, { exclusive: true });
  const raw = fs.readFileSync(auth.filePath(dir), 'utf8');
  assert.ok(!raw.includes(SENHA), 'a senha nunca vai ao disco');
  if (process.platform !== 'win32') assert.equal(fs.statSync(auth.filePath(dir)).mode & 0o777, 0o600);
  const c = new auth.AdminCredential({ dataDir: dir });
  assert.equal(await c.verify(SENHA), true);
  assert.equal(await c.verify(`${SENHA}x`), false);
  assert.equal(await c.verify(''), false);
  assert.equal(await c.verify('x'.repeat(5000)), false);
  assert.throws(() => auth.writeRecord(dir, rec, { exclusive: true }), /Já existe/);
});

test('credencial: arquivo corrompido ou adulterado = sem credencial (fail-closed)', async () => {
  const dir = tmpdir('adm-bad-');
  fs.writeFileSync(auth.filePath(dir), '{"version":1,"kdf":"scrypt"}');
  const c = new auth.AdminCredential({ dataDir: dir });
  assert.equal(c.configured(), false);
  assert.equal(await c.verify(SENHA), false);
  fs.writeFileSync(auth.filePath(dir), 'não é json');
  assert.equal(new auth.AdminCredential({ dataDir: dir }).configured(), false);
});

test('sessões: expiram por inatividade e por tempo absoluto, rotacionam o id e seguem a geração', () => {
  let t = 1_000_000; let gen = 'aaaaaaaaaaaaaaaa';
  const s = new auth.AdminSessions({ idleMs: 60_000, maxMs: 600_000, generation: () => gen, now: () => t, rotateMs: 50_000 });
  const { id } = s.create('h:1');
  assert.ok(s.check(id, 'h:1'));
  assert.equal(s.check(id, 'outro:1'), null, 'presa ao Host do login');
  const again = s.create('h:1');
  t += 59_000; assert.ok(s.check(again.id, 'h:1'));
  t += 61_000; assert.equal(s.check(again.id, 'h:1'), null, 'inatividade');
  const long = s.create('h:1'); let cur = long.id;
  for (let i = 0; i < 12; i += 1) { t += 50_000; const r = s.check(cur, 'h:1'); assert.ok(r); if (r.rotateTo) cur = r.rotateTo; }
  t += 50_000; assert.equal(s.check(cur, 'h:1'), null, 'tempo absoluto de 10 min');
  const r1 = s.create('h:1'); t += 55_000;
  const rot = s.check(r1.id, 'h:1');
  assert.ok(rot.rotateTo, 'id novo depois do prazo');
  assert.ok(s.check(r1.id, 'h:1'), 'o id antigo ainda vale por poucos segundos (requisições paralelas)');
  t += 20_000; assert.equal(s.check(r1.id, 'h:1'), null, 'e depois deixa de valer');
  assert.ok(s.check(rot.rotateTo, 'h:1'));
  gen = 'bbbbbbbbbbbbbbbb';
  assert.equal(s.check(rot.rotateTo, 'h:1'), null, 'troca de senha revoga');
  gen = null;
  assert.equal(s.check('x'.repeat(43), 'h:1'), null);
});

test('limitador: 5 falhas por origem e 30 globais por minuto; a janela libera sozinha', () => {
  let t = 0;
  const l = new auth.LoginLimiter({ now: () => t });
  for (let i = 0; i < 5; i += 1) { assert.ok(l.check('a').ok); l.fail('a'); }
  const blocked = l.check('a');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);
  assert.ok(l.check('b').ok, 'outra origem não é afetada');
  t += 61_000;
  assert.ok(l.check('a').ok);
  for (let i = 0; i < 30; i += 1) l.fail(`s${i}`);
  assert.equal(l.check('nova').ok, false, 'teto global');
});

// ---------------------------------------------------------------- servidor
function request(port, method, route, { host, headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${port}`, ...Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) };
    if (cookie) h.Cookie = cookie;
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = h['Content-Type'] ?? 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port, method, path: route, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch { /* não é JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function setup({ remote = true, extra = {}, planOver = {}, withPassword = true } = {}) {
  const dataDir = tmpdir('adm-srv-');
  if (withPassword) auth.writeRecord(dataDir, await auth.buildRecord(SENHA));
  const port = nextPort++;
  const plan = access.plan({
    values: baseValues({ CONFIG_PORT: port, ...extra }), mode: 'lan', container: false, net: LAN_NET,
    credentialConfigured: withPassword, interfaces: NET, port, ...planOver,
  });
  const logs = new Logger();
  const clock = { t: Date.now() };
  const asc = { connected: true, status: () => ({ connected: true, user: 'fulano' }) };
  const panel = { state: () => ({ options: [] }), listCredentials: () => [], preview: () => ({}), save: () => ({ changes: [], revision: 1 }) };
  const server = await startConfig(asc, port, { snapshot: () => ({ titles: [] }), complete: async () => ({}) }, logs, panel,
    remote ? { plan, dataDir, now: () => clock.t, failDelayMs: 0 } : null);
  const lanHost = `192.168.1.20:${port}`;
  const localHost = `127.0.0.1:${port}`;
  const loginToken = /"([0-9a-f]{64})"/.exec((await request(port, 'GET', '/config.js', { host: localHost })).text)[1];
  const login = (over = {}) => request(port, 'POST', '/api/admin/session', {
    host: lanHost, headers: { Origin: `http://${lanHost}`, 'X-CSRF-Token': loginToken }, body: { password: SENHA }, ...over,
  });
  const logged = async (host = lanHost) => {
    const r = await login({ host, headers: { Origin: `http://${host}`, 'X-CSRF-Token': loginToken } });
    assert.equal(r.status, 200, r.text);
    return { cookie: r.headers['set-cookie'][0].split(';')[0], csrf: r.json.csrf, host, setCookie: r.headers['set-cookie'][0], body: r.text };
  };
  return { dataDir, port, plan, logs, clock, server, lanHost, localHost, loginToken, login, logged, req: (m, r, o) => request(port, m, r, o),
    close: () => new Promise((r) => server.close(r)) };
}

test('padrão: sem administração pela LAN nada muda (só 127.0.0.1, sem login de administração)', async () => {
  const t = await setup({ remote: false });
  try {
    assert.deepEqual((await t.req('GET', '/api/admin/session', { host: t.localHost })).json, { enabled: false });
    assert.equal((await t.req('GET', '/api/status', { host: t.localHost })).status, 200);
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost })).status, 403, 'Host da LAN recusado');
    assert.equal((await t.req('GET', '/api/status', { host: 'painel.casa.lan' })).status, 403);
  } finally { await t.close(); }
});

test('plano recusado (sem senha): remoto continua desligado, painel local segue e o erro é registrado', async () => {
  const t = await setup({ withPassword: false });
  try {
    assert.equal(t.plan.enabled, false);
    assert.equal((await t.req('GET', '/api/status', { host: t.localHost })).status, 200);
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost })).status, 403);
    assert.ok(t.logs.entries.some((e) => /NÃO habilitada/.test(JSON.stringify(e))));
  } finally { await t.close(); }
});

test('com administração ativa: sem sessão tudo em /api dá 401, inclusive logs, status e pelo 127.0.0.1', async () => {
  const t = await setup();
  try {
    for (const host of [t.lanHost, t.localHost]) {
      for (const route of ['/api/status', '/api/logs', '/api/logs/files', '/api/logs/download', '/api/monitor', '/api/settings', '/api/credentials', '/credentials', '/api/login']) {
        const r = await t.req('GET', route, { host });
        assert.equal(r.status, route === '/credentials' ? 404 : 401, `${host} ${route}`);
      }
      const post = await t.req('POST', '/api/logs/level', { host, headers: { Origin: `http://${host}`, 'X-CSRF-Token': t.loginToken }, body: { nivel: 'debug' } });
      assert.equal(post.status, 401);
    }
    assert.equal((await t.req('GET', '/', { host: t.lanHost })).status, 200, 'o shell da UI é público (sem dados)');
    const st = await t.req('GET', '/api/admin/session', { host: t.lanHost });
    assert.deepEqual(st.json.authenticated, false);
    assert.equal(st.json.csrf, undefined);
  } finally { await t.close(); }
});

test('Host: IP/porta errados, nome DNS (rebinding) e Host de LAN vindo do socket errado são recusados', async () => {
  const t = await setup();
  try {
    for (const host of ['evil.example.com', `evil.example.com:${t.port}`, '192.168.1.21:' + t.port, '192.168.1.20', `192.168.1.20:${t.port + 1}`, `127.0.0.1:${t.port + 1}`, `localhost:${t.port}`, `192.168.1.20:${t.port}.evil.com`]) {
      const r = await t.req('GET', '/api/admin/session', { host });
      assert.equal(r.status, 403, `Host "${host}"`);
    }
    const ok = await t.req('GET', '/api/admin/session', { host: t.lanHost.toUpperCase() });
    assert.equal(ok.status, 200, 'Host é caso-insensível');
  } finally { await t.close(); }
});

test('login: senha errada devolve 401 genérico; certa cria cookie HttpOnly SameSite=Strict, sem vazar a senha', async () => {
  const t = await setup();
  try {
    const bad = await t.login({ body: { password: 'errada-errada-1234' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.code, 'bad_password');
    assert.equal(bad.headers['set-cookie'], undefined);
    const s = await t.logged();
    assert.match(s.setCookie, /^asc_admin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    assert.ok(!/Secure/.test(s.setCookie), 'HTTP em claro: sem Secure (o navegador rejeitaria)');
    assert.ok(!s.body.includes(SENHA));
    const all = JSON.stringify(t.logs.entries) + bad.text;
    assert.ok(!all.includes(SENHA) && !all.includes('errada-errada-1234'), 'senha fora de logs e respostas');
    assert.ok(!s.body.includes('hash') && !s.body.includes('salt'));
    const me = await t.req('GET', '/api/admin/session', { host: t.lanHost, cookie: s.cookie });
    assert.equal(me.json.authenticated, true);
    assert.equal(me.json.csrf, s.csrf);
  } finally { await t.close(); }
});

test('login: Origin errada, sem token de pré-login ou sem JSON é recusado (login-CSRF)', async () => {
  const t = await setup();
  try {
    const hdr = (o) => ({ Origin: `http://${t.lanHost}`, 'X-CSRF-Token': t.loginToken, ...o });
    for (const headers of [hdr({ Origin: 'http://evil.example.com' }), hdr({ Origin: undefined }), hdr({ Origin: `http://127.0.0.1:${t.port}` }), hdr({ 'X-CSRF-Token': 'x'.repeat(64) }), hdr({ 'X-CSRF-Token': undefined }), hdr({ 'Content-Type': 'text/plain' })]) {
      const r = await t.login({ headers });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.equal(r.headers['set-cookie'], undefined);
    }
  } finally { await t.close(); }
});

test('sessão errada, de outro Host, expirada, rotacionada e fixação: tudo vira 401', async () => {
  const t = await setup();
  try {
    const s = await t.logged();
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie: s.cookie })).status, 200);
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie: 'asc_admin=' + 'A'.repeat(43) })).status, 401);
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie: 'asc_admin=lixo' })).status, 401);
    assert.equal((await t.req('GET', '/api/status', { host: t.localHost, cookie: s.cookie })).status, 401, 'cookie do Host da LAN não vale em outro Host');
    // fixação: um id plantado antes do login nunca é adotado; o login sempre emite id novo
    const planted = 'asc_admin=' + 'B'.repeat(43);
    const r = await t.login({ cookie: planted });
    assert.notEqual(r.headers['set-cookie'][0].split(';')[0], planted);
    // inatividade
    t.clock.t += 31 * 60_000;
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie: s.cookie })).status, 401, 'expirada por inatividade');
    // tempo absoluto, mesmo com uso contínuo
    const s2 = await t.logged(); let cookie = s2.cookie;
    for (let i = 0; i < 25; i += 1) {
      t.clock.t += 29 * 60_000;
      const x = await t.req('GET', '/api/status', { host: t.lanHost, cookie });
      if (x.status !== 200) { assert.ok(i >= 24, `caiu cedo demais (${i})`); break; }
      if (x.headers['set-cookie']) cookie = x.headers['set-cookie'][0].split(';')[0];
    }
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie })).status, 401, 'limite absoluto de 12 h');
  } finally { await t.close(); }
});

test('CSRF por sessão e Origin exata nas ações; logout revoga', async () => {
  const t = await setup();
  try {
    const s = await t.logged();
    const act = (headers, body = { nivel: 'info' }) => t.req('POST', '/api/logs/level', { host: t.lanHost, cookie: s.cookie, headers, body });
    const good = { Origin: `http://${t.lanHost}`, 'X-CSRF-Token': s.csrf };
    assert.equal((await act(good)).status, 200);
    assert.equal((await act({ ...good, Origin: 'http://evil.example.com' })).status, 403);
    assert.equal((await act({ ...good, Origin: undefined })).status, 403);
    assert.equal((await act({ ...good, 'X-CSRF-Token': t.loginToken })).status, 403, 'o token de pré-login não vale como CSRF de sessão');
    assert.equal((await act({ ...good, 'X-CSRF-Token': undefined })).status, 403);
    assert.equal((await act({ ...good, 'Content-Type': 'text/plain' })).status, 403);
    const noCsrf = await t.req('DELETE', '/api/admin/session', { host: t.lanHost, cookie: s.cookie, headers: { Origin: `http://${t.lanHost}` } });
    assert.equal(noCsrf.status, 403);
    const out = await t.req('DELETE', '/api/admin/session', { host: t.lanHost, cookie: s.cookie, headers: good });
    assert.equal(out.status, 200);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie: s.cookie })).status, 401, 'o id antigo não volta a valer');
  } finally { await t.close(); }
});

test('força bruta: 5 erros por origem bloqueiam até a senha certa, com Retry-After; a janela libera', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await t.login({ body: { password: `errada-${i}-xxxxxxxx` } })).status, 401);
    const blocked = await t.login();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    assert.equal(blocked.headers['set-cookie'], undefined, 'nem a senha certa entra durante o bloqueio');
    t.server.admin.limiter.bySource.clear(); t.server.admin.limiter.all.length = 0; // equivale à janela vencida
    assert.equal((await t.login()).status, 200);
  } finally { await t.close(); }
});

test('recuperação local: trocar a senha, revogar sessões ou remover a credencial valem sem reiniciar', async () => {
  const t = await setup();
  const io = { out() {}, err() {}, tty: false, secret: async () => '' };
  const env = { DATA_DIR: t.dataDir };
  try {
    const s = await t.logged();
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie: s.cookie })).status, 200);
    assert.equal(await cli.run(['revogar-sessoes'], { env, io }), 0);
    assert.equal((await t.req('GET', '/api/status', { host: t.lanHost, cookie: s.cookie })).status, 401, 'sessão derrubada na hora');
    assert.equal((await t.login()).status, 200, 'a senha continua valendo');
    const pwFile = path.join(tmpdir('adm-pw-'), 'nova');
    fs.writeFileSync(pwFile, 'outra-senha-bem-longa-77\n');
    assert.equal(await cli.run(['definir', '--senha-arquivo', pwFile], { env, io }), 1, 'sem --trocar não sobrescreve');
    assert.equal(await cli.run(['definir', '--trocar', '--senha-arquivo', pwFile], { env, io }), 0);
    assert.equal((await t.login()).status, 401, 'a senha antiga morreu');
    assert.equal((await t.login({ body: { password: 'outra-senha-bem-longa-77' } })).status, 200);
    assert.equal(await cli.run(['remover'], { env, io }), 0);
    assert.equal((await t.login({ body: { password: 'outra-senha-bem-longa-77' } })).status, 403, 'sem senha o Host da LAN fecha');
    assert.equal((await t.req('GET', '/api/status', { host: t.localHost })).status, 200, 'o painel local volta ao modo local');
  } finally { await t.close(); }
});

test('ponte e rotas administrativas da ponte não existem neste servidor e o token admin não vale aqui', async () => {
  const t = await setup();
  try {
    const s = await t.logged();
    for (const route of ['/s/' + 'a'.repeat(40) + '/0', '/a/123', '/cleanup', '/seed-status', '/credentials', '/complete', '/playback']) {
      for (const method of ['GET', 'POST']) {
        const r = await t.req(method, route, { host: t.lanHost, cookie: s.cookie, headers: { 'X-Admin-Token': 'a'.repeat(32), Origin: `http://${t.lanHost}`, 'X-CSRF-Token': s.csrf }, body: method === 'POST' ? {} : undefined });
        assert.equal(r.status, 404, `${method} ${route}`);
      }
    }
    const anon = await t.req('GET', '/api/credentials', { host: t.lanHost, headers: { 'X-Admin-Token': 'a'.repeat(32) } });
    assert.equal(anon.status, 401, 'o cabeçalho X-Admin-Token não substitui a sessão');
  } finally { await t.close(); }
});

test('HTTPS por proxy: cookie __Host- Secure, Host e Origin https exatos; sem proxy local o Host público é recusado', async () => {
  const t = await setup({ extra: { CONFIG_PUBLIC_URL: 'https://painel.casa.lan', CONFIG_ADMIN_HTTP_CLEAR: false } });
  try {
    assert.equal(t.plan.transport, 'https-proxy');
    const r = await t.req('POST', '/api/admin/session', { host: 'painel.casa.lan', headers: { Origin: 'https://painel.casa.lan', 'X-CSRF-Token': t.loginToken }, body: { password: SENHA } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers['set-cookie'][0], /^__Host-asc_admin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    const bad = await t.req('POST', '/api/admin/session', { host: 'painel.casa.lan', headers: { Origin: 'http://painel.casa.lan', 'X-CSRF-Token': t.loginToken }, body: { password: SENHA } });
    assert.equal(bad.status, 403, 'Origin http:// não vale para o painel https');
    assert.equal((await t.req('GET', '/api/admin/session', { host: t.lanHost })).status, 403, 'o Host http da LAN não existe neste modo');
    // X-Forwarded-* nunca muda Host nem Origin
    const fwd = await t.req('GET', '/api/admin/session', { host: 'evil.example.com', headers: { 'X-Forwarded-Host': 'painel.casa.lan', Forwarded: 'host=painel.casa.lan' } });
    assert.equal(fwd.status, 403);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- terminal
const ioOf = (extra = {}) => {
  const lines = []; const errs = [];
  return { lines, errs, io: { out: (x) => lines.push(x), err: (x) => errs.push(x), tty: false, secret: async () => '', confirm: async () => true, ...extra } };
};

test('terminal: definir/gerar/status/remover, senha nunca em argumento nem no status', async () => {
  const dir = tmpdir('adm-cli-');
  const env = { DATA_DIR: dir, ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: '192.168.1.20' };
  let a = ioOf();
  assert.equal(await cli.run(['definir'], { env, io: a.io }), 2, 'sem terminal e sem arquivo: não espera entrada');
  const pw = path.join(tmpdir('adm-cli-pw-'), 'p');
  fs.writeFileSync(pw, 'curta');
  assert.equal(await cli.run(['definir', '--senha-arquivo', pw], { env, io: ioOf().io }), 1, 'senha fraca recusada');
  fs.writeFileSync(pw, SENHA);
  a = ioOf();
  assert.equal(await cli.run(['definir', '--senha-arquivo', pw], { env, io: a.io }), 0);
  a = ioOf();
  assert.equal(await cli.run(['status', '--json'], { env, io: a.io, interfaces: NET }), 0);
  assert.ok(!a.lines.join('').includes(SENHA));
  assert.equal(JSON.parse(a.lines[0]).passwordDefined, true);
  assert.equal(JSON.parse(a.lines[0]).enabled, false, 'definir a senha não ativa nada');
  const tty = ioOf({ tty: true, secret: (() => { const q = [SENHA, 'diferente-diferente-1']; return async () => q.shift(); })() });
  assert.equal(await cli.run(['definir', '--trocar'], { env, io: tty.io }), 1, 'confirmação diferente não grava');
  a = ioOf();
  assert.equal(await cli.run(['gerar', '--trocar'], { env, io: a.io }), 0);
  const gerada = a.lines[1];
  assert.ok(gerada.length >= 20);
  assert.equal(await new auth.AdminCredential({ dataDir: dir }).verify(gerada), true);
  assert.equal(await cli.run(['remover'], { env, io: ioOf().io }), 0);
  assert.equal(fs.existsSync(auth.filePath(dir)), false);
  assert.equal(await cli.run(['nada'], { env, io: ioOf().io }), 2);
});

test('terminal: primeira provisão concorrente tem um só vencedor', async () => {
  const dir = tmpdir('adm-race-');
  const env = { DATA_DIR: dir };
  const pw = path.join(tmpdir('adm-race-pw-'), 'p');
  fs.writeFileSync(pw, SENHA);
  const codes = await Promise.all(Array.from({ length: 6 }, () => cli.run(['definir', '--senha-arquivo', pw], { env, io: ioOf().io })));
  assert.equal(codes.filter((c) => c === 0).length, 1, JSON.stringify(codes));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'sem lixo temporário');
});

test('terminal: ativar confere as pré-condições, mostra o que muda e só grava com confirmação (aplicativo parado)', async () => {
  const dir = tmpdir('adm-on-');
  const env = { DATA_DIR: dir, ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: '192.168.1.20' };
  let a = ioOf();
  assert.equal(await cli.run(['ativar', '--http-claro', '--sim'], { env, io: a.io, interfaces: NET }), 1, 'sem senha');
  assert.match(a.errs.join('\n'), /senha de administração/);
  const pw = path.join(tmpdir('adm-on-pw-'), 'p');
  fs.writeFileSync(pw, SENHA);
  await cli.run(['definir', '--senha-arquivo', pw], { env, io: ioOf().io });
  assert.equal(await cli.run(['ativar'], { env, io: ioOf().io, interfaces: NET }), 2, 'exige escolher o transporte');
  a = ioOf();
  assert.equal(await cli.run(['ativar', '--http-claro'], { env, io: a.io, interfaces: NET }), 2, 'sem terminal e sem --sim não grava');
  assert.match(a.lines.join('\n'), /RISCO: HTTP sem criptografia/);
  assert.match(a.lines.join('\n'), /inclusive em 127\.0\.0\.1/);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
  a = ioOf();
  assert.equal(await cli.run(['ativar', '--http-claro', '--sim'], { env, io: a.io, interfaces: NET }), 0, a.errs.join());
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.ok(JSON.stringify(saved).includes('CONFIG_ALLOW_LAN'));
  assert.ok(!JSON.stringify(saved).includes(SENHA));
  a = ioOf();
  assert.equal(await cli.run(['status', '--json'], { env, io: a.io, interfaces: NET }), 0);
  assert.equal(JSON.parse(a.lines[0]).enabled, true);
  assert.equal(await cli.run(['desativar', '--sim'], { env, io: ioOf().io, interfaces: NET }), 0);
  a = ioOf();
  await cli.run(['status', '--json'], { env, io: a.io, interfaces: NET });
  assert.equal(JSON.parse(a.lines[0]).enabled, false);
  assert.equal(await cli.run(['ativar', '--http-claro', '--sim'], { env: { DATA_DIR: dir }, io: ioOf().io, interfaces: NET }), 1, 'modo local não ativa');
});
