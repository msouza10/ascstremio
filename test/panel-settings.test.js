const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const settings = require('../src/settings');
const { startConfig } = require('../src/config-server');
const { createPanelSettings } = require('../src/panel-settings');
const { CredentialStore } = require('../src/credentials');
const { createAddonActivity } = require('../src/addon-activity');
const { Logger } = require('../src/logger');
const M = require('../src/ui/settings-model');
const { tmpdir } = require('./tmp-helper');

const NET = { eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] };
let nextPort = 7330;

// Monta painel + servidor com dados temporários. `env` é o ambiente "de verdade" da partida.
async function setup({ env = {}, connected = true, interfaces = NET } = {}) {
  const dataDir = tmpdir('panel-');
  const bootEnv = { ...env, DATA_DIR: dataDir };
  const snap = settings.load({ dataDir, env: bootEnv, interfaces });
  const credentials = new CredentialStore({ file: path.join(dataDir, 'credentials.json') });
  const levels = [];
  const activity = createAddonActivity();
  const panel = createPanelSettings({
    activity, dataDir, bootEnv, running: snap.values, credentials, interfaces, peerPort: () => require('../src/network').evaluatePeerPort({ engine: { known: true, listening: true, port: 7030 }, configuredPort: 7030 }), playback: () => ({ active: 1, maxSessions: 2, maxPerCredential: 0, graceSeconds: 30, credentials: [] }),
    addonBase: snap.derived.network.urls.addon,
    applyLive: (key, value) => { if (key === 'LOG_LEVEL') { levels.push(value); return true; } return false; },
  });
  const asc = { connected, status: () => ({ connected: asc.connected }) };
  const port = nextPort++;
  const server = await startConfig(asc, port, null, new Logger(), panel);
  const base = `http://127.0.0.1:${port}`;
  const token = /"([0-9a-f]{64})"/.exec(await (await fetch(`${base}/config.js`)).text())[1];
  const good = { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: base };
  const post = (route, body, headers = good) => fetch(`${base}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = async (route) => (await fetch(`${base}/api/${route}`)).json();
  return {
    dataDir, base, port, panel, asc, post, get, good, levels, credentials, activity,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('GET /api/settings: todas as opções do esquema, origem, bloqueios e nenhum segredo', async () => {
  const t = await setup({ env: { PASSKEY: 'segredo-super-secreto', AFTER_SEED: 'stop', ANNOUNCE_BASE: 'http://x/?t=abc' } });
  try {
    const text = await (await fetch(`${t.base}/api/settings`)).text();
    assert.ok(!text.includes('segredo-super-secreto'), 'passkey nunca sai');
    assert.ok(!text.includes('t=abc'), 'ANNOUNCE_BASE nunca sai');
    const st = JSON.parse(text);
    assert.equal(st.options.length, settings.SCHEMA.length, 'a UI recebe o esquema inteiro, sem lista própria');
    const by = (k) => st.options.find((o) => o.key === k);
    assert.equal(by('PASSKEY').defined, true);
    assert.equal(by('PASSKEY').value, null);
    assert.equal(by('PASSKEY').editable, false);
    assert.equal(by('AFTER_SEED').origin, 'ambiente');
    assert.equal(by('AFTER_SEED').editable, false);
    assert.match(by('AFTER_SEED').reason, /ambiente/);
    assert.equal(by('DISK_RESERVE_GIB').origin, 'padrão');
    assert.equal(by('DISK_RESERVE_GIB').editable, true);
    assert.equal(by('ASC_TORRENT_DIR').editable, false, 'pastas só pelo terminal');
    assert.match(by('ASC_TORRENT_DIR').reason, /terminal/);
    assert.equal(st.wizard.completed, false);
    assert.equal(st.revision, 0);
  } finally { await t.close(); }
});

test('reproduções simultâneas: chaves PLAYBACK_* aparecem com unidade, faixa e reinício; vagas só leitura', async () => {
  const t = await setup();
  try {
    const st = await t.get('settings');
    const o = st.options.find((x) => x.key === 'PLAYBACK_MAX_SESSIONS');
    assert.equal(o.groupLabel, 'Reproduções simultâneas');
    assert.equal(o.unit, 'sessões');
    assert.equal(o.max, 1000);
    assert.equal(o.restart, true);
    assert.equal(o.editable, true);
    assert.equal(st.playback.active, 1);
    assert.equal(st.peerPort.state, 'escutando');
    assert.equal(st.peerPort.layers.firewallNat.estado, 'desconhecido');
    const prev = await (await t.post('settings/preview', { expectedRevision: 0, changes: { PLAYBACK_MAX_SESSIONS: '3' } })).json();
    assert.deepEqual(prev.restart, ['PLAYBACK_MAX_SESSIONS']);
    assert.equal((await t.post('settings/preview', { expectedRevision: 0, changes: { PLAYBACK_MAX_SESSIONS: '5000' } })).status, 422);
  } finally { await t.close(); }
});

test('rotas de configuração exigem sessão do ASC, Host, Origin, CSRF e JSON', async () => {
  const t = await setup({ connected: false });
  try {
    assert.equal((await fetch(`${t.base}/api/settings`)).status, 401);
    assert.equal((await fetch(`${t.base}/api/credentials`)).status, 401);
    const corpo = { expectedRevision: 0, changes: { DISK_RESERVE_GIB: '5' } };
    assert.equal((await t.post('settings', corpo)).status, 401, 'sem sessão não grava');
    t.asc.connected = true;
    assert.equal((await t.post('settings', corpo, { ...t.good, 'X-CSRF-Token': 'x' })).status, 403, 'CSRF');
    assert.equal((await t.post('settings', corpo, { ...t.good, Origin: 'https://evil.example' })).status, 403, 'Origin');
    assert.equal((await t.post('settings/preview', corpo, { ...t.good, 'Content-Type': 'text/plain' })).status, 403, 'não-JSON');
    assert.equal((await t.post('wizard/complete', {}, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await t.post('credentials', { name: 'x' }, { 'Content-Type': 'application/json' })).status, 403);
    // Host diferente (DNS rebinding)
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: t.port, path: '/api/settings', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
    });
    assert.equal(status, 403);
    assert.equal(fs.existsSync(path.join(t.dataDir, 'settings.json')), false, 'nada gravado pelas tentativas recusadas');
  } finally { await t.close(); }
});

test('sem painel configurado as rotas novas não existem', async () => {
  const asc = { connected: true, status: () => ({}) };
  const server = await startConfig(asc, 7329, null, new Logger(), null);
  try {
    assert.equal((await fetch('http://127.0.0.1:7329/api/settings')).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});

test('prévia não grava; salvar grava com revisão, indica reinício e conflito preserva o arquivo', async () => {
  const t = await setup();
  try {
    const corpo = { expectedRevision: 0, changes: { DISK_RESERVE_GIB: '5', AFTER_SEED: 'stop' } };
    const prev = await (await t.post('settings/preview', corpo)).json();
    assert.deepEqual(prev.changes.map((c) => c.key).sort(), ['AFTER_SEED', 'DISK_RESERVE_GIB']);
    assert.deepEqual(prev.restart.sort(), ['AFTER_SEED', 'DISK_RESERVE_GIB']);
    assert.equal(prev.changes.find((c) => c.key === 'DISK_RESERVE_GIB').to, 5, 'valor tipado pelo esquema');
    assert.equal(fs.existsSync(path.join(t.dataDir, 'settings.json')), false, 'prévia não grava');

    const res = await t.post('settings', corpo);
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.saved, true);
    assert.equal(out.revision, 1);
    assert.equal(out.state.options.find((o) => o.key === 'AFTER_SEED').origin, 'arquivo');
    assert.deepEqual(out.state.pending.sort(), ['AFTER_SEED', 'DISK_RESERVE_GIB'], 'reinício pendente continua depois de recarregar');
    assert.deepEqual((await t.get('settings')).pending.sort(), ['AFTER_SEED', 'DISK_RESERVE_GIB']);
    assert.equal(settings.load({ dataDir: t.dataDir, env: { DATA_DIR: t.dataDir } }).values.DISK_RESERVE_GIB, 5);

    // outro escritor (terminal, outra aba) avançou a revisão: conflito, arquivo intacto
    const antes = fs.readFileSync(path.join(t.dataDir, 'settings.json'), 'utf8');
    const velho = await t.post('settings', { expectedRevision: 0, changes: { DISK_RESERVE_GIB: '9' } });
    assert.equal(velho.status, 409);
    const body = await velho.json();
    assert.equal(body.code, 'conflict');
    assert.match(body.error, /Nada foi gravado/);
    assert.equal(fs.readFileSync(path.join(t.dataDir, 'settings.json'), 'utf8'), antes);
    const velhoPrev = await t.post('settings/preview', { expectedRevision: 0, changes: { DISK_RESERVE_GIB: '9' } });
    assert.equal(velhoPrev.status, 409);
  } finally { await t.close(); }
});

test('valor inválido, desconhecido, segredo, ambiente e pasta são recusados sem gravar', async () => {
  const t = await setup({ env: { BRIDGE_PORT: '7011' } });
  try {
    const tenta = async (changes) => {
      const r = await t.post('settings', { expectedRevision: 0, changes });
      return { status: r.status, body: await r.json() };
    };
    const inv = await tenta({ DISK_RESERVE_PERCENT: '999' });
    assert.equal(inv.status, 422);
    assert.match(inv.body.problems.join(' '), /DISK_RESERVE_PERCENT/);
    assert.equal((await tenta({ NAO_EXISTE: 'x' })).status, 422);
    const sec = await tenta({ PASSKEY: 'abc123segredo' });
    assert.equal(sec.status, 422);
    assert.ok(!JSON.stringify(sec.body).includes('abc123segredo'), 'o valor do segredo não volta na resposta');
    const env = await tenta({ BRIDGE_PORT: '7012' });
    assert.equal(env.status, 403);
    assert.equal(env.body.code, 'locked');
    const dir = await tenta({ BRIDGE_STORE: '/tmp/outro' });
    assert.equal(dir.status, 403);
    assert.equal(dir.body.code, 'terminal');
    assert.equal((await t.post('settings', { expectedRevision: 'x', changes: { LOG_LEVEL: 'info' } })).status, 400);
    assert.equal((await t.post('settings', { expectedRevision: 0, changes: { LOG_LEVEL: 5 } })).status, 400, 'só texto');
    assert.equal((await t.post('settings', { expectedRevision: 0, changes: {} })).status, 400);
    assert.equal(fs.existsSync(path.join(t.dataDir, 'settings.json')), false);
  } finally { await t.close(); }
});

test('LOG_LEVEL vale na hora (sem reinício pendente); remover volta ao padrão', async () => {
  const t = await setup();
  try {
    const out = await (await t.post('settings', { expectedRevision: 0, changes: { LOG_LEVEL: 'warn' } })).json();
    assert.deepEqual(out.restart, []);
    assert.deepEqual(t.levels, ['warn']);
    assert.deepEqual(out.state.pending, []);
    const volta = await (await t.post('settings', { expectedRevision: 1, changes: { LOG_LEVEL: null } })).json();
    assert.equal(volta.state.options.find((o) => o.key === 'LOG_LEVEL').origin, 'padrão');
  } finally { await t.close(); }
});

test('modo LAN: prévia valida o endereço, avisa reinício e traz instruções de recuperação', async () => {
  const t = await setup();
  try {
    const st = await t.get('settings');
    assert.deepEqual(st.network.list.map((c) => c.address), ['192.168.1.20']);
    const ruim = await t.post('settings/preview', { expectedRevision: 0, changes: { ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: '10.9.9.9' } });
    assert.equal(ruim.status, 422, 'endereço que não é deste computador é recusado ao salvar');
    const prev = await (await t.post('settings/preview', { expectedRevision: 0, changes: { ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: '192.168.1.20' } })).json();
    assert.ok(prev.restart.includes('ASCSTREMIO_MODE'));
    assert.match(prev.recovery.join(' '), /configurar -- modo local/);
    assert.match(prev.warnings.join(' '), /Modo LAN/);
    const out = await (await t.post('settings', { expectedRevision: 0, changes: { ASCSTREMIO_MODE: 'lan', LAN_ADVERTISE_HOST: '192.168.1.20' } })).json();
    assert.ok(out.state.pending.includes('ASCSTREMIO_MODE'));
    assert.equal(out.state.runningMode, 'local');
    // com mudança de rede pendente a URL do addon não é oferecida (valeria para o endereço antigo)
    assert.equal(out.state.addon.url, null);
    const cred = await t.post('credentials', { name: 'TV' });
    assert.equal(cred.status, 409);
  } finally { await t.close(); }
});

test('BRIDGE_ALLOW_LAN=1: o estado informa o modo efetivo (lan) e trava ASCSTREMIO_MODE', async () => {
  const t = await setup({ env: { BRIDGE_ALLOW_LAN: '1', LAN_ADVERTISE_HOST: '192.168.1.20' } });
  try {
    const st = await t.get('settings');
    assert.equal(st.mode, 'lan');
    const modo = st.options.find((o) => o.key === 'ASCSTREMIO_MODE');
    assert.equal(modo.editable, false);
    assert.match(modo.reason, /BRIDGE_ALLOW_LAN/);
  } finally { await t.close(); }
});

test('mudar CONFIG_PORT explica onde o painel passa a abrir', async () => {
  const t = await setup();
  try {
    const out = await (await t.post('settings', { expectedRevision: 0, changes: { CONFIG_PORT: '7099' } })).json();
    assert.match(out.recovery.join(' '), /127\.0\.0\.1:7099/);
    assert.match(out.recovery.join(' '), /recuperar/);
  } finally { await t.close(); }
});

test('assistente: conclusão fica em wizard.json, independente da sessão do ASC e de atualizações', async () => {
  const t = await setup();
  try {
    assert.equal((await t.get('settings')).wizard.completed, false);
    const dismissed = await (await t.post('wizard/dismiss', {})).json();
    assert.equal(dismissed.dismissed, true);
    assert.equal(M.shouldOfferWizard(await t.get('settings')), false, 'adiado não insiste');
    const done = await (await t.post('wizard/complete', {})).json();
    assert.equal(done.completed, true);
    assert.equal(done.dismissed, false);
    // sessão expira e volta: a conclusão continua
    t.asc.connected = false;
    assert.equal((await fetch(`${t.base}/api/settings`)).status, 401);
    t.asc.connected = true;
    assert.equal((await t.get('settings')).wizard.completed, true);
    // novo processo (reinício/atualização) lê o mesmo arquivo
    const outro = createPanelSettings({ dataDir: t.dataDir, bootEnv: { DATA_DIR: t.dataDir }, running: settings.resolve({ dataDir: t.dataDir, env: { DATA_DIR: t.dataDir } }).values });
    assert.equal(outro.wizardState().completed, true);
    assert.equal(fs.existsSync(path.join(t.dataDir, 'settings.json')), false, 'não mexe nas configurações');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(t.dataDir, 'wizard.json')).mode & 0o777, 0o600);
    // arquivo ilegível: volta a oferecer, sem quebrar
    fs.writeFileSync(path.join(t.dataDir, 'wizard.json'), '{lixo');
    assert.equal((await t.get('settings')).wizard.completed, false);
    assert.equal((await t.post('wizard/xyz', {})).status, 404);
  } finally { await t.close(); }
});

test('credencial: token aparece só na emissão; listagem e estado não o trazem', async () => {
  const t = await setup();
  try {
    const bad = await t.post('credentials', { name: '' });
    assert.equal(bad.status, 422);
    const res = await t.post('credentials', { name: 'Stremio neste computador' });
    assert.equal(res.status, 201);
    const made = await res.json();
    assert.match(made.token, /^ascc_[A-Za-z0-9_-]{43}$/);
    assert.equal(made.manifestUrl, `http://127.0.0.1:7000/${made.token}/manifest.json`);
    assert.equal(t.credentials.verify(made.token).id, made.credential.id);
    for (const rota of ['credentials', 'settings']) {
      const txt = JSON.stringify(await t.get(rota));
      assert.ok(!txt.includes(made.token), `${rota} não devolve o token`);
      assert.ok(!txt.includes('verifier'));
    }
    assert.equal((await t.get('credentials')).credentials.length, 1);
  } finally { await t.close(); }
});

