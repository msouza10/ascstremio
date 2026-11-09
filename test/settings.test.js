const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./tmp-helper');
const settings = require('../src/settings');

const novo = () => tmpdir('ascstremio-cfg-');
const arquivo = (dir) => path.join(dir, 'settings.json');

test('sem arquivo nem ambiente, os padrões são os de sempre e o modo é local', () => {
  const dir = novo();
  const s = settings.load({ dataDir: dir, env: {} });
  assert.equal(s.mode, 'local');
  assert.equal(s.derived.bindHost, '127.0.0.1');
  assert.equal(s.values.PORT, 7000);
  assert.equal(s.values.BRIDGE_PORT, 7010);
  assert.equal(s.values.CONFIG_PORT, 7020);
  assert.equal(s.values.AFTER_SEED, 'delete');
  assert.equal(s.values.BRIDGE_UPLOAD_LIMIT, -1);
  assert.equal(s.values.LOG_RETENTION_DAYS, 14);
  assert.equal(s.values.BRIDGE_STORE, path.join(dir, 'cache'));
  assert.equal(s.values.ASC_TORRENT_DIR, path.join(dir, 'torrents'));
  assert.equal(s.fileExists, false);
  assert.equal(fs.existsSync(arquivo(dir)), false, 'ler não cria arquivo');
});

test('só ambiente continua funcionando e é registrado como origem env', () => {
  const s = settings.load({ dataDir: novo(), env: { PORT: '18000', AFTER_SEED: 'KEEP', BRIDGE_ALLOW_LAN: '1', DEMO_MODE: 'true', BRIDGE_UPLOAD_LIMIT: '500000' } });
  assert.equal(s.values.PORT, 18000);
  assert.equal(s.values.AFTER_SEED, 'keep');
  assert.equal(s.values.DEMO_MODE, true);
  assert.equal(s.values.BRIDGE_UPLOAD_LIMIT, 500000);
  assert.equal(s.sources.PORT, 'env');
  assert.equal(s.mode, 'lan', 'BRIDGE_ALLOW_LAN=1 equivale a LAN');
  assert.equal(s.derived.bindHost, '0.0.0.0');
  assert.equal(s.sources.BACKGROUND_COMPLETE, 'default');
});

test('precedência: ambiente > arquivo > padrão; variável vazia conta como ausente', () => {
  const dir = novo();
  settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { PORT: 8000, AFTER_SEED: 'stop', BRIDGE_PORT: 8010 } });
  const s = settings.load({ dataDir: dir, env: { PORT: '9000', BRIDGE_PORT: '' } });
  assert.equal(s.values.PORT, 9000);
  assert.equal(s.sources.PORT, 'env');
  assert.equal(s.fileValues.PORT, 8000, 'o valor do arquivo continua visível sob o ambiente');
  assert.equal(s.values.BRIDGE_PORT, 8010);
  assert.equal(s.sources.BRIDGE_PORT, 'file');
  assert.equal(s.values.AFTER_SEED, 'stop');
  assert.equal(s.values.CONFIG_PORT, 7020);
});

test('valores inválidos no ambiente recusam a partida com todos os problemas', () => {
  assert.throws(() => settings.load({ dataDir: novo(), env: { PORT: '70000', AFTER_SEED: 'apagar', BRIDGE_UPLOAD_LIMIT: 'x' } }), (err) => {
    assert.equal(err.code, 'invalid');
    assert.equal(err.problems.length, 3);
    assert.match(err.message, /PORT/);
    assert.match(err.message, /AFTER_SEED/);
    return true;
  });
});

