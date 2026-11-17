const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { startConfig } = require('../src/config-server');
const { Logger } = require('../src/logger');
const settings = require('../src/settings');
const { tmpdir } = require('./tmp-helper');

function request(port, route, { host = '127.0.0.1:0', method = 'GET', origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { Host: host, ...(origin ? { Origin: origin } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json; try { json = JSON.parse(text); } catch { /* texto para download */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject); req.end();
  });
}

async function setup(t) {
  const dir = tmpdir('logs-export-');
  const logs = new Logger({ dir, level: 'debug', now: () => 1_800_000_000_000 });
  logs.openDir();
  const secret = 'segredo-do-webhook-sintetico';
  logs.addSecret(secret);
  logs.child('app').info('Filme Privado em /home/pessoa/video.mkv', { infoHash: 'f'.repeat(40), password: secret });
  logs.child('ponte').warn(`Filme Privado: /home/pessoa/video.mkv ${secret}`);
  const server = await startConfig({ connected: false, status: () => ({ connected: false }) }, 0, null, logs);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { dir, logs, port: server.address().port, secret };
}

test('prévia HTTP: suporte omite conteúdo e horário absoluto, preserva filtros e informa retenção', async (t) => {
  const { port } = await setup(t);
  const r = await request(port, '/api/logs/preview?formato=ndjson&modo=suporte&nivel=warn&fonte=ponte');
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'suporte');
  assert.equal(r.json.count, 1);
  assert.equal(r.json.retentionDays, 14);
  assert.deepEqual(JSON.parse(r.json.content.trim()), { decorridoMs: 0, level: 'warn', src: 'ponte' });
  for (const s of ['Filme Privado', '/home/pessoa', 'ffffffffff', '1800000000000', 'password']) assert.ok(!r.json.content.includes(s));
  assert.match(r.json.notice, /não.*anonimiz/i);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('suporte não permite conteúdo livre em fontes e dados adicionais', async (t) => {
  const { port, logs } = await setup(t);
  logs.child('Filme em pasta pessoal').error('Título sintético', { caminho: '/pasta/pessoal' });
  const r = await request(port, '/api/logs/preview?formato=ndjson&modo=suporte&nivel=error');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.json.content.trim()), { decorridoMs: 0, level: 'error', src: 'outros' });
});

test('prévia completa: txt/ndjson têm a mesma seleção e redação dos downloads', async (t) => {
  const { port, secret } = await setup(t);
  for (const formato of ['txt', 'ndjson']) {
    const params = `modo=completo&formato=${formato}&nivel=warn&fonte=ponte`;
    const r = await request(port, `/api/logs/preview?${params}`);
    assert.equal(r.status, 200);
    assert.match(r.json.content, /Filme Privado/);
    assert.ok(!r.json.content.includes(secret));
    assert.match(r.json.content, /redigido/);
    const download = await request(port, `/api/logs/download?${params}`);
    assert.equal(download.status, 200);
    assert.equal(download.text, r.json.content);
  }
});

test('arquivo legado: prévia/download redigem objetos e omitem linhas ilegíveis', async (t) => {
  const { port, dir, logs, secret } = await setup(t);
  const name = 'ascstremio-2026-01-01.log';
  // Credencial efêmera só da fixture: testa redação sem publicar uma senha literal.
  const legacyPassword = randomBytes(18).toString('base64url');
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ t: 1, level: 'warn', src: 'app', msg: `legado ${secret}`, data: { password: legacyPassword, cookie: 'cookie-legado' } }) + '\nlinha-inválida-com-segredo\n');
  const r = await request(port, `/api/logs/preview?nome=${name}&modo=completo&formato=ndjson`);
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 1);
  assert.equal(r.json.skippedLines, 1);
  assert.match(r.json.scope, /arquivo diário/i);
  const redigido = '[redigido]'; // marcador de redação; em variável para não parecer senha literal a scanners
  assert.deepEqual(JSON.parse(r.json.content.trim()).data, { password: redigido, cookie: redigido });
  for (const s of [secret, legacyPassword, 'cookie-legado', 'linha-inválida']) assert.ok(!r.json.content.includes(s));
  assert.equal((await request(port, `/api/logs/file?nome=${name}`)).text, r.json.content);
  logs.loadHistory();
  const live = await request(port, '/api/logs?limit=100');
  assert.ok(!live.text.includes(secret));
  assert.ok(!live.text.includes(legacyPassword));
});

test('prévia recusa caminhos, métodos, origens e opções inválidas, limita arquivos grandes', async (t) => {
  const { port, dir } = await setup(t);
  assert.equal((await request(port, '/api/logs/preview?nome=../asc-session.json')).status, 404);
  assert.equal((await request(port, '/api/logs/preview?modo=outro')).status, 400);
  assert.equal((await request(port, '/api/logs/preview?formato=html')).status, 400);
  assert.equal((await request(port, '/api/logs/preview', { method: 'POST' })).status, 405);
  assert.equal((await request(port, '/api/logs/preview', { host: 'evil.example' })).status, 403);
  assert.equal((await request(port, '/api/logs/preview', { origin: 'http://evil.example' })).status, 403);
  const name = 'ascstremio-1999-01-02.log';
  const fd = fs.openSync(path.join(dir, name), 'w');
  fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd);
  const huge = await request(port, `/api/logs/preview?nome=${name}`);
  assert.equal(huge.status, 413);
  assert.ok(!huge.text.includes(dir));
});

test('padrão info reduz detalhe, sem sobrescrever escolha explícita de debug', () => {
  const dataDir = tmpdir('logs-padrao-');
  assert.equal(settings.resolve({ dataDir, env: {} }).values.LOG_LEVEL, 'info');
  assert.equal(settings.resolve({ dataDir, env: { LOG_LEVEL: 'debug' } }).values.LOG_LEVEL, 'debug');
});

test('consulta não devolve segredo recém-registrado pela lista de fontes', async (t) => {
  const { port, logs } = await setup(t);
  const secret = 'fonte-sintetica-oculta';
  logs.child(secret).warn('evento sintético');
  logs.addSecret(secret);
  const r = await request(port, '/api/logs');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(secret));
});
