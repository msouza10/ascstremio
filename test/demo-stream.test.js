const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAddon } = require('../src/addon');

// O DEMO_MODE existe para testar o Stremio sem conta nem tracker. A URL antiga (um bucket de terceiros)
// passou a responder 403 e ninguém avisava: a fonte de demonstração tem de vir de um host público
// verificado e carregar a atribuição que a licença CC BY 3.0 do filme exige.
test('DEMO_MODE: a fonte do Big Buck Bunny vem da Wikimedia Commons, em HTTPS, com a atribuição CC BY 3.0', async () => {
  const addon = createAddon({ demo: true });
  const { streams } = await addon.get('stream', 'movie', 'tt1254207', {});
  assert.equal(streams.length, 1);
  const url = new URL(streams[0].url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'upload.wikimedia.org');
  assert.match(streams[0].description, /Blender Foundation/);
  assert.match(streams[0].description, /CC BY 3\.0/);
  assert.ok(!streams[0].url.includes('gtv-videos-bucket'), 'o bucket antigo responde 403');
});

test('sem DEMO_MODE não há fonte de demonstração, nem para o filme da demonstração', async () => {
  const addon = createAddon({ demo: false, remote: { lookup: async () => ({ streams: [] }) } });
  const { streams } = await addon.get('stream', 'movie', 'tt1254207', {});
  assert.ok(!streams.some((s) => /Demonstra/i.test(s.name ?? '')));
});
