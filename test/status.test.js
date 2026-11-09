const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../src/stremio-status');
const { createAddon } = require('../src/addon');

const BASE = 'http://127.0.0.1:7000';
const PANEL = 'http://127.0.0.1:7020';
const H = (c) => c.repeat(40);

const titulo = (o) => ({ infoHash: H('a'), name: 'Filme', state: 'seeding', risk: 'ok', seededHours: 10, requiredHours: 72, progress: 1, daysLeft: 9, freeleech: true, tracker: null, warnings: [], ...o });
const snap = (over = {}) => ({
  generatedAt: new Date().toISOString(),
  summary: { total: 21, pending: 2, hoursPending: 137, machineHoursPerDay: 5.9, diskUsed: 17.6 * 1024 ** 3, freeBytes: 349 * 1024 ** 3, ...over.summary },
  account: { hitAndRuns: 0, pendingSeeds: 2, prisonUntil: null, exempt: false, cleared: 0, ...over.account },
  stats: { ratio: 10.6, uploaded: 18e12, downloaded: 1.7e12, ...over.stats },
  notices: over.notices ?? [],
  titles: over.titles ?? [titulo({ name: 'A Pele Que Habito (The Skin I Live In)' }), titulo({ infoHash: H('b'), name: 'Perdido em Marte', progress: 0.4, state: 'completing' })],
});

test('resumo: verde com tudo em dia e traz ratio, biblioteca, seed e disco', () => {
  const [resumo] = kit.buildItems(snap(), { panelUrl: PANEL });
  assert.equal(resumo.id, 'resumo');
  assert.equal(resumo.tone, 'ok');
  assert.match(resumo.name, /tudo em dia/);
  for (const t of [/Ratio 10,6/, /21 filme\(s\)/, /137 h em 2 filme\(s\)/, /17,6 GB ocupados/, /Hit-and-run: 0 · prisão: nenhuma/, /7020/]) assert.match(resumo.description, t);
  assert.match(resumo.releaseInfo, /Ratio 10,6/);
});

test('resumo muda de tom e título com o risco: aviso, crítico, HnR e prisão', () => {
  const tone = (s) => kit.buildItems(s, { panelUrl: PANEL })[0];
  assert.equal(tone(snap({ titles: [titulo({ risk: 'warn', warnings: ['prazo curto'] })] })).tone, 'warn');
  assert.equal(tone(snap({ notices: ['Último login há 65 dias'] })).tone, 'warn');
  assert.equal(tone(snap({ stats: { ratio: 0.8 } })).tone, 'warn', 'ratio abaixo de 1,0');
  const crit = tone(snap({ titles: [titulo({ risk: 'crit', warnings: ['seed parado'] })] }));
  assert.equal(crit.tone, 'crit');
  assert.match(crit.name, /aja agora/);
  assert.equal(tone(snap({ account: { hitAndRuns: 1 } })).tone, 'crit');
  assert.equal(tone(snap({ account: { prisonUntil: '2026-11-20T00:00:00Z' } })).tone, 'crit');
});

test('avisos viram itens (críticos primeiro), a conta e os filmes em andamento aparecem', () => {
  const items = kit.buildItems(snap({
    notices: ['Último login há 65 dias'],
    titles: [titulo({ name: 'Calmo' }), titulo({ infoHash: H('c'), name: 'Urgente', risk: 'crit', state: 'paused', warnings: ['Urgente: seed parado e prazo em 1 dia'] }),
      titulo({ infoHash: H('d'), name: 'Atenção', risk: 'warn', warnings: ['Atenção: prazo curto'] }), titulo({ infoHash: H('e'), name: 'Nunca aberto', state: 'unstarted' })],
  }), { panelUrl: PANEL });
  const ids = items.map((i) => i.id);
  assert.equal(ids[0], 'resumo');
  const avisos = items.filter((i) => i.id.startsWith('aviso-'));
  assert.equal(avisos.length, 3);
  assert.equal(avisos[0].tone, 'crit', 'crítico primeiro');
  assert.ok(ids.includes('conta'));
  assert.ok(!items.some((i) => i.name === 'Nunca aberto'), 'filme não iniciado não polui o catálogo');
  assert.equal(new Set(ids).size, ids.length, 'ids únicos');
  assert.ok(ids.every((i) => /^[a-z0-9-]{1,40}$/.test(i)), 'ids só com caracteres seguros');
});

test('sem dados ainda (addon acabou de subir): um item neutro, sem erro', () => {
  const items = kit.buildItems(null, { panelUrl: PANEL });
  assert.equal(items.length, 1);
  assert.equal(items[0].tone, 'neutral');
});

test('catálogo e meta: pôster absoluto por item e meta só para id existente', () => {
  const items = kit.buildItems(snap(), { panelUrl: PANEL });
  const metas = kit.catalogMetas(items, `${BASE}/`);
  assert.ok(metas.every((m) => m.type === 'movie' && m.id.startsWith('ascstatus:') && m.poster.startsWith(`${BASE}/status/poster/`) && m.poster.endsWith('.svg')));
  assert.equal(metas[0].id, 'ascstatus:resumo');
  assert.equal(kit.metaFor(items, 'ascstatus:resumo', BASE).name, items[0].name);
  assert.equal(kit.metaFor(items, 'ascstatus:nao-existe', BASE), null);
});

