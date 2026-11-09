const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startConfig } = require('../src/config-server');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const hnr = require('../src/hnr-guard');
const { tmpdir } = require('./tmp-helper');

const PORT = 7219;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpFile = () => path.join(tmpdir('mon-'), 'vault.json');
const H = (c) => c.repeat(40);

test('servidor: estáticos, painel só com sessão confirmada, ação protegida por CSRF', async () => {
  const asc = { connected: false, status: () => ({ connected: asc.connected }) };
  const chamadas = [];
  const server = await startConfig(asc, PORT, {
    snapshot: () => ({ titles: [] }),
    complete: async (hash) => { chamadas.push(hash); return { infoHash: hash }; },
  });
  try {
    // páginas: todas devolvem o mesmo shell; o roteador do cliente escolhe a view
    for (const rota of ['/', '/filmes', `/filmes/${H('a')}`, '/trafego', '/conta', '/entrar']) {
      const page = await fetch(`${BASE}${rota}`);
      assert.equal(page.status, 200, rota);
      assert.match(await page.text(), /Monitor ASC/);
    }
    const shell = await fetch(`${BASE}/`);
    const csp = shell.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /font-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    for (const f of ['/style.css', '/tokens.css', '/theme.js', '/lib.js', '/charts.js', '/views.js', '/app.js', '/assets/inter-400.woff2']) {
      assert.equal((await fetch(`${BASE}${f}`)).status, 200, f);
    }
    assert.equal((await fetch(`${BASE}/assets/inter-400.woff2`)).headers.get('content-type'), 'font/woff2');
    // fora da lista: nada de index.html direto, JSON do projeto, rota desconhecida ou travessia
    for (const f of ['/index.html', '/../package.json', '/ui/index.html', '/nao-existe', '/filmes/a/b', '/assets/..%2f..%2fpackage.json', '/assets/%2e%2e/%2e%2e/package.json']) {
      assert.equal((await fetch(`${BASE}${f}`)).status, 404, f);
    }
    // /config.js entrega só o token CSRF, não um arquivo
    assert.match(await (await fetch(`${BASE}/config.js`)).text(), /^window\.ASC_CSRF="[0-9a-f]{64}";$/);

    assert.equal((await fetch(`${BASE}/api/monitor`)).status, 401, 'sem sessão não abre o painel');
    asc.connected = true;
    const ok = await fetch(`${BASE}/api/monitor`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { titles: [] });

    const token = /"([0-9a-f]{64})"/.exec(await (await fetch(`${BASE}/config.js`)).text())[1];
    const post = (headers, body) => fetch(`${BASE}/api/complete`, { method: 'POST', headers, body: JSON.stringify(body) });
    const bom = { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: BASE };
    assert.equal((await post({ 'Content-Type': 'application/json' }, { infoHash: H('a') })).status, 403, 'sem token');
    assert.equal((await post({ ...bom, Origin: 'https://x.org' }, { infoHash: H('a') })).status, 403, 'origem externa');
    assert.equal((await post(bom, { infoHash: 'zz' })).status, 400);
    assert.equal((await post(bom, { infoHash: H('a') })).status, 202);
    assert.deepEqual(chamadas, [H('a')]);

    asc.connected = false;
    assert.equal((await post(bom, { infoHash: H('a') })).status, 401, 'sessão caiu');
  } finally { await new Promise((r) => server.close(r)); }
});

test('servidor recusa Host diferente de 127.0.0.1 (DNS rebinding)', async () => {
  const server = await startConfig({ connected: true, status: () => ({}) }, PORT + 1, null);
  try {
    const http = require('node:http');
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT + 1, path: '/', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
    });
    assert.equal(status, 403);
  } finally { await new Promise((r) => server.close(r)); }
});

