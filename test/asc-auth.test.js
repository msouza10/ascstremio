const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AscClient } = require('../src/asc-client');

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}
const html = props => `<script type="application/json" data-page="app">${JSON.stringify({ props })}</script>`;

test('login captura CSRF, persiste cookie rotacionado, nunca a senha; restaura sessão', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asc-auth-'));
  const file = path.join(dir, 'session.json');
  const calls = [];
  const asc = new AscClient({ stateFile: file, delay: 0, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response('login', 200, { 'Set-Cookie': 'XSRF-TOKEN=abc%3D; Path=/; Secure' });
    if (calls.length === 2) {
      assert.equal(options.headers['X-XSRF-TOKEN'], 'abc=');
      assert.match(options.headers.Cookie, /XSRF-TOKEN=abc%3D/);
      assert.deepEqual(JSON.parse(options.body), { username: 'example', password: 'test-secret', remember: true });
      return response('{}', 200, { 'Set-Cookie': 'session=rotated; Path=/; HttpOnly; Secure' });
    }
    assert.match(options.headers.Cookie, /session=rotated/);
    return response(html({ auth: { user: { id: 42 } } }));
  } });
  try {
    assert.equal((await asc.login('example', 'test-secret', true)).connected, true);
    const saved = await fs.readFile(file, 'utf8');
    assert.ok(!saved.includes('test-secret'));
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const restored = new AscClient({ stateFile: file, delay: 0 });
    await restored.load();
    assert.match(await restored.jar.getCookieString('https://amigos-share.club/dashboard'), /session=rotated/);
    await restored.logout();
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('não envia credenciais ao destino de redirect externo', async () => {
  let calls = 0;
  const asc = new AscClient({ delay: 0, fetchImpl: async () => {
    calls++;
    return response('', 307, { Location: 'https://example.org/steal' });
  } });
  await assert.rejects(asc.request('/login', { method: 'POST', body: 'secret' }), /Redirecionamento inesperado/);
  assert.equal(calls, 1);
});

test('sessão expirada é erro, não lista vazia', async () => {
  const asc = new AscClient({ delay: 0, fetchImpl: async () => response('', 302, { Location: '/login' }) });
  await assert.rejects(asc.search('tt123'), /Sessão expirada/);
  assert.equal(asc.connected, false);
});

test('busca verifica freeleech estrito e envia filtro; não aceita campo desconhecido', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asc-search-'));
  const asc = new AscClient({ stateFile: path.join(dir, 'session.json'), delay: 0, fetchImpl: async url => {
    assert.equal(new URL(url).searchParams.get('freeleech'), '1');
    return response(html({ torrents: { data: [
      { id: 1, name: 'A', freeleech: true }, { id: 2, name: 'B', freeleech: false },
      { id: 3, name: 'C', freeleech: 'true' }, { id: 4, name: 'D' },
    ] } }));
  } });
  try { assert.deepEqual((await asc.search()).map(item => item.id), [1]); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('login recusado não armazena credenciais nem confirma sessão', async () => {
  let calls = 0;
  const asc = new AscClient({ delay: 0, fetchImpl: async () => ++calls === 1
    ? response('login', 200, { 'Set-Cookie': 'XSRF-TOKEN=csrf; Path=/' })
    : response('{"password":"secret"}', 422) });
  await assert.rejects(asc.login('name', 'secret', true), /Login não aceito/);
  assert.equal(asc.connected, false);
  assert.equal(await asc.jar.getCookieString('https://amigos-share.club'), '');
});

test('aviso de inatividade: silencioso até 60 dias, alerta depois, e cobra data desconhecida', () => {
  const { inactivityNotice } = require('../src/safety');
  const now = Date.parse('2026-11-08T00:00:00Z');
  const dias = n => new Date(now - n * 86_400_000).toISOString();
  assert.equal(inactivityNotice(dias(10), now), null);
  assert.match(inactivityNotice(dias(65), now), /65 dias/);
  assert.match(inactivityNotice(dias(95), now), /agora/);
  assert.match(inactivityNotice(null, now), /desconhecida/);
});

test('login grava lastLoginAt e falha de login não o altera', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asc-login-at-'));
  const file = path.join(dir, 'session.json');
  let calls = 0;
  const asc = new AscClient({ stateFile: file, delay: 0, fetchImpl: async () => {
    calls++;
    if (calls === 1) return response('login', 200, { 'Set-Cookie': 'XSRF-TOKEN=abc; Path=/' });
    if (calls === 2) return response('{}', 200);
    return response(html({ auth: { user: { id: 1 } } }));
  } });
  try {
    await asc.login('u', 'p', true);
    assert.ok(Date.parse(asc.lastLoginAt) > Date.now() - 5000);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).lastLoginAt, asc.lastLoginAt);
    assert.equal(asc.status().notice, null);
    const restored = new AscClient({ stateFile: file, delay: 0 });
    await restored.load();
    assert.equal(restored.lastLoginAt, asc.lastLoginAt);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }

  const falha = new AscClient({ delay: 0, fetchImpl: async () => { throw new Error('x'); } });
  falha.lastLoginAt = '2026-01-01T00:00:00.000Z';
  await assert.rejects(falha.login('u', 'p', true));
  assert.equal(falha.lastLoginAt, '2026-01-01T00:00:00.000Z');
});
