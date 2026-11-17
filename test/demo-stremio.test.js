const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { startDemoStremio, parseArgs, MOVIE_ID, SERIES_ID, MOVIE_ROWS, SERIES_ROWS } = require('../scripts/demo-stremio');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
const json = async (url) => { const r = await get(url); assert.equal(r.status, 200, r.body); return JSON.parse(r.body); };

async function subir(t, opcoes = {}) {
  const demo = await startDemoStremio({ port: 0, ...opcoes });
  t.after(() => demo.close());
  return demo;
}

test('argumentos: --status liga o catálogo; porta vem de DEMO_STREMIO_PORT', () => {
  assert.deepEqual(parseArgs([], {}), { status: false, port: 0 });
  assert.deepEqual(parseArgs(['--status'], { DEMO_STREMIO_PORT: '18030' }), { status: true, port: 18030 });
  assert.throws(() => parseArgs(['--outra'], {}), /argumento desconhecido/);
  assert.throws(() => parseArgs([], { DEMO_STREMIO_PORT: 'x' }), /DEMO_STREMIO_PORT/);
});

test('escuta só em 127.0.0.1, com manifesto válido sob credencial efêmera', async (t) => {
  const demo = await subir(t);
  assert.equal(demo.server.address().address, '127.0.0.1');
  assert.match(demo.manifestUrl, /^http:\/\/127\.0\.0\.1:\d+\/ascc_[A-Za-z0-9_-]{43}\/manifest\.json$/);
  const manifest = await json(demo.manifestUrl);
  // O Stremio substitui por id: o demo nunca pode ter o id (nem o nome) do addon real do dono.
  const real = require('../src/addon').createAddon().manifest;
  assert.notEqual(manifest.id, real.id);
  assert.equal(manifest.id, 'local.amigosshare.stremio.demo');
  assert.notEqual(manifest.name, real.name);
  assert.match(manifest.name, /demonstração/);
  assert.ok(manifest.resources.includes('stream'));
  // Sem credencial, o addon real recusa: a demonstração mantém a mesma porta autenticada.
  assert.equal((await get(`http://127.0.0.1:${demo.port}/manifest.json`)).status, 403);
  // Anti DNS rebinding também vale aqui.
  assert.equal((await get(demo.manifestUrl, { Host: 'exemplo.com' })).status, 403);
});

test('filme: fontes fictícias exercitam freeleech, custo no ratio e poucos seeders', async (t) => {
  const demo = await subir(t);
  const { streams } = await json(`${demo.base}/stream/movie/${MOVIE_ID}.json`);
  assert.ok(streams.length >= 3);
  const texto = streams.map((s) => `${s.name}\n${s.description}`);
  assert.ok(texto.some((x) => x.includes('🆓')), 'um release freeleech');
  assert.ok(texto.some((x) => x.includes('⚠ Não é freeleech')), 'aviso de custo no ratio');
  assert.ok(texto.some((x) => /👤 [1-3] seeders/.test(x)), 'um release com poucos seeders');
  // Nada é tocável: toda URL aponta para o loopback inexistente.
  for (const s of streams) assert.match(s.url, /^http:\/\/127\.0\.0\.1:1\//);
});

test('série: pack com "Este episódio" e aviso de não suportado quando nada toca', async (t) => {
  const demo = await subir(t);
  const e1 = (await json(`${demo.base}/stream/series/${SERIES_ID}:1:1.json`)).streams;
  assert.ok(e1.some((s) => /Pacote: /.test(s.description) && /Este episódio: /.test(s.description)));
  const e6 = (await json(`${demo.base}/stream/series/${SERIES_ID}:1:6.json`)).streams;
  assert.equal(e6.length, 1);
  assert.match(e6[0].name, /não suportado/i);
  assert.equal(e6[0].url, undefined);
});

test('catálogo de status só existe com --status e usa instantâneo fictício', async (t) => {
  const sem = await subir(t);
  const m1 = await json(sem.manifestUrl);
  assert.ok(!m1.catalogs.some((c) => c.id === 'asc-status'));
  assert.deepEqual((await json(`${sem.base}/catalog/movie/asc-status.json`)).metas, []);

  const com = await subir(t, { status: true });
  const m2 = await json(com.manifestUrl);
  assert.ok(m2.catalogs.some((c) => c.id === 'asc-status'));
  const { metas } = await json(`${com.base}/catalog/movie/asc-status.json`);
  assert.ok(metas.length >= 3);
  assert.ok(metas.every((m) => m.poster.startsWith(`${com.base}/status/poster/`)));
  assert.match(JSON.stringify(metas), /Ratio|ratio/);
  assert.ok((await get(metas[0].poster)).body.startsWith('<svg'));
});

test('nenhum dado real: pasta temporária própria, só nomes sintéticos, sem passkey', async (t) => {
  const demo = await subir(t, { status: true });
  assert.ok(demo.dataDir.startsWith(os.tmpdir()));
  assert.ok(fs.existsSync(path.join(demo.dataDir, 'credentials.json')));
  const filme = await json(`${demo.base}/stream/movie/${MOVIE_ID}.json`);
  const serie = await json(`${demo.base}/stream/series/${SERIES_ID}:1:1.json`);
  const status = await json(`${demo.base}/catalog/movie/asc-status.json`);
  const tudo = JSON.stringify([filme, serie, status]);
  assert.ok(!/passkey|announce|private/i.test(tudo));
  // Os nomes de release inventados terminam no grupo fictício, nunca em grupos reais.
  for (const row of [...MOVIE_ROWS, ...SERIES_ROWS]) assert.match(row.name, /-DEMO$/, row.name);
});

test('close apaga a pasta temporária e libera a porta', async () => {
  const demo = await startDemoStremio({ port: 0 });
  const { dataDir, port } = demo;
  await demo.close();
  assert.equal(fs.existsSync(dataDir), false);
  await assert.rejects(get(`http://127.0.0.1:${port}/`));
});
