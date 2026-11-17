const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('./tmp-helper');
const { iniciarFixture } = require('../scripts/stremio-ui-fixture');

async function fixtureLocal(t) {
  const dir = tmpdir('stremio-http-');
  const video = path.join(dir, 'video.mp4');
  fs.writeFileSync(video, Buffer.from('0123456789'));
  const fixture = await iniciarFixture({ dir, video, mode: 'local' });
  t.after(() => fixture.close());
  const base = fixture.manifestUrl.slice(0, -'manifest.json'.length);
  const consultar = (route, opts = {}) => fetch(base + route, { ...opts, signal: AbortSignal.timeout(3000) });
  return { ...fixture, consultar };
}

test('integração local: escuta real e URLs permanecem em loopback', async (t) => {
  const f = await fixtureLocal(t);
  assert.equal(f.bindings.addon, '127.0.0.1');
  assert.equal(f.bindings.bridge, '127.0.0.1');
  assert.equal(new URL(f.manifestUrl).hostname, '127.0.0.1');
  const catalog = await f.consultar('catalog/movie/asc-online.json');
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).metas.length, 2);
  const pesquisa = await f.consultar('catalog/movie/asc-online/search=Aurora.json');
  assert.deepEqual((await pesquisa.json()).metas.map((item) => item.name), [f.TITULO]);
  assert.equal(f.calls.downloads, 0);
  assert.equal(f.calls.aberturas, 0);
});

test('fonte gerada pelo provedor → ponte: HEAD, Range, 416 e revogação', async (t) => {
  const f = await fixtureLocal(t);
  // O provedor registra o release ao consultar o catálogo, como no cliente real.
  await (await f.consultar('catalog/movie/asc-online.json')).arrayBuffer();
  const response = await f.consultar('stream/movie/ascfilm:1.json');
  const { streams } = await response.json();
  assert.equal(streams.length, 1);
  const url = streams[0].url;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(f.calls.aberturas, 0, 'sondagem do player não abre motor');
  const range = await fetch(url, { headers: { Range: 'bytes=2-5' }, signal: AbortSignal.timeout(3000) });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await range.text(), '2345');
  const invalid = await fetch(url, { headers: { Range: 'bytes=100-' }, signal: AbortSignal.timeout(3000) });
  assert.equal(invalid.status, 416);
  await invalid.arrayBuffer();
  f.revogar();
  const revoked = await fetch(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(revoked.status, 403);
  await revoked.arrayBuffer();
  assert.equal(f.calls.downloads, 0);
});
