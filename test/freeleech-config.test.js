// Filtro "somente freeleech" como configuração (issue #54): fora do login, ASC_ONLY_FREELEECH
// no esquema, aplicação imediata, migração única da sessão antiga e efeito na busca/catálogo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settings = require('../src/settings');
const { AscClient } = require('../src/asc-client');
const { createAscProvider } = require('../src/asc-provider');
const { migrateLegacyFreeleech } = require('../src/freeleech-migration');
const { createPanelSettings } = require('../src/panel-settings');
const { startConfig } = require('../src/config-server');
const { Logger } = require('../src/logger');
const { tmpdir } = require('./tmp-helper');

const KEY = 'ASC_ONLY_FREELEECH';
const html = (props) => `<script type="application/json" data-page="app">${JSON.stringify({ props })}</script>`;
const quiet = { info() {}, warn() {} };

const ROWS = [
  { id: 1, name: 'Filme A 1080p', freeleech: true, seeders: 5 },
  { id: 2, name: 'Filme B 1080p', freeleech: false, seeders: 9 },
];

// Cliente com site simulado. Com freeleech=1 o site só devolve os freeleech.
function clientWithSite(dir) {
  const urls = [];
  const asc = new AscClient({ stateFile: path.join(dir, 'asc-session.json'), delay: 0, fetchImpl: async (url) => {
    urls.push(String(url));
    const only = new URL(url).searchParams.get('freeleech') === '1';
    return new Response(html({ torrents: { data: only ? ROWS.filter((r) => r.freeleech) : ROWS } }), { status: 200 });
  } });
  return { asc, urls };
}

function sessionFile(dir, extra) {
  fs.writeFileSync(path.join(dir, 'asc-session.json'), JSON.stringify({ cookies: { version: 'tough-cookie@5', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [] }, lastLoginAt: '2026-01-01T00:00:00.000Z', ...extra }));
}

const sessionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'asc-session.json'), 'utf8'));
const loaded = async (dir) => { const c = new AscClient({ stateFile: path.join(dir, 'asc-session.json'), delay: 0 }); await c.load(); return c; };

test('esquema: ASC_ONLY_FREELEECH é bool, padrão ligado, editável, vale na hora e explica o ratio', () => {
  const entry = settings.schemaEntry(KEY);
  assert.equal(entry.type, 'bool');
  assert.equal(entry.default, true);
  assert.equal(entry.access, 'editable');
  assert.equal(entry.restart, false);
  assert.match(entry.description, /freeleech.*ratio/);
  assert.ok(settings.GROUPS[entry.group]);
});

test('precedência: ambiente > settings.json > padrão; valor inválido é recusado', () => {
  const dataDir = tmpdir('fl-prec-');
  assert.equal(settings.resolve({ dataDir, env: {} }).values[KEY], true);
  assert.equal(settings.resolve({ dataDir, env: {} }).sources[KEY], 'default');

  settings.update({ dataDir, env: {}, changes: { [KEY]: false }, expectedRevision: 0 });
  const arquivo = settings.resolve({ dataDir, env: {} });
  assert.equal(arquivo.values[KEY], false);
  assert.equal(arquivo.sources[KEY], 'file');

  const amb = settings.resolve({ dataDir, env: { [KEY]: 'true' } });
  assert.equal(amb.values[KEY], true);
  assert.equal(amb.sources[KEY], 'env');
  assert.throws(() => settings.update({ dataDir, env: { [KEY]: 'true' }, changes: { [KEY]: true }, expectedRevision: 1 }), (e) => e.code === 'locked');

  assert.throws(() => settings.update({ dataDir, env: {}, changes: { [KEY]: 'talvez' }, expectedRevision: 1 }), (e) => e.code === 'invalid');
  assert.throws(() => settings.load({ dataDir: tmpdir('fl-inv-'), env: { [KEY]: '1' } }), (e) => e.code === 'invalid');
  assert.equal(settings.resolve({ dataDir, env: {} }).values[KEY], false, 'recusa não altera o que estava salvo');
});

test('cliente: padrão ligado, setter só aceita booleano e a sessão não grava mais o filtro', async () => {
  const dir = tmpdir('fl-cli-');
  const { asc } = clientWithSite(dir);
  assert.equal(asc.onlyFreeleech, true);
  assert.equal(asc.setOnlyFreeleech('false'), false);
  assert.equal(asc.setOnlyFreeleech(undefined), false);
  assert.equal(asc.onlyFreeleech, true, 'valor inválido não afrouxa o filtro');
  assert.equal(asc.setOnlyFreeleech(false), true);
  assert.equal(asc.status().onlyFreeleech, false);
  await asc.save();
  assert.ok(!('onlyFreeleech' in sessionOf(dir)));
  // load() de sessão antiga não aplica o valor: só o guarda para a migração.
  sessionFile(dir, { onlyFreeleech: false });
  const novo = await loaded(dir);
  assert.equal(novo.onlyFreeleech, true);
  assert.equal(novo.legacyOnlyFreeleech, false);
});