test('alerta no topo das fontes só com risco crítico, HnR ou prisão', () => {
  assert.equal(kit.alertStream(snap(), PANEL), null);
  assert.equal(kit.alertStream(snap({ titles: [titulo({ risk: 'warn' })] }), PANEL), null, 'aviso comum não incomoda');
  const a = kit.alertStream(snap({ titles: [titulo({ risk: 'crit', warnings: ['A Odisseia: seed parado'] })] }), PANEL);
  assert.match(a.name, /Monitor ASC/);
  assert.match(a.description, /seed parado/);
  assert.equal(a.externalUrl, `${PANEL}/filmes?estado=atencao`);
  assert.ok(kit.alertStream(snap({ account: { hitAndRuns: 1 } }), PANEL));
  assert.ok(kit.alertStream(snap({ account: { prisonUntil: '2026-11-20T00:00:00Z' } }), PANEL));
  assert.equal(kit.alertStream(null, PANEL), null);
});

test('pôster SVG: escapa texto de terceiros e usa a cor do tom', () => {
  const svg = kit.posterSvg({ id: 'x', tone: 'crit', headline: 'Aja agora', lines: ['<script>alert(1)</script> & "aspas"', 'segunda linha'] });
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /<script/i);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /#ff6a65/);
  assert.match(kit.posterSvg({ id: 'y', tone: 'ok', headline: 'Tudo em dia', lines: [] }), /#38d080/);
});

test('rota dos pôsteres: só ids existentes no estado atual, sem injeção por URL', () => {
  const res = () => ({ status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = String(b ?? ''); } });
  const get = (url, method = 'GET') => { const r = res(); const used = kit.posterRoute({ url, method }, r, () => snap(), PANEL); return { used, r }; };
  const ok = get('/status/poster/resumo.svg');
  assert.equal(ok.used, true);
  assert.equal(ok.r.status, 200);
  assert.match(ok.r.headers['Content-Type'], /image\/svg\+xml/);
  assert.match(ok.r.body, /<svg/);
  assert.equal(get('/status/poster/nao-existe.svg').r.status, 404);
  for (const ruim of ['/status/poster/../../etc/passwd.svg', '/status/poster/RESUMO.svg', '/status/poster/resumo.svg%00', '/outra/rota', '/manifest.json']) assert.equal(get(ruim).used, false, ruim);
  assert.equal(get('/status/poster/resumo.svg', 'POST').used, false);
  // snapshot que lança não derruba o servidor
  const r = res();
  assert.equal(kit.posterRoute({ url: '/status/poster/resumo.svg', method: 'GET' }, r, () => { throw new Error('x'); }, PANEL), true);
  assert.equal(r.status, 404);
});

test('addon: manifesto, catálogo, meta e stream de status; alerta nas fontes ASC', async () => {
  const quente = snap({ titles: [titulo({ risk: 'crit', name: 'Urgente', warnings: ['Urgente: seed parado'] })] });
  const remote = { catalog: async () => [], meta: () => null, streamsFor: async () => [{ name: 'ASC', url: 'http://x/s/1/0' }], findStreams: async () => [{ name: 'ASC', url: 'http://x/s/1/0' }] };
  const addon = createAddon({ remote, status: { snapshot: () => quente, posterBase: BASE, panelUrl: PANEL } });
  assert.ok(addon.manifest.catalogs.some((c) => c.id === 'asc-status' && c.type === 'movie'));
  assert.ok(addon.manifest.idPrefixes.includes('ascstatus:'));
  const cat = await addon.get('catalog', 'movie', 'asc-status', {});
  assert.equal(cat.metas[0].id, 'ascstatus:resumo');
  assert.match(cat.metas[0].name, /aja agora/);
  assert.equal(cat.cacheMaxAge, 0);
  const meta = await addon.get('meta', 'movie', 'ascstatus:resumo', {});
  assert.match(meta.meta.description, /Ratio 10,6/);
  const st = await addon.get('stream', 'movie', 'ascstatus:resumo', {});
  assert.equal(st.streams[0].externalUrl, `${PANEL}/`);
  const fontes = await addon.get('stream', 'movie', 'ascfilm:123', {});
  assert.equal(fontes.streams.length, 2);
  assert.match(fontes.streams[0].name, /Monitor ASC/, 'alerta vem primeiro');
  assert.equal(fontes.streams[1].name, 'ASC');
  const imdb = await addon.get('stream', 'movie', 'tt1254207', {});
  assert.match(imdb.streams[0].name, /Monitor ASC/);
});

test('addon sem status: nada de catálogo extra nem alerta', async () => {
  const remote = { catalog: async () => [], meta: () => null, streamsFor: async () => [{ name: 'ASC', url: 'http://x' }], findStreams: async () => [] };
  const addon = createAddon({ remote });
  assert.ok(!addon.manifest.catalogs.some((c) => c.id === 'asc-status'));
  assert.ok(!addon.manifest.idPrefixes.includes('ascstatus:'));
  assert.equal((await addon.get('stream', 'movie', 'ascfilm:1', {})).streams.length, 1);
  // status calmo: o alerta não aparece
  const calmo = createAddon({ remote, status: { snapshot: () => snap(), posterBase: BASE, panelUrl: PANEL } });
  assert.equal((await calmo.get('stream', 'movie', 'ascfilm:1', {})).streams.length, 1);
});