test('combinações inseguras ou contraditórias são recusadas', () => {
  const dir = novo();
  assert.throws(() => settings.load({ dataDir: dir, env: { BRIDGE_ALLOW_LAN: '1', ASCSTREMIO_MODE: 'local' } }), /Contradição/);
  assert.throws(() => settings.load({ dataDir: dir, env: { PORT: '7010' } }), /repetida/);
  assert.throws(() => settings.load({ dataDir: dir, env: { ASCSTREMIO_MODE: 'lan', ASCSTREMIO_CONTAINER: '1' } }), /BRIDGE_PUBLIC_URL/);
  assert.throws(() => settings.load({ dataDir: dir, env: { ALLOWED_HOSTS: '*.exemplo.com' } }), /ALLOWED_HOSTS/);
  assert.throws(() => settings.load({ dataDir: dir, env: { BRIDGE_PUBLIC_URL: 'ftp://x' } }), /http/);
  assert.throws(() => settings.load({ dataDir: dir, env: { BRIDGE_PUBLIC_URL: 'http://u:p@x' } }), /usuário/);
  const ok = settings.load({ dataDir: dir, env: { ASCSTREMIO_MODE: 'lan', ASCSTREMIO_CONTAINER: '1', BRIDGE_PUBLIC_URL: 'http://nas.local:7010', ADDON_PUBLIC_URL: 'http://nas.local:7000' } });
  assert.equal(ok.mode, 'lan');
  assert.ok(ok.warnings.some((w) => /Modo LAN/.test(w)));
});

test('modo local com URL pública fora do loopback só avisa', () => {
  const s = settings.load({ dataDir: novo(), env: { BRIDGE_PUBLIC_URL: 'http://192.168.0.9:7010' } });
  assert.ok(s.warnings.some((w) => /loopback/.test(w)));
});

test('contêiner sem LAN continua local por padrão e escutando em 0.0.0.0', () => {
  const s = settings.load({ dataDir: novo(), env: { ASCSTREMIO_CONTAINER: '1' } });
  assert.equal(s.mode, 'local');
  assert.equal(s.derived.bindHost, '0.0.0.0');
});

test('update grava de forma atômica, com revisão, sem sobras e com modo 0600', () => {
  const dir = novo();
  const r = settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { ASCSTREMIO_MODE: 'lan', LOG_LEVEL: 'info' } });
  assert.deepEqual(r.changed.sort(), ['ASCSTREMIO_MODE', 'LOG_LEVEL']);
  assert.deepEqual(r.restart, ['ASCSTREMIO_MODE'], 'LOG_LEVEL vale na hora');
  assert.equal(r.snapshot.revision, 1);
  assert.equal(r.snapshot.mode, 'lan');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(arquivo(dir)).mode & 0o777, 0o600);
  const doc = JSON.parse(fs.readFileSync(arquivo(dir), 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.values.ASCSTREMIO_MODE, 'lan');
});

test('retornar ao modo local (null) remove a chave e preserva o resto', () => {
  const dir = novo();
  settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { ASCSTREMIO_MODE: 'lan', AFTER_SEED: 'keep' } });
  const r = settings.update({ dataDir: dir, env: {}, expectedRevision: 1, changes: { ASCSTREMIO_MODE: null } });
  assert.equal(r.snapshot.mode, 'local');
  assert.equal(r.snapshot.values.AFTER_SEED, 'keep');
  assert.equal(r.snapshot.sources.ASCSTREMIO_MODE, 'default');
});

