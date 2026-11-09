const test = require('node:test');
const assert = require('node:assert/strict');
const { bridgeHost, configHost, isLoopbackAddress, inContainer } = require('../src/safety');
const { defaultCommand } = require('../src/keepawake');

const CT = { ASCSTREMIO_CONTAINER: '1' };

test('fora do contêiner tudo escuta só em loopback e só loopback é local', () => {
  assert.equal(inContainer({}), false);
  assert.equal(bridgeHost({}), '127.0.0.1');
  assert.equal(configHost({}), '127.0.0.1');
  assert.equal(isLoopbackAddress('172.17.0.1', {}), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1', {}), true);
});

test('no contêiner escuta em 0.0.0.0, mas endereço privado não conta como local', () => {
  assert.equal(bridgeHost(CT), '0.0.0.0');
  assert.equal(configHost(CT), '0.0.0.0');
  assert.equal(isLoopbackAddress('::ffff:172.17.0.1'), false);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('8.8.8.8', CT), false);
});

test('KeepAwake escolhe o inibidor de cada sistema e nada no contêiner', () => {
  const win = defaultCommand('x', 99, 'win32');
  assert.equal(win[0], 'powershell.exe');
  assert.match(win[1].join(' '), /SetThreadExecutionState/);
  assert.match(win[1].join(' '), /-Id 99/);
  assert.equal(defaultCommand('x', 99, 'freebsd'), null);
  process.env.ASCSTREMIO_CONTAINER = '1';
  try { assert.equal(defaultCommand('x', 99, 'win32'), null); } finally { delete process.env.ASCSTREMIO_CONTAINER; }
});

const { hostAllowed } = require('../src/safety');
const { Bridge } = require('../src/bridge');

test('Host: IP literal e localhost passam; nome DNS (rebinding) não, salvo autorizado', () => {
  for (const h of ['127.0.0.1:7010', 'localhost:7010', '192.168.0.5:7000', '[::1]:7010']) assert.equal(hostAllowed(h, {}), true, h);
  for (const h of ['evil.example.com', 'evil.example.com:7010', '', undefined, '127.0.0.1.evil.com']) assert.equal(hostAllowed(h, {}), false, String(h));
  assert.equal(hostAllowed('nas.casa:7010', { ALLOWED_HOSTS: 'nas.casa' }), true);
  assert.equal(hostAllowed('nas.casa', { BRIDGE_PUBLIC_URL: 'http://nas.casa:7010' }), true);
});

test('ponte: chave nas URLs e recusa de /a/ e /s/ sem ela; Host estranho recusado', async () => {
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', port: 7097, publicUrl: 'http://127.0.0.1:7097', accessKey: 'ab'.repeat(16), strictHost: true });
  assert.match(b.lazyUrl(12), /\/a\/12\?k=abab/);
  assert.match(b.urlFor('a'.repeat(40), 0), /\/s\/a{40}\/0\?k=abab/);
  const call = async (path, host = '127.0.0.1:7097') => {
    const out = { status: 0 };
    await b.handle({ method: 'GET', url: path, headers: { host }, socket: { remoteAddress: '127.0.0.1' } },
      { setHeader() {}, once() {}, writeHead(s) { out.status = s; }, end() {}, statusCode: 0 });
    return out.status;
  };
  assert.equal(await call('/a/12'), 403);
  assert.equal(await call('/a/12?k=errada'), 403);
  assert.equal(await call(`/s/${'a'.repeat(40)}/0`), 403);
  assert.equal(await call('/health', 'evil.example.com'), 403);
});