test('snapshot: estado e risco por filme, resumo e horas de máquina por dia', () => {
  const now = Date.parse('2026-11-08T20:00:00Z');
  const DIA = 86_400_000;
  const vault = new SeedVault({ file: tmpFile(), now: () => now });
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', vault, freeSpace: () => 50e9 });
  const mk = (hash, name, extra = {}) => { vault.markSeen(hash, { name, torrentPath: `/x/asc-${hash.charCodeAt(0)}.torrent`, freeleech: true, ...extra }); };

  mk(H('a'), 'Parcial com débito');
  vault.setTracker(H('a'), hnr.normalizeHistory({ status: 'downloading', remainingSeedTime: 259200, deadline: new Date(now + 10 * DIA).toISOString().replace('T', ' ').slice(0, 19) }));
  mk(H('b'), 'Semeando'); vault.markCompleted(H('b')); vault.addSeedingTime(H('b'), 12 * 3600_000);
  mk(H('c'), 'Seed parado'); vault.markCompleted(H('c'));
  mk(H('d'), 'Cumprido'); vault.markCompleted(H('d')); vault.addSeedingTime(H('d'), 72 * 3600_000);
  mk(H('e'), 'Prazo vencido'); vault.markCompleted(H('e'));
  vault.get(H('e')).tracker = { checkedAt: now, remainingMs: 3600_000, deadlineMs: now - DIA, satisfied: false, hitAndRun: false };
  b.entries.set(H('f'), { infoHash: H('f'), title: 'Nunca aberto', size: 1000, freeleech: true, torrentPath: '/x/asc-9.torrent' });
  b.client = {
    uploadSpeed: 300, downloadSpeed: 1000,
    torrents: [{ infoHash: H('b'), length: 5000, downloaded: 5000, uploaded: 2000, progress: 1, downloadSpeed: 0, uploadSpeed: 300, numPeers: 4 }],
  };
  b.sampleTraffic(now);

  const snap = b.snapshot(now);
  const por = Object.fromEntries(snap.titles.map((t) => [t.name, t]));
  assert.equal(por['Parcial com débito'].state, 'partial');
  assert.equal(por['Parcial com débito'].risk, 'ok', 'parcial não é pendência do site');
  assert.equal(por['Semeando'].state, 'seeding');
  assert.equal(por['Semeando'].ratio, 0.4);
  assert.equal(por['Seed parado'].state, 'paused');
  assert.equal(por['Seed parado'].risk, 'warn');
  assert.equal(por['Cumprido'].state, 'done');
  assert.equal(por['Prazo vencido'].risk, 'crit');
  assert.equal(por['Nunca aberto'].state, 'unstarted');
  assert.equal(por['Nunca aberto'].ascId, '9');

  const s = snap.summary;
  assert.equal(s.total, 6);
  assert.equal(s.pending, 3); // semeando, parado e vencido
  assert.equal(s.done, 1);
  assert.equal(s.critical, 1);
  assert.equal(s.freeBytes, 50e9);
  assert.equal(s.active, 1);
  // semeiam em paralelo: vale o maior pedido diário, não a soma
  assert.equal(s.machineHoursPerDay, Math.max(...[por['Semeando'], por['Seed parado'], por['Prazo vencido']].map((t) => t.hoursPerDayNeeded)));
  assert.ok(s.machineHoursPerDay > 0);
  assert.equal(snap.traffic.length, 1);
  assert.equal(snap.traffic[0].down, 1000);
  assert.equal(snap.settings.requiredHours, 72);
});

// --- /atividade: obrigações que o tracker já cobra ---
// Linha com o formato real de attention.hitAndRun (A Pele Que Habito, 08/11/2026).
const LINHA_REAL = {
  id: 319164386, torrent: { id: 31598, name: 'A Pele Que Habito (The Skin I Live In)' },
  status: 'pending', seedTime: 13932, remainingSeedTime: 245268,
  deadline: '2026-11-20 04:08:41', completedAt: '2026-11-08 00:16:29', hitAndRunAt: null, forgivenAt: null,
};
const SUMMARY = { hitAndRuns: 0, pendingSeeds: 1, cleared: 0, prisonUntil: null, exempt: false };