test('busca e catálogo refletem a troca na hora, sem novo login', async () => {
  const dir = tmpdir('fl-busca-');
  const { asc, urls } = clientWithSite(dir);
  const provider = createAscProvider(asc, {}, path.join(dir, 't'));
  const ids = async () => (await provider.catalog('x')).map((m) => m.id);

  assert.deepEqual(await ids(), ['ascfilm:1']);
  assert.match(urls.at(-1), /freeleech=1/);

  asc.setOnlyFreeleech(false);
  assert.deepEqual(await ids(), ['ascfilm:1', 'ascfilm:2']);
  assert.doesNotMatch(urls.at(-1), /freeleech=/);

  asc.setOnlyFreeleech(true);
  assert.deepEqual(await ids(), ['ascfilm:1']);
});

test('trocar o filtro mantém a query das linhas lembradas: cartões antigos continuam abrindo', async () => {
  const dir = tmpdir('fl-rec-');
  const { asc } = clientWithSite(dir);
  const provider = createAscProvider(asc, { lazyUrl: (id) => `http://127.0.0.1:7010/a/${id}`, vault: { get: () => null }, entryByAscId: () => null, diskState: () => 'none' }, path.join(dir, 't'));
  await provider.catalog('x'); // filtro ligado: só o release 1 é lembrado
  asc.setOnlyFreeleech(false);
  await provider.catalog('x'); // agora também o 2
  assert.ok(provider.meta('1') && provider.meta('2'));
  asc.setOnlyFreeleech(true);
  assert.equal(provider.meta('2'), null, 'com o filtro ligado o release não freeleech não é mais apresentado');
  assert.ok(provider.meta('1'), 'o freeleech segue disponível');
  assert.equal((await provider.streamsFor('2')).length, 0, 'e a rebusca (filtrada) não o devolve');
  assert.equal((await provider.streamsFor('1')).length, 1, 'cartão antigo de freeleech abre depois da troca');
  asc.setOnlyFreeleech(false);
  assert.ok(provider.meta('2'), 'ao desligar o filtro volta a ser apresentado');
});

test('painel: salvar a chave aplica ao cliente em execução (applyLive) sem reiniciar', () => {
  const dataDir = tmpdir('fl-live-');
  const bootEnv = { DATA_DIR: dataDir };
  const snap = settings.load({ dataDir, env: bootEnv });
  const { asc } = clientWithSite(dataDir);
  asc.setOnlyFreeleech(snap.values[KEY]);
  const panel = createPanelSettings({
    dataDir, bootEnv, running: snap.values, addonBase: snap.derived.network.urls.addon,
    applyLive: (key, value) => (key === KEY ? asc.setOnlyFreeleech(value) : false),
  });
  const row = () => panel.state().options.find((o) => o.key === KEY);
  assert.equal(row().value, true);
  assert.equal(row().editable, true);
  assert.equal(row().origin, 'padrão');

  const out = panel.save({ expectedRevision: snap.revision, changes: { [KEY]: 'false' } });
  assert.equal(asc.onlyFreeleech, false);
  assert.deepEqual(out.restart, []);
  assert.equal(row().running, false, '"em uso" acompanha o valor aplicado');
  assert.equal(row().pending, false);
  assert.equal(row().origin, 'arquivo');

  panel.save({ expectedRevision: out.revision, changes: { [KEY]: null } });
  assert.equal(asc.onlyFreeleech, true, 'voltar ao padrão religa o filtro');

  assert.throws(() => panel.save({ expectedRevision: out.revision + 1, changes: { [KEY]: 'sim' } }), (e) => e.status === 422);
  assert.equal(asc.onlyFreeleech, true);
});

test('migração: sessão antiga com false vai uma vez para o settings.json', async () => {
  const dataDir = tmpdir('fl-mig-');
  sessionFile(dataDir, { onlyFreeleech: false });
  const client = await loaded(dataDir);

  const r = await migrateLegacyFreeleech({ client, dataDir, env: {}, log: quiet });
  assert.equal(r.migrated, true);
  assert.equal(r.value, false);
  const snap = settings.resolve({ dataDir, env: {} });
  assert.equal(snap.values[KEY], false);
  assert.equal(snap.sources[KEY], 'file');
  assert.equal(snap.revision, 1);
  assert.ok(!('onlyFreeleech' in sessionOf(dataDir)), 'o campo antigo sai da sessão');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777, 0o600);

  // Segunda partida: nada a repetir, nem se o usuário depois mudar a configuração.
  settings.update({ dataDir, env: {}, changes: { [KEY]: true }, expectedRevision: 1 });
  const segundo = await loaded(dataDir);
  assert.equal((await migrateLegacyFreeleech({ client: segundo, dataDir, env: {}, log: quiet })).migrated, false);
  assert.equal(settings.resolve({ dataDir, env: {} }).values[KEY], true);
  assert.equal(settings.resolve({ dataDir, env: {} }).revision, 2);
});