test('arquivo settings.json com problema: estado informa e a gravação é recusada', async () => {
  const t = await setup();
  try {
    fs.writeFileSync(path.join(t.dataDir, 'settings.json'), '{quebrado');
    const st = await t.get('settings');
    assert.equal(st.ok, false);
    assert.ok(st.problems.length);
    const r = await t.post('settings', { expectedRevision: 0, changes: { LOG_LEVEL: 'info' } });
    assert.ok(r.status >= 400);
  } finally { await t.close(); }
});

test('interface: arquivos estáticos novos são servidos e as páginas devolvem o shell', async () => {
  const t = await setup();
  try {
    for (const f of ['/settings.js', '/settings-model.js']) assert.equal((await fetch(`${t.base}${f}`)).status, 200, f);
    for (const rota of ['/configuracoes', '/assistente']) {
      const page = await fetch(`${t.base}${rota}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Monitor ASC/);
    }
    const html = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
    assert.match(html, /settings-model\.js/);
    assert.ok(html.indexOf('views.js') < html.indexOf('settings.js'), 'settings.js depende de Views');
  } finally { await t.close(); }
});

// ----------------------------------------------------------------- lógica pura da UI

test('modelo da UI: só envia o que mudou e pode ser editado', () => {
  const options = [
    { key: 'A', editable: true, value: 2, source: 'default' },
    { key: 'B', editable: true, value: 'stop', source: 'file' },
    { key: 'C', editable: false, value: 'x', source: 'env' },
    { key: 'D', editable: true, value: false, source: 'default' },
  ];
  assert.deepEqual(M.buildChanges(options, { A: '2', B: null, C: 'y', D: 'true' }), { B: null, D: 'true' });
  assert.deepEqual(M.buildChanges(options, { A: ' 3 ' }), { A: '3' });
  assert.deepEqual(M.buildChanges(options, {}), {});
  // opcional esvaziada: remove do arquivo (não grava texto vazio nem mantém o valor antigo)
  const opcionais = [
    { key: 'H', editable: true, value: '192.168.1.20', default: null, source: 'file' },
    { key: 'I', editable: true, value: null, default: null, source: 'default' },
  ];
  assert.deepEqual(M.buildChanges(opcionais, { H: '', I: '' }), { H: null });
  assert.deepEqual(M.buildChanges(opcionais, { H: null }), { H: null });
});

test('modelo da UI: agrupa na ordem do esquema, associa problemas aos campos e escreve a prévia', () => {
  const groups = { modo: 'Modo', disco: 'Disco' };
  const options = [{ key: 'DISK_RESERVE_GIB', group: 'disco' }, { key: 'ASCSTREMIO_MODE', group: 'modo' }, { key: 'PORT', group: 'rede', groupLabel: 'Rede' }];
  assert.deepEqual(M.groupOptions(options, groups).map((g) => g.key), ['modo', 'disco', 'rede']);
  const { byKey, general } = M.problemsByKey(['DISK_RESERVE_GIB: deve ser >= 0.', 'Porta 7000 repetida em PORT e BRIDGE_PORT.', 'algo geral'], options);
  assert.deepEqual(Object.keys(byKey).sort(), ['DISK_RESERVE_GIB', 'PORT']);
  assert.deepEqual(general, ['algo geral']);
  assert.equal(M.changeLine({ key: 'DISK_RESERVE_GIB', from: 2, to: 5, unit: 'GiB' }), 'DISK_RESERVE_GIB: 2 GiB → 5 GiB');
  assert.equal(M.display({ secret: true, defined: true }, null), '(definido)');
  assert.deepEqual(M.wizardSteps('local'), ['modo', 'seed', 'revisar', 'instalar']);
  assert.ok(M.wizardSteps('lan').includes('endereco'));
  assert.match(M.AFTER_SEED_EFFECT.delete, /APAGADOS/);
  assert.equal(M.shouldOfferWizard({ wizard: { completed: false, dismissed: false } }), true);
  assert.equal(M.shouldOfferWizard({ wizard: { completed: true, dismissed: false } }), false);
});

test('conexão do Stremio: link do Stremio Web e estado por credencial, sem afirmar instalação sem catálogo', async () => {
  const s = await setup();
  try {
    const r = await s.post('credentials', { name: 'Sala' });
    assert.equal(r.status, 201);
    const made = await r.json();
    assert.equal(made.webUrl, `https://web.stremio.com/#/addons?addon=${encodeURIComponent(made.manifestUrl)}`);

    const id = made.credential.id;
    const state = async () => (await s.get('addon-connection')).credentials.find((c) => c.id === id);
    assert.equal((await state()).state, 'aguardando');
    s.activity.record(id, '/manifest.json');
    assert.equal((await state()).state, 'manifesto_lido');
    s.activity.record(id, '/catalog/movie/asc.json');
    const done = await state();
    assert.equal(done.state, 'instalado');
    assert.ok(done.lastSeenAt);
    assert.equal(JSON.stringify(done).includes(made.token), false, 'o token nunca volta na consulta');

    s.asc.connected = false;
    assert.equal((await fetch(`${s.base}/api/addon-connection`)).status, 401);
  } finally { await s.close(); }
});

test('modelo da UI: revisão só quando há o que gravar, nome do aparelho e rótulos humanos', () => {
  assert.deepEqual(M.wizardSteps('local', false), ['modo', 'seed', 'instalar']);
  assert.deepEqual(M.wizardSteps('lan', false), ['modo', 'endereco', 'seed', 'instalar']);
  assert.equal(M.copyName('local', 'meu-pc'), 'meu-pc');
  assert.equal(M.copyName('local', ''), 'Stremio neste computador');
  assert.equal(M.copyName('local', 'x'.repeat(60)).length, 40);
  assert.equal(M.copyName('lan', 'meu-pc'), 'Stremio da sala');
  assert.equal(M.labelOf({ key: 'AFTER_SEED' }), 'Depois de cumprir o seed');
  assert.equal(M.labelOf({ key: 'CHAVE_SEM_ROTULO' }), 'CHAVE_SEM_ROTULO');
  assert.equal(M.valueLabel({ key: 'AFTER_SEED' }, 'keep'), 'Continuar semeando');
  assert.equal(M.valueLabel({ key: 'OUTRA' }, 'x'), 'x');
});

test('o estado do painel traz o hostname para nomear a credencial', async () => {
  const s = await setup();
  try {
    const st = await s.get('settings');
    assert.equal(st.hostname, require('node:os').hostname());
  } finally { await s.close(); }
});

test('X-Boot-Id: estável numa partida e diferente em outra (a tela percebe o reinício)', async () => {
  const a = await setup();
  const b = await setup();
  try {
    const id = async (s) => (await fetch(`${s.base}/api/status`)).headers.get('x-boot-id');
    const [a1, a2, b1] = [await id(a), await id(a), await id(b)];
    assert.match(a1, /^[0-9a-f]{16}$/);
    assert.equal(a1, a2);
    assert.notEqual(a1, b1);
  } finally { await a.close(); await b.close(); }
});

test('reinício de rede pendente: a URL do addon não é gerada e o texto aponta para Conta › Addons', async () => {
  const s = await setup();
  try {
    const antes = await s.get('settings');
    assert.ok(antes.addon.url, 'sem mudança pendente a URL existe');
    // Trocar uma porta só vale depois de reiniciar: a URL anunciada ainda é a da partida.
    const r = await s.post('settings', { expectedRevision: antes.revision, changes: { PORT: '7101' } });
    assert.equal(r.status, 200);
    const depois = await s.get('settings');
    assert.equal(depois.addon.url, null);
    assert.match(depois.addon.reason, /PORT/);
    assert.match(depois.addon.reason, /Conta › Addons/);
    assert.doesNotMatch(depois.addon.reason, /abra o assistente/i);
    const bloqueada = await s.post('credentials', { name: 'Sala' });
    assert.equal(bloqueada.status, 409, 'não emite credencial enquanto a rede espera reinício');
  } finally { await s.close(); }
});

test('addonUrls: refaz a URL com a base atual e o token guardado (igual à que o servidor emite)', async () => {
  const s = await setup();
  try {
    const st = await s.get('settings');
    const made = await (await s.post('credentials', { name: 'Sala' })).json();
    // Mesma conta que o servidor faz: a URL guardada na aba pode ser refeita sem divergir.
    assert.deepEqual(M.addonUrls(st.addon.url, made.token), { manifestUrl: made.manifestUrl, webUrl: made.webUrl });
    // Se a base mudou (modo LAN, porta, endereço), a URL nova usa a base nova e o mesmo token.
    const lan = M.addonUrls('http://192.168.1.20:7000/', made.token);
    assert.equal(lan.manifestUrl, `http://192.168.1.20:7000/${made.token}/manifest.json`);
    assert.equal(lan.webUrl, `https://web.stremio.com/#/addons?addon=${encodeURIComponent(lan.manifestUrl)}`);
  } finally { await s.close(); }
});

test('assistente: concluir com rede pendente marca a instalação como pendente até existir credencial ativa', async () => {
  const s = await setup();
  try {
    const antes = await s.get('settings');
    await s.post('settings', { expectedRevision: antes.revision, changes: { PORT: '7101' } });
    assert.equal((await s.get('settings')).addon.url, null);
    const done = await (await s.post('wizard/complete', {})).json();
    assert.equal(done.installPending, true);
    assert.equal((await s.get('settings')).wizard.installPending, true);
    const doc = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'wizard.json'), 'utf8'));
    assert.equal(doc.installPending, true);
    assert.ok(Date.parse(doc.installPendingAt));
    const cred = s.credentials.create({ name: 'x' });
    assert.equal((await s.get('settings')).wizard.installPending, false, 'credencial ativa apaga o aviso');
    s.credentials.revoke(cred.credential.id);
    assert.equal((await s.get('settings')).wizard.installPending, true, 'sem credencial ativa o aviso volta');
  } finally { await s.close(); }
});

test('assistente: concluir com URL disponível não marca instalação pendente', async () => {
  const s = await setup();
  try {
    const done = await (await s.post('wizard/complete', {})).json();
    assert.equal(done.installPending, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'wizard.json'), 'utf8')).installPending, undefined);
  } finally { await s.close(); }
});

test('assistente: wizard.json antigo, sem installPending, continua legível', async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.dataDir, 'wizard.json'), JSON.stringify({ version: 1, completedAt: '2026-01-01T00:00:00.000Z', mode: 'local' }));
    const w = (await s.get('settings')).wizard;
    assert.equal(w.completed, true);
    assert.equal(w.installPending, false);
  } finally { await s.close(); }
});