test('syncActivity adota no cofre a obrigação do tracker que tem .torrent local', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  const entries = new Map([[H('a'), { infoHash: H('a'), title: 'The Skin I Live In', torrentPath: '/x/asc-31598.torrent', freeleech: true }]]);
  const asc = { activity: async () => ({ summary: SUMMARY, pending: [LINHA_REAL] }) };
  const r = await hnr.syncActivity({ asc, vault, entries });
  assert.equal(r.adopted, 1);
  assert.equal(r.pending[0].local, true);
  const e = vault.get(H('a'));
  assert.ok(e.completedAt, 'concluído segundo o tracker');
  assert.equal(vault.needsSeed(H('a')), true);
  assert.equal(Math.round(vault.remainingMs(H('a')) / 3_600_000), 68);
  assert.equal(e.tracker.deadlineMs, Date.UTC(2026, 10, 20, 4, 8, 41));
  // segunda leitura não duplica nem readota
  assert.equal((await hnr.syncActivity({ asc, vault, entries })).adopted, 0);
});

test('syncActivity lista como sem .torrent local o que não está na biblioteca', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  const asc = { activity: async () => ({ summary: SUMMARY, pending: [LINHA_REAL, { torrent: {} }] }) };
  const r = await hnr.syncActivity({ asc, vault, entries: new Map() });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].local, false);
  assert.equal(r.adopted, 0);
  assert.equal(vault.list().length, 0);
});

test('snapshot: sem arquivo em disco vira "missing"; com arquivo completo fica "paused"; sem .torrent aparece como linha virtual', () => {
  const now = Date.parse('2026-11-08T20:00:00Z');
  const dir = tmpdir('store-');
  const vault = new SeedVault({ file: tmpFile(), now: () => now });
  const lib = (hash, id) => ({ infoHash: hash, title: `Filme ${id}`, torrentPath: `/x/asc-${id}.torrent`, freeleech: true,
    files: [{ path: `f${id}.mkv`, length: 1000, isVideo: true }] });
  const b = new Bridge({ torrentDir: '/tmp', storeDir: dir, vault, freeSpace: () => 1e12 });
  b.entries.set(H('a'), lib(H('a'), 1));
  b.entries.set(H('b'), lib(H('b'), 2));
  for (const h of [H('a'), H('b')]) {
    vault.markSeen(h, { name: h === H('a') ? 'Sem dados' : 'Com dados', torrentPath: b.entries.get(h).torrentPath });
    vault.markCompleted(h);
  }
  fs.writeFileSync(path.join(dir, 'f2.mkv'), Buffer.alloc(1000));
  b.client = { torrents: [], uploadSpeed: 0, downloadSpeed: 0 };
  b.setActivity({ summary: SUMMARY, pending: [{ ascId: '999', name: 'Só no tracker', infoHash: null, local: false,
    snapshot: hnr.normalizeHistory({ completedAt: '2026-11-08 00:00:00', remainingSeedTime: 3600 * 40, deadline: '2026-11-09 20:00:00' }) }] });

  const snap = b.snapshot(now);
  const por = Object.fromEntries(snap.titles.map((t) => [t.name, t]));
  assert.equal(por['Sem dados'].state, 'missing');
  assert.equal(por['Sem dados'].onDisk, 'none');
  assert.equal(por['Com dados'].state, 'paused');
  assert.equal(por['Com dados'].onDisk, 'full');
  assert.equal(por['Só no tracker'].state, 'missing');
  assert.equal(por['Só no tracker'].noTorrent, true);
  assert.equal(por['Só no tracker'].risk, 'crit', 'prazo em 1 dia');
  assert.equal(snap.account.pendingSeeds, 1);
  assert.ok(b.hnrWarnings(now).some((w) => /sem \.torrent local/.test(w)));
  assert.ok(b.hnrWarnings(now).some((w) => /não está completo em disco/.test(w)));
});