test('migração: true, ausente ou sem sessão não grava nada', async () => {
  for (const extra of [{ onlyFreeleech: true }, {}, null]) {
    const dataDir = tmpdir('fl-nada-');
    if (extra) sessionFile(dataDir, extra);
    const client = await loaded(dataDir);
    assert.equal((await migrateLegacyFreeleech({ client, dataDir, env: {}, log: quiet })).migrated, false);
    assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false);
  }
});

test('migração: configuração existente (arquivo ou ambiente) prevalece e o valor antigo é descartado', async () => {
  for (const modo of ['arquivo', 'ambiente']) {
    const dataDir = tmpdir('fl-prev-');
    sessionFile(dataDir, { onlyFreeleech: false });
    const env = {};
    if (modo === 'arquivo') settings.update({ dataDir, env, changes: { [KEY]: true }, expectedRevision: 0 });
    else env[KEY] = 'true';
    const client = await loaded(dataDir);
    const file = path.join(dataDir, 'settings.json');
    const antes = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const r = await migrateLegacyFreeleech({ client, dataDir, env, log: quiet });
    assert.equal(r.migrated, false);
    assert.equal(settings.resolve({ dataDir, env }).values[KEY], true, modo);
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, antes, 'o arquivo de configuração não é tocado');
    assert.ok(!('onlyFreeleech' in sessionOf(dataDir)));
  }
});

test('migração: falha ao gravar não é silenciosa, mantém o filtro ligado e tenta de novo depois', async () => {
  const dataDir = tmpdir('fl-falha-');
  sessionFile(dataDir, { onlyFreeleech: false });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{ quebrado');
  const client = await loaded(dataDir);
  const avisos = [];
  const r = await migrateLegacyFreeleech({ client, dataDir, env: {}, log: { info() {}, warn: (m) => avisos.push(m) } });
  assert.equal(r.migrated, false);
  assert.equal(client.onlyFreeleech, true, 'fail-closed: filtro ligado');
  assert.equal(sessionOf(dataDir).onlyFreeleech, false, 'valor antigo preservado para nova tentativa');
});

let nextPort = 7480;
async function loginServer(login) {
  const dataDir = tmpdir('fl-login-');
  const bootEnv = { DATA_DIR: dataDir };
  const snap = settings.load({ dataDir, env: bootEnv });
  const panel = createPanelSettings({ dataDir, bootEnv, running: snap.values });
  const asc = { connected: false, status: () => ({ connected: asc.connected }), login };
  const port = nextPort++;
  const server = await startConfig(asc, port, null, new Logger(), panel);
  const base = `http://127.0.0.1:${port}`;
  const token = /"([0-9a-f]{64})"/.exec(await (await fetch(`${base}/config.js`)).text())[1];
  const post = (body) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: base }, body: JSON.stringify(body) });
  return { post, close: () => new Promise((r) => server.close(r)) };
}

test('POST /api/login funciona sem onlyFreeleech e ignora o campo se ele vier', async () => {
  for (const extra of [{}, { onlyFreeleech: false }]) {
    const chamadas = [];
    const t = await loginServer(async (...args) => { chamadas.push(args); return { connected: true }; });
    try {
      const res = await t.post({ username: 'u', password: 'p', ...extra });
      assert.equal(res.status, 200);
      assert.deepEqual(chamadas, [['u', 'p']], 'o filtro nunca chega ao login');
    } finally { await t.close(); }
  }
});

test('interface: login sem o checkbox, com aviso para Configurações; conta aponta para /configuracoes', () => {
  const ui = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8');
  const views = ui('views.js');
  assert.doesNotMatch(views, /id = 'freeleech'/);
  assert.doesNotMatch(views, /onlyFreeleech: cb/);
  assert.match(views, /ficam em Configurações, no menu, depois de entrar/);
  assert.match(views, /filterLink\.href = '\/configuracoes'/);
  assert.ok((ui('index.html').match(/href="\/configuracoes"/g) ?? []).length >= 2, 'link nas duas navegações');
  assert.match(ui('settings.js'), /'ASC_ONLY_FREELEECH'\]\) \{/, 'o assistente oferece a chave');
});
