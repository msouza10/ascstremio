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

// Fixture fiel ao caso real: o lockfile v3 não traz `license`; ela só existe no package.json instalado.
function montar(t, pacotes) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-licencas-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const lock = { lockfileVersion: 3, packages: { '': {} } };
  for (const [nome, { manifesto, arquivos = {} }] of Object.entries(pacotes)) {
    lock.packages[`node_modules/${nome}`] = { version: '1.0.0' };
    const pasta = path.join(raiz, 'node_modules', nome);
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({ name: nome, version: '1.0.0', ...manifesto }));
    for (const [arq, texto] of Object.entries(arquivos)) fs.writeFileSync(path.join(pasta, arq), texto);
  }
  fs.writeFileSync(path.join(raiz, 'package-lock.json'), JSON.stringify(lock));
  return raiz;
}

test('modo instalado lê a licença do package.json instalado (string, objeto e licenses[] legados)', t => {
  const raiz = montar(t, {
    a: { manifesto: { license: 'MIT' }, arquivos: { LICENSE: 'x' } },
    b: { manifesto: { license: { type: 'ISC' } }, arquivos: { LICENSE: 'x' } },
    c: { manifesto: { licenses: [{ type: 'MIT' }] }, arquivos: { LICENSE: 'x' } }
  });
  const por = Object.fromEntries(inventariar(raiz, { instalado: true }).componentes.map(c => [c.nome, c]));
  assert.equal(por.a.licencaDeclarada, 'MIT');
  assert.equal(por.b.licencaDeclarada, 'ISC');
  assert.equal(por.c.licencaDeclarada, 'MIT');
  assert.ok(por.b.atencao.includes('campo-legado'));
  assert.ok(por.c.atencao.includes('campo-legado'));
  assert.deepEqual(por.a.atencao, []);
});

test('só-lockfile sem licença declara explicitamente que ela é desconhecida', t => {
  const raiz = montar(t, { a: { manifesto: { license: 'MIT' } } });
  const [c] = inventariar(raiz).componentes;
  assert.equal(c.licencaDeclarada, 'desconhecida');
  assert.ok(c.atencao.includes('licenca-desconhecida'));
});

test('sinaliza para revisão copyleft, licença composta, incomum, ausente e falta de texto', t => {
  const raiz = montar(t, {
    ok: { manifesto: { license: 'Apache-2.0' }, arquivos: { 'LICENSE.md': 'x' } },
    mpl: { manifesto: { license: 'MPL-2.0' }, arquivos: { LICENSE: 'x' } },
    dupla: { manifesto: { license: '(MIT OR WTFPL)' }, arquivos: { LICENSE: 'x' } },
    rara: { manifesto: { license: 'BlueOak-1.0.0' }, arquivos: { LICENSE: 'x' } },
    sem: { manifesto: { license: 'MIT' } },
    nada: { manifesto: {}, arquivos: { LICENSE: 'x' } }
  });
  const r = inventariar(raiz, { instalado: true });
  const motivos = Object.fromEntries(r.atencao.map(a => [a.nome, a.motivos]));
  assert.equal(motivos.ok, undefined);
  assert.deepEqual(motivos.mpl, ['copyleft-fraco']);
  assert.deepEqual(motivos.dupla, ['licenca-composta']);
  assert.deepEqual(motivos.rara, ['licenca-incomum']);
  assert.deepEqual(motivos.sem, ['sem-texto-de-licenca']);
  assert.deepEqual(motivos.nada, ['licenca-desconhecida']);
  assert.match(r.pendencias.join(' '), /requer revisão/i);
});

test('inventário é determinístico e não vazio para o lockfile real do repositório', () => {
  const raiz = path.join(__dirname, '..');
  const a = JSON.stringify(inventariar(raiz));
  assert.equal(a, JSON.stringify(inventariar(raiz)));
  assert.ok(inventariar(raiz).componentes.length > 0);
});

test('a distribuição gera o inventário e a fonte Inter acompanha o texto da OFL', () => {
  const raiz = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(raiz, 'scripts', 'build-release.sh'), 'utf8'), /license-inventory\.js \. .*THIRD-PARTY-INVENTORY\.json/);
  const ofl = fs.readFileSync(path.join(raiz, 'src', 'ui', 'assets', 'INTER-LICENSE.txt'), 'utf8');
  assert.match(ofl, /Copyright \(c\) 2016 The Inter Project Authors/);
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
});