test('resumePending não anuncia obrigação concluída sem o arquivo completo', async () => {
  const dir = tmpdir('store-');
  const vault = new SeedVault({ file: tmpFile() });
  const b = new Bridge({ torrentDir: '/tmp', storeDir: dir, vault });
  b.entries.set(H('a'), { infoHash: H('a'), torrentPath: '/x/asc-1.torrent', files: [{ path: 'a.mkv', length: 1000 }] });
  vault.markSeen(H('a'), { name: 'A' });
  vault.markCompleted(H('a'));
  const abertos = [];
  b.client = { torrents: [] };
  b.getTorrent = async (h) => { abertos.push(h); };
  const warn = console.warn; console.warn = () => {};
  try { await b.resumePending(); } finally { console.warn = warn; }
  assert.deepEqual(abertos, [], 'sem dados: não abre');

  fs.writeFileSync(path.join(dir, 'a.mkv'), Buffer.alloc(1000));
  await b.resumePending();
  assert.deepEqual(abertos, [H('a')], 'com dados: retoma o seed');
});

test('snapshot: espaço em disco por filme, total e o que está sem uso (parciais e órfãos)', () => {
  const dir = tmpdir('du-');
  const vault = new SeedVault({ file: tmpFile() });
  const b = new Bridge({ torrentDir: '/tmp', storeDir: dir, vault, freeSpace: () => 5e9 });
  const lib = (hash, id, file) => ({ infoHash: hash, title: `Filme ${id}`, torrentPath: `/x/asc-${id}.torrent`,
    files: [{ path: file, length: 1_000_000, isVideo: true }] });
  b.entries.set(H('a'), lib(H('a'), 1, 'seed.mkv'));      // obrigação aberta
  b.entries.set(H('b'), lib(H('b'), 2, 'parcial.mkv'));   // só streaming
  b.entries.set(H('c'), lib(H('c'), 3, 'nunca.mkv'));     // sem dados
  vault.markSeen(H('a'), { name: 'Em seed', torrentPath: '/x/asc-1.torrent' }); vault.markCompleted(H('a'));
  vault.markSeen(H('b'), { name: 'Parcial', torrentPath: '/x/asc-2.torrent' });
  fs.writeFileSync(path.join(dir, 'seed.mkv'), Buffer.alloc(300_000, 1));
  fs.writeFileSync(path.join(dir, 'parcial.mkv'), Buffer.alloc(200_000, 1));
  fs.mkdirSync(path.join(dir, 'pasta-solta'));
  fs.writeFileSync(path.join(dir, 'pasta-solta', 'orfao.bin'), Buffer.alloc(100_000, 1));
  b.client = { torrents: [], uploadSpeed: 0, downloadSpeed: 0 };

  const snap = b.snapshot();
  const por = Object.fromEntries(snap.titles.map((t) => [t.name, t]));
  assert.ok(por['Em seed'].diskBytes >= 300_000 && por['Em seed'].diskBytes < 400_000);
  assert.ok(por['Parcial'].diskBytes >= 200_000 && por['Parcial'].diskBytes < 300_000);
  assert.equal(por['Filme 3'].diskBytes, 0);
  const s = snap.summary;
  assert.ok(s.diskUsed >= 600_000, 'soma os três arquivos');
  assert.ok(s.diskOrphan >= 100_000 && s.diskOrphan < 200_000, 'arquivo fora da biblioteca');
  // sem uso = parcial + órfão; o que está em seed NÃO conta
  assert.ok(s.diskReclaimable >= s.diskOrphan + por['Parcial'].diskBytes);
  assert.ok(s.diskReclaimable < s.diskUsed - por['Em seed'].diskBytes + 1);
  assert.equal(s.freeBytes, 5e9);
});

