const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger } = require('../src/logger');
const { snapshot, createDemoPanel, seedDemoLogs } = require('../scripts/demo-capturas');

test('demonstração mantém resumo coerente com os títulos fictícios, sem ações reais', () => {
  const dados = snapshot();
  const pendentes = dados.titles.filter(t => t.state === 'seeding');
  assert.equal(dados.summary.total, dados.titles.length);
  assert.equal(dados.summary.pending, pendentes.length);
  assert.equal(dados.account.pendingSeeds, pendentes.length);
  assert.equal(dados.summary.hoursPending, pendentes.reduce((soma, t) => soma + t.requiredHours - t.seededHours, 0));
  assert.equal(dados.summary.done, dados.titles.filter(t => t.state === 'done').length);
  assert.equal(dados.summary.diskUsed, dados.titles.reduce((soma, t) => soma + t.diskBytes, 0));
  assert.ok(dados.titles.every(t => t.name.endsWith('— demonstração')));
  assert.ok(dados.titles.every(t => /^[a-d]{40}$/.test(t.infoHash)));
  assert.equal(dados.traffic.length, 60);
  assert.ok(pendentes.every(t => t.tracker.remainingHours === t.requiredHours - t.seededHours));
  assert.equal(dados.titles.find(t => t.state === 'done').tracker.satisfied, true);
  assert.equal(dados.titles.find(t => t.state === 'completing').completedAt, null);
});

test('assistente de demonstração usa esquema real, hostname fictício e nenhuma interface pessoal', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-demo-teste-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const estado = createDemoPanel(dataDir).state();
  assert.equal(estado.ok, true);
  assert.equal(estado.hostname, 'computador-demo');
  assert.deepEqual(estado.network.list, []);
  assert.equal(estado.wizard.completed, false);
  assert.deepEqual(estado.credentials, []);
  assert.ok(estado.options.find(o => o.key === 'ASCSTREMIO_MODE').editable);
  assert.ok(estado.options.find(o => o.key === 'AFTER_SEED').editable);
});

test('logs de demonstração mostram eventos e avisos sem dados reais ou torrents', () => {
  const logs = new Logger();
  seedDemoLogs(logs);
  assert.ok(logs.entries.some(e => e.level === 'warn'));
  assert.ok(logs.entries.some(e => e.src === 'hnr'));
  assert.ok(logs.entries.every(e => e.data === undefined));
  assert.ok(!JSON.stringify(logs.entries).includes(os.homedir()));
  assert.match(logs.entries.at(-1).msg, /nenhum torrent foi aberto ou anunciado/);
});
