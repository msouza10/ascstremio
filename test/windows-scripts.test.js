const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareScripts } = require('../windows/prepare-scripts');
const { tmpdir } = require('./tmp-helper');

test('pacote Windows prepara todos os atalhos com CRLF, sem BOM e sem alterar outros arquivos', () => {
  const stage = tmpdir('scripts-windows-');
  const source = path.join(__dirname, '..', 'windows');
  const scripts = fs.readdirSync(source).filter((name) => /\.(cmd|vbs)$/i.test(name));
  for (const name of scripts) fs.copyFileSync(path.join(source, name), path.join(stage, name));
  const binary = Buffer.from([0, 10, 13, 255]);
  fs.writeFileSync(path.join(stage, 'node.exe'), binary);
  prepareScripts(stage);
  for (const name of scripts) {
    const prepared = fs.readFileSync(path.join(stage, name), 'utf8');
    const original = fs.readFileSync(path.join(source, name), 'utf8');
    assert.equal(prepared.replace(/\r\n/g, '\n'), original.replace(/\r\n/g, '\n'), name);
    assert.ok(prepared.includes('\r\n'), name);
    assert.doesNotMatch(prepared, /(?<!\r)\n/, name);
    assert.ok(!prepared.startsWith('\ufeff'), name);
  }
  assert.deepEqual(fs.readFileSync(path.join(stage, 'node.exe')), binary);
  const before = fs.readFileSync(path.join(stage, 'credenciais.cmd'));
  prepareScripts(stage);
  assert.deepEqual(fs.readFileSync(path.join(stage, 'credenciais.cmd')), before, 'normalização idempotente');
});