test('AscClient guarda o resumo da conta (ratio, upload, download) das páginas autenticadas', async () => {
  const { AscClient, pageProps } = require('../src/asc-client');
  const asc = new AscClient({ delay: 0 });
  assert.equal(asc.accountStats, null);
  asc.captureStats({ auth: { stats: { ratio: 10.6, uploaded: 5, downloaded: 2, seeding: 2, leeching: 0, hitAndRuns: 0, pendingSeeds: 1, extra: 'x' } } });
  assert.deepEqual(asc.accountStats, { ratio: 10.6, uploaded: 5, downloaded: 2, seeding: 2, leeching: 0, hitAndRuns: 0, pendingSeeds: 1 });
  asc.captureStats({ auth: {} });
  assert.equal(asc.accountStats.ratio, 10.6, 'página sem stats não apaga o último resumo');
  asc.captureStats({ auth: { stats: { ratio: 'x' } } });
  assert.equal(asc.accountStats.ratio, null, 'valor inválido vira null');
  void pageProps;
});

test('start() só espera a retomada dos torrents quando resumeOnStart é verdadeiro', async () => {
  const dir = tmpdir('start-');
  for (const [flag, esperado, porta] of [[false, 0, 7197], [true, 1, 7198]]) {
    const b = new Bridge({ torrentDir: dir, storeDir: path.join(dir, 'c'), port: porta, vault: new SeedVault({ file: tmpFile() }), resumeOnStart: flag });
    let chamadas = 0;
    b.resumePending = async () => { chamadas += 1; };
    const log = console.log; console.log = () => {};
    try { await b.start(); } finally { console.log = log; }
    assert.equal(chamadas, esperado, `resumeOnStart=${flag}`);
    await b.stop();
  }
});

test('o painel usa o título do tracker no lugar do nome do arquivo', async () => {
  const vault = new SeedVault({ file: tmpFile() });
  const entries = new Map([[H('a'), { infoHash: H('a'), title: 'The Skin I Live In 2011 Bluray', torrentPath: '/x/asc-31598.torrent' }]]);
  const asc = { activity: async () => ({ summary: SUMMARY, pending: [LINHA_REAL] }) };
  await hnr.syncActivity({ asc, vault, entries });
  assert.equal(vault.get(H('a')).displayName, 'A Pele Que Habito (The Skin I Live In)');
  // markSeen com o nome do arquivo (ao abrir o torrent) não apaga o título do tracker
  vault.markSeen(H('a'), { name: 'The.Skin.I.Live.In.2011.mkv' });
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', vault });
  b.entries = entries;
  b.client = { torrents: [], uploadSpeed: 0, downloadSpeed: 0 };
  const t = b.snapshot().titles.find((x) => x.infoHash === H('a'));
  assert.equal(t.name, 'A Pele Que Habito (The Skin I Live In)');
  // e o reconcile (página do torrent) também preenche
  const v2 = new SeedVault({ file: tmpFile() });
  v2.markSeen(H('b'), { torrentPath: '/x/asc-9.torrent', name: 'arquivo.mkv' });
  await hnr.reconcile({ asc: { history: async () => ({ history: null, freeleech: false, name: 'Filme Bonito' }) }, vault: v2 });
  assert.equal(v2.get(H('b')).displayName, 'Filme Bonito');
});