test('conflito de versão e valor inválido não alteram o disco', () => {
  const dir = novo();
  settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { PORT: 8000 } });
  const antes = fs.readFileSync(arquivo(dir), 'utf8');
  assert.throws(() => settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { PORT: 8001 } }), (e) => e.code === 'conflict');
  assert.throws(() => settings.update({ dataDir: dir, env: {}, expectedRevision: 1, changes: { PORT: 0 } }), (e) => e.code === 'invalid');
  assert.throws(() => settings.update({ dataDir: dir, env: {}, expectedRevision: 1, changes: { PORT: '8001' } }), (e) => e.code === 'invalid', 'tipo errado no arquivo');
  assert.throws(() => settings.update({ dataDir: dir, env: {}, expectedRevision: 1, changes: { BRIDGE_PORT: 8000 } }), /repetida/);
  assert.throws(() => settings.update({ dataDir: dir, env: {}, changes: { PORT: 8001 } }), /expectedRevision/);
  assert.equal(fs.readFileSync(arquivo(dir), 'utf8'), antes);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('update recusa chave do ambiente, segredo, somente leitura e desconhecida', () => {
  const dir = novo();
  const tenta = (changes, env = {}) => {
    try { settings.update({ dataDir: dir, env, expectedRevision: 0, changes }); } catch (e) { return e.code; }
    return null;
  };
  assert.equal(tenta({ PORT: 8000 }, { PORT: '7000' }), 'locked');
  assert.equal(tenta({ PASSKEY: 'abc' }), 'secret');
  assert.equal(tenta({ ANNOUNCE_BASE: 'https://x.exemplo/anuncio?k=segredo' }), 'secret');
  assert.equal(tenta({ DATA_DIR: '/tmp/x' }), 'locked');
  assert.equal(tenta({ SENHA_ASC: 'x' }), 'unknown');
  assert.equal(fs.existsSync(arquivo(dir)), false);
});

test('arquivo corrompido, de versão futura ou inválido: recusa sem tocar nele', () => {
  const dir = novo();
  const file = arquivo(dir);
  for (const [conteudo, esperado] of [
    ['{nao e json', /JSON válido/],
    ['[1,2]', /formato/],
    [JSON.stringify({ version: 99, revision: 1, values: {} }), /mais nova/],
    [JSON.stringify({ version: 1, revision: 1, values: { DATA_DIR: '/x' } }), /só pelo ambiente/],
    [JSON.stringify({ version: 1, revision: 1, values: { AFTER_SEED: 'sumir' } }), /AFTER_SEED/],
  ]) {
    fs.writeFileSync(file, conteudo);
    assert.throws(() => settings.load({ dataDir: dir, env: {} }), esperado);
    assert.equal(settings.resolve({ dataDir: dir, env: {} }).ok, false, 'resolve não lança: o terminal precisa mostrar o problema');
    if (!/AFTER_SEED|só pelo/.test(String(esperado))) {
      assert.throws(() => settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { PORT: 8000 } }));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), conteudo);
  }
});

test('chaves desconhecidas do arquivo são preservadas ao regravar', () => {
  const dir = novo();
  fs.writeFileSync(arquivo(dir), JSON.stringify({ version: 1, revision: 3, values: { FUTURA_OPCAO: 'x' } }));
  settings.update({ dataDir: dir, env: {}, expectedRevision: 3, changes: { PORT: 8000 } });
  const doc = JSON.parse(fs.readFileSync(arquivo(dir), 'utf8'));
  assert.equal(doc.values.FUTURA_OPCAO, 'x');
  assert.equal(doc.revision, 4);
});

test('problema anterior do ambiente não bloqueia uma troca não relacionada', () => {
  const r = settings.update({ dataDir: novo(), env: { AFTER_SEED: 'x' }, expectedRevision: 0, changes: { LOG_LEVEL: 'warn' } });
  assert.deepEqual(r.changed, ['LOG_LEVEL']);
});

test('trava: segundo escritor recebe busy; trava velha é recuperada', () => {
  const dir = novo();
  const lock = path.join(dir, 'settings.json.lock');
  fs.writeFileSync(lock, '');
  assert.throws(() => settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { PORT: 8000 } }), (e) => e.code === 'busy');
  const velho = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, velho, velho);
  settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { PORT: 8000 } });
  assert.equal(fs.existsSync(lock), false);
});

