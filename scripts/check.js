#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const uiFiles = ['app', 'views', 'logs', 'settings-model', 'settings', 'admin'];

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error('Não foi possível iniciar a verificação.'); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const unitOnly = process.argv.slice(2).includes('--unit');
if (process.argv.slice(2).some((arg) => arg !== '--unit')) {
  console.error('Uso: node scripts/check.js [--unit]');
  process.exit(1);
}

for (const name of uiFiles) run(['--check', `src/ui/${name}.js`]);
run(['scripts/check-docs.js']);
const tests = fs.readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.js')).sort();
run(['--test', ...tests.map((name) => `test/${name}`)]);

if (!unitOnly) {
  if (process.platform !== 'linux') {
    // A matriz de sistemas mantém os testes compartilhados; o cliente nativo tem job Linux próprio.
    console.error('Stremio nativo: adaptador disponível somente no Linux. A suíte gráfica roda no job Linux do CI.');
  } else {
    console.log('Verificando agora a interface oficial do Stremio instalado, sem conta.');
    const native = fs.readdirSync(path.join(root, 'test/integration/stremio')).filter((name) => name.endsWith('.test.js')).sort();
    if (!native.length) { console.error('Suíte do Stremio ausente.'); process.exit(1); }
    run(['--test', ...native.map((name) => `test/integration/stremio/${name}`)]);
  }
}
