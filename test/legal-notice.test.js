const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { serveLegalNotice } = require('../src/legal-notice');
const { startConfig } = require('../src/config-server');
const { Logger } = require('../src/logger');
const { tmpdir } = require('./tmp-helper');

function response() {
  return {
    headers: {}, status: null, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(status, headers) { this.status = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); },
    end(body) { this.body = body; },
  };
}

test('aviso: serve bytes do artefato como texto, sem interpretar HTML nem alterar versão', () => {
  const root = tmpdir('aviso-');
  const content = Buffer.from('# Avisos\nVersão: teste\n<script>alert(1)</script>\nÁudio e ação.\n');
  fs.writeFileSync(path.join(root, 'LEGAL.md'), content);
  const res = response();
  serveLegalNotice({ method: 'GET' }, res, { root });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, content);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(res.headers['content-length'], content.length);
  assert.equal(res.headers['content-disposition'], 'inline');
  const head = response();
  serveLegalNotice({ method: 'HEAD' }, head, { root });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], content.length);
  assert.equal(head.body, undefined);
});

test('aviso: arquivo ausente dá erro claro sem expor caminho nem inventar texto/versão', () => {
  const root = tmpdir('aviso-ausente-');
  for (const method of ['GET', 'HEAD']) {
    const res = response();
    serveLegalNotice({ method }, res, { root });
    assert.equal(res.status, 503);
    if (method === 'HEAD') assert.equal(res.body, undefined);
    else {
      assert.match(res.body, /indisponíveis.*Reinstale/);
      assert.ok(!res.body.includes(root));
      assert.doesNotMatch(res.body, /Versão/);
    }
  }
});

test('aviso: métodos de alteração são recusados mesmo com arquivo ausente', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = response();
    serveLegalNotice({ method }, res, { root: tmpdir('aviso-metodo-') });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
});

function request(port, route, { host = '127.0.0.1:0', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('painel: aviso offline antes do login, recurso fixo e Host/CSP preservados', async (t) => {
  const asc = { connected: false, status() { throw new Error('Não deveria consultar a conta.'); } };
  const server = await startConfig(asc, 0, null, new Logger());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const expected = fs.readFileSync(path.join(__dirname, '..', 'LEGAL.md'));
  for (const route of ['/avisos-legais', '/avisos-legais?file=private/asc-session.json']) {
    const res = await request(port, route);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, expected);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
  const head = await request(port, '/avisos-legais', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), expected.length);
  assert.equal((await request(port, '/avisos-legais', { host: 'evil.example' })).status, 403);
  assert.equal((await request(port, '/avisos-legais', { method: 'POST' })).status, 405);
  for (const route of ['/avisos-legais/LEGAL.md', '/avisos-legais/..%2fprivate/asc-session.json', '/LEGAL.md']) {
    assert.equal((await request(port, route)).status, 404, route);
  }
  const shell = (await request(port, '/')).body.toString();
  assert.match(shell, /href="\/avisos-legais"[^>]*aria-label="Avisos legais \(nova aba\)"/);
});
