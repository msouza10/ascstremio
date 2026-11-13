const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createAddonActivity, kindOf } = require('../src/addon-activity');
const { createAddonHandler } = require('../src/addon-auth');
const { CredentialStore } = require('../src/credentials');
const { tmpdir } = require('./tmp-helper');

test('kindOf: só manifesto, catálogo, meta e stream contam', () => {
  assert.equal(kindOf('/manifest.json'), 'manifest');
  assert.equal(kindOf('/catalog/movie/x.json'), 'catalog');
  assert.equal(kindOf('/meta/movie/tt1.json'), 'meta');
  assert.equal(kindOf('/stream/movie/tt1.json'), 'stream');
  assert.equal(kindOf('/status/poster/a.png'), null);
});

test('estado é conservador: manifesto sozinho não prova instalação', () => {
  let t = Date.parse('2026-11-12T10:00:00Z');
  const a = createAddonActivity({ now: () => t });
  assert.equal(a.get('c1').state, 'aguardando');
  assert.equal(a.get('c1').lastSeenAt, null);
  a.record('c1', '/manifest.json');
  assert.equal(a.get('c1').state, 'manifesto_lido');
  t += 5000;
  a.record('c1', '/catalog/movie/x.json');
  assert.equal(a.get('c1').state, 'instalado');
  assert.equal(a.get('c1').lastSeenAt, '2026-11-12T10:00:05.000Z');
  a.record('c1', '/stream/movie/tt1.json');
  assert.equal(a.get('c1').state, 'em_uso');
  assert.equal(a.get('c2').state, 'aguardando', 'outra credencial não herda o sinal');
});

test('addon-auth registra só GET de credencial válida', () => {
  const store = new CredentialStore({ file: path.join(tmpdir('activity-'), 'credentials.json') });
  const { token, credential } = store.create({ name: 'Teste', status: false });
  const activity = createAddonActivity();
  const handler = createAddonHandler({ addon: { manifest: { catalogs: [], idPrefixes: [] } }, router: (req, res) => { res.writeHead(200); res.end(); }, store, activity });
  const res = () => ({ writeHead() {}, end() {} });

  handler({ method: 'HEAD', url: `/${token}/manifest.json` }, res());
  assert.equal(activity.get(credential.id).state, 'aguardando');
  handler({ method: 'GET', url: `/ascc_${'x'.repeat(43)}/manifest.json` }, res());
  assert.equal(activity.get(credential.id).state, 'aguardando');
  handler({ method: 'GET', url: `/${token}/manifest.json` }, res());
  assert.equal(activity.get(credential.id).state, 'manifesto_lido');
  handler({ method: 'GET', url: `/${token}/catalog/movie/asc.json` }, res());
  assert.equal(activity.get(credential.id).state, 'instalado');
});