test('view redige segredos e mostra origem, bloqueio e necessidade de reinício', () => {
  const dir = novo();
  settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { AFTER_SEED: 'stop' } });
  const env = { PASSKEY: 'segredo-super-secreto-1234', ANNOUNCE_BASE: 'https://t.exemplo/anuncio?k=abcdefghijklmnopqrstuvwx', PORT: '8000' };
  const snap = settings.load({ dataDir: dir, env });
  const itens = settings.view(snap);
  const texto = JSON.stringify(itens) + JSON.stringify(snap.values);
  assert.ok(!texto.includes('segredo-super-secreto'), 'passkey não aparece');
  assert.ok(!texto.includes('abcdefghijklmnopqrstuvwx'), 'announce não aparece');
  const por = Object.fromEntries(itens.map((i) => [i.key, i]));
  assert.equal(por.PASSKEY.defined, true);
  assert.equal(por.PASSKEY.value, null);
  assert.equal(por.PORT.source, 'env');
  assert.match(por.PORT.locked, /ambiente/);
  assert.equal(por.AFTER_SEED.source, 'file');
  assert.equal(por.AFTER_SEED.locked, null);
  assert.equal(por.AFTER_SEED.restart, true);
  assert.equal(por.LOG_LEVEL.restart, false);
  assert.equal(por.BRIDGE_STORE.risky, true);
});

test('o esquema cobre as variáveis documentadas e segredo nunca vai ao arquivo', () => {
  const chaves = settings.SCHEMA.map((e) => e.key);
  for (const k of ['DATA_DIR', 'ASC_TORRENT_DIR', 'BRIDGE_STORE', 'PORT', 'BRIDGE_PORT', 'CONFIG_PORT', 'TORRENT_PORT', 'BRIDGE_ALLOW_LAN',
    'ASCSTREMIO_CONTAINER', 'BRIDGE_PUBLIC_URL', 'ADDON_PUBLIC_URL', 'ALLOWED_HOSTS', 'STATUS_CATALOG', 'DEMO_MODE', 'AFTER_SEED',
    'BACKGROUND_COMPLETE', 'BACKGROUND_IDLE_MINUTES', 'SEED_REQUIRED_HOURS', 'KEEP_AWAKE', 'BRIDGE_UPLOAD_LIMIT', 'LOG_LEVEL',
    'LOG_RETENTION_DAYS', 'PASSKEY', 'PASSKEY_FILE', 'ANNOUNCE_BASE']) assert.ok(chaves.includes(k), k);
  assert.equal(new Set(chaves).size, chaves.length);
  for (const e of settings.SCHEMA) {
    assert.ok(e.description && e.group && e.access, e.key);
    if (e.secret) assert.ok(e.envOnly, `${e.key}: segredo só pelo ambiente`);
  }
});

test('applyToEnv copia só o que veio do arquivo e liga o legado da LAN', () => {
  const dir = novo();
  settings.update({ dataDir: dir, env: {}, expectedRevision: 0, changes: { ASCSTREMIO_MODE: 'lan', ALLOWED_HOSTS: 'nas.local', TORRENT_PORT: 7030, DEMO_MODE: false } });
  const env = { PORT: '8000' };
  const snap = settings.load({ dataDir: dir, env });
  settings.applyToEnv(snap, env);
  assert.equal(env.PORT, '8000');
  assert.equal(env.ALLOWED_HOSTS, 'nas.local');
  assert.equal(env.TORRENT_PORT, '7030');
  assert.equal(env.DEMO_MODE, 'false');
  assert.equal(env.BRIDGE_ALLOW_LAN, '1');
});

test('segredo ou chave só-ambiente no arquivo é erro explícito e update não regrava', () => {
  const dir = novo();
  const conteudo = JSON.stringify({ version: 1, revision: 2, values: { PASSKEY: 'x', ANNOUNCE_BASE: 'https://t.exemplo/a' } });
  fs.writeFileSync(arquivo(dir), conteudo);
  const r = settings.resolve({ dataDir: dir, env: {} });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /PASSKEY.*só pelo ambiente/.test(p)));
  assert.ok(r.problems.some((p) => /ANNOUNCE_BASE/.test(p)));
  assert.throws(() => settings.load({ dataDir: dir, env: {} }), (e) => e.code === 'invalid');
  assert.throws(() => settings.update({ dataDir: dir, env: {}, expectedRevision: 2, changes: { PORT: 8000 } }), (e) => e.code === 'invalid');
  assert.equal(fs.readFileSync(arquivo(dir), 'utf8'), conteudo);
});
