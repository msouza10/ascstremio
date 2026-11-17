const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createAddon } = require('../src/addon');
const { createAddonServer } = require('../src/addon-server');
const { CredentialStore } = require('../src/credentials');
const { tmpdir } = require('./tmp-helper');

async function ambiente(t) {
  const consultas = [];
  // Só a descoberta remota é simulada; autenticação, SDK e transporte HTTP são reais.
  const remote = {
    async lookup(video) {
      consultas.push(video);
      return { streams: [{ name: 'Vídeo sintético', url: 'http://127.0.0.1:1/video.mp4' }], offline: null };
    },
  };
  const addon = createAddon({ remote });
  const store = new CredentialStore({ file: path.join(tmpdir('stremio-protocolo-'), 'credentials.json') });
  const emitida = store.create({ name: 'Cliente de teste' });
  const server = createAddonServer({ addon, credentials: store });
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const consultar = (rota) => fetch(`${base}/${emitida.token}/${rota}`, { signal: AbortSignal.timeout(3000) });
  return { base, consultar, consultas, store, emitida };
}

test('protocolo Stremio: manifesto autenticado e catálogo local vazio por HTTP', async (t) => {
  const { consultar, consultas } = await ambiente(t);
  const response = await consultar('manifest.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const manifest = await response.json();
  assert.ok(manifest.resources.includes('stream'));
  assert.ok(manifest.types.includes('series'));
  assert.ok(!manifest.catalogs.some((catalog) => catalog.id === 'asc-status'));
  const catalog = manifest.catalogs.find((item) => item.type === 'movie' && item.id === 'asc');
  assert.ok(catalog);
  const result = await consultar(`catalog/${catalog.type}/${catalog.id}.json`);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).metas, []);
  assert.equal(consultas.length, 0);
});

test('protocolo Stremio: ausência e revogação da credencial bloqueiam antes da descoberta', async (t) => {
  const { base, consultar, consultas, store, emitida } = await ambiente(t);
  const semToken = await fetch(`${base}/stream/movie/tt1234567.json`, { signal: AbortSignal.timeout(3000) });
  assert.equal(semToken.status, 403);
  await semToken.arrayBuffer();
  store.revoke(emitida.credential.id);
  for (const route of ['manifest.json', 'stream/movie/tt1234567.json']) {
    const result = await consultar(route);
    assert.equal(result.status, 403);
    await result.arrayBuffer();
  }
  assert.equal(consultas.length, 0);
});

test('protocolo Stremio: o SDK preserva temporada e episódio no pedido HTTP', async (t) => {
  const { consultar, consultas } = await ambiente(t);
  const response = await consultar('stream/series/tt1234567:2:3.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual((await response.json()).streams, [{ name: 'Vídeo sintético', url: 'http://127.0.0.1:1/video.mp4' }]);
  assert.deepEqual(consultas, [{ type: 'series', imdbId: 'tt1234567', season: 2, episode: 3 }]);
});

test('servidor compartilhado: Host DNS indevido é recusado antes do provedor', async (t) => {
  const { base, emitida, consultas } = await ambiente(t);
  const response = await new Promise((resolve, reject) => {
    http.get(`${base}/${emitida.token}/stream/movie/tt1234567.json`, { headers: { Host: 'site-hostil.invalid' } }, (res) => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    }).once('error', reject);
  });
  assert.equal(response, 403);
  assert.equal(consultas.length, 0);
});
