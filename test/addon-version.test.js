const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAddon } = require('../src/addon');
const pkg = require('../package.json');

// O Stremio mostra a versão do manifesto ao usuário; ela tem de ser a da release instalada.
test('addon: a versão do manifesto vem do package.json', () => {
  const addon = createAddon({});
  assert.equal(addon.manifest.version, pkg.version);
  assert.match(addon.manifest.version, /^\d+\.\d+\.\d+$/);
});