// --- /api/logs ---
test('API de logs: consulta com filtros, cursor, download, arquivos e nível', async () => {
  const { Logger } = require('../src/logger');
  const dir = tmpdir('apilogs-');
  const logs = new Logger({ dir });
  logs.addSecret('s3gredo-muito-secreto');
  logs.write('debug', 'ponte', 'GET /s/aaaa → 206');
  logs.write('info', 'vault', 'torrent concluído');
  logs.write('warn', 'hnr', 'prazo curto', { dias: 2 });
  logs.write('error', 'asc', 'sessão expirada s3gredo-muito-secreto');
  const asc = { connected: false, status: () => ({ connected: false }) }; // sem sessão: logs continuam acessíveis
  const P = PORT + 5;
  const base = `http://127.0.0.1:${P}`;
  const server = await startConfig(asc, P, null, logs);
  try {
    assert.equal((await fetch(`${base}/logs`)).status, 200, 'página /logs');
    const get = async (qs) => (await fetch(`${base}/api/logs${qs}`)).json();

    const all = await get('');
    assert.equal(all.level, 'debug');
    assert.deepEqual(all.levels, ['debug', 'info', 'warn', 'error']);
    assert.ok(all.boot && all.lastId >= 4);
    assert.deepEqual(all.sources.slice().sort(), ['asc', 'config', 'hnr', 'ponte', 'vault']);
    assert.equal(JSON.stringify(all).includes('s3gredo-muito-secreto'), false, 'segredo nunca sai pela API');
    assert.deepEqual((await get('?nivel=warn,error')).entries.map((e) => e.src), ['hnr', 'asc']);
    assert.deepEqual((await get('?fonte=vault')).entries.map((e) => e.msg), ['torrent concluído']);
    assert.deepEqual((await get('?q=dias')).entries.map((e) => e.msg), ['prazo curto']);
    assert.equal((await get('?limit=1')).entries.length, 1);
    const cursor = (await get('?nivel=warn,error')).entries[0].id;
    assert.deepEqual((await get(`?after=${cursor}`)).entries.map((e) => e.src).filter((s) => s !== 'config'), ['asc']);
    assert.equal((await get('?nivel=error')).counts.warn, 1, 'contagens ignoram o filtro de nível');

    // download filtrado: anexo, formato e conteúdo
    const txt = await fetch(`${base}/api/logs/download?nivel=warn,error`);
    assert.match(txt.headers.get('content-disposition'), /^attachment; filename="asc-logs-\d{8}-\d{6}\.txt"$/);
    assert.match(txt.headers.get('content-type'), /^text\/plain/);
    const linhas = (await txt.text()).trim().split('\n');
    assert.equal(linhas.length, 2);
    assert.match(linhas[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN  \[hnr\] prazo curto \{"dias":2\}$/);
    const nd = await fetch(`${base}/api/logs/download?formato=ndjson&fonte=hnr`);
    assert.match(nd.headers.get('content-type'), /ndjson/);
    assert.equal(JSON.parse((await nd.text()).trim()).msg, 'prazo curto');

    // arquivos no disco
    const files = (await (await fetch(`${base}/api/logs/files`)).json()).files;
    assert.equal(files.length, 1);
    const f = await fetch(`${base}/api/logs/file?nome=${files[0].name}`);
    assert.equal(f.status, 200);
    assert.match(f.headers.get('content-disposition'), /attachment/);
    assert.equal((await f.text()).includes('s3gredo-muito-secreto'), false, 'segredo nunca no arquivo baixado');
    for (const ruim of ['../../etc/passwd', 'notas.txt', '..%2f..%2fpackage.json', 'brazuka-1999-01-01.log', '']) {
      assert.equal((await fetch(`${base}/api/logs/file?nome=${ruim}`)).status, 404, ruim);
    }

    // nível em tempo de execução: só com token CSRF
    const token = /"([0-9a-f]{64})"/.exec(await (await fetch(`${base}/config.js`)).text())[1];
    const post = (headers, body) => fetch(`${base}/api/logs/level`, { method: 'POST', headers, body: JSON.stringify(body) });
    const bom = { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Origin: base };
    assert.equal((await post({ 'Content-Type': 'application/json' }, { nivel: 'warn' })).status, 403);
    assert.equal(logs.level, 'debug', 'recusado não altera');
    assert.equal((await post(bom, { nivel: 'banana' })).status, 400);
    assert.equal((await post(bom, { nivel: 'warn' })).status, 200);
    assert.equal(logs.level, 'warn');

    // o painel registra o que importa (recusa CSRF) e NÃO registra o próprio polling
    logs.setLevel('debug');
    const antes = logs.entries.filter((e) => e.src === 'config').length;
    for (let i = 0; i < 5; i++) await get('');
    await fetch(`${base}/api/status`);
    assert.equal(logs.entries.filter((e) => e.src === 'config').length, antes, 'polling não gera log');
    assert.ok(logs.entries.some((e) => e.src === 'config' && e.level === 'warn' && /CSRF/.test(e.msg)));
  } finally { await new Promise((r) => server.close(r)); }
});
