'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventariar } = require('../scripts/license-inventory');

test('inventário distingue candidatos de componentes instalados e preserva avisos e binários', t => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-licencas-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  fs.writeFileSync(path.join(raiz, 'package-lock.json'), JSON.stringify({ packages: {
    '': {}, 'node_modules/exemplo': { version: '1.0.0', license: 'MIT', resolved: 'https://example.invalid/exemplo.tgz' },
    'node_modules/opcional': { version: '2.0.0', optional: true }, 'node_modules/desenvolvimento': { version: '3', dev: true }
  } }));
  const pasta = path.join(raiz, 'node_modules', 'exemplo');
  fs.mkdirSync(path.join(pasta, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(pasta, 'package.json'), '{}');
  fs.writeFileSync(path.join(pasta, 'vendor', 'LICENSE.txt'), 'Aviso de terceiro');
  fs.writeFileSync(path.join(pasta, 'addon.node'), 'binário sintético');
  fs.writeFileSync(path.join(pasta, 'vendor', 'libexemplo.so.1.2'), 'biblioteca sintética');
  assert.equal(inventariar(raiz).componentes.length, 2);
  const resultado = inventariar(raiz, { instalado: true });
  assert.equal(resultado.componentes.length, 1);
  assert.deepEqual(resultado.componentes[0].textos, ['node_modules/exemplo/vendor/LICENSE.txt']);
  assert.equal(resultado.componentes[0].binarios.length, 2);
  assert.match(resultado.componentes[0].binarios[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(resultado.pendencias.join(' '), /não substitui/);
});
