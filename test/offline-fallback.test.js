const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAscProvider } = require('../src/asc-provider');
const { createAddon } = require('../src/addon');
const { MetaCache, VERSION, STALE_AFTER_MS, EXPIRE_AFTER_MS, MAX_TITLES, MAX_BYTES } = require('../src/meta-cache');
const { AscError } = require('../src/asc-client');
const { tmpdir } = require('./tmp-helper');

const DIA = 24 * 3600_000;
const IMDB = 'tt0111161';
const hashDe = (id) => String(id).padStart(40, 'b');
const linha = (id, extra = {}) => ({
  id, name: `Filme ${id}`, size: 4e9, seeders: 9, leechers: 1, timesCompleted: 50, freeleech: true,
  badges: [{ label: '1080p', kind: 'resolution' }, { label: 'WEB-DL', kind: 'source' }], ...extra,
});

// Relógio controlável, ASC e ponte falsos. `disco` diz o estado de cada release em disco.
function cenario(t, { disco = { 1: 'full' }, rows = [linha(1), linha(2)] } = {}) {
  const dir = tmpdir('offline-');
  const relogio = { agora: Date.UTC(2026, 5, 1) };
  const now = () => relogio.agora;
  const file = path.join(dir, 'meta-cache.json');
  const cache = new MetaCache({ file, now }).load();
  const entries = new Map();
  const concluidos = new Set([hashDe(1), hashDe(2)]);
  const bridge = {
    entries,
    vault: { get: (hash) => (concluidos.has(hash) ? { completedAt: 1 } : null) },
    lazyUrl: (id) => `http://127.0.0.1:7010/a/${id}`,
    urlFor: (hash, idx) => `http://127.0.0.1:7010/s/${hash}/${idx}?k=TOKEN`,
    diskState: (hash) => disco[Number(hash.replace(/^b+/, ''))] ?? 'none',
    entryByAscId(id) { return [...entries.values()].find((e) => path.basename(e.torrentPath) === `asc-${id}.torrent`) ?? null; },
  };
  for (const id of [1, 2]) {
    entries.set(hashDe(id), { infoHash: hashDe(id), torrentPath: path.join(dir, `asc-${id}.torrent`),
      files: [{ index: 0, path: `filme-${id}.mkv`, length: 4e9, isVideo: true }] });
  }
  const estado = { falha: null, buscas: 0, downloads: 0, connected: true, saved: true };
  const asc = {
    get connected() { return estado.connected; },
    get saved() { return estado.saved; },
    onlyFreeleech: false,
    async search() { estado.buscas++; if (estado.falha) throw estado.falha; return rows; },
    async download() { estado.downloads++; return Buffer.from('x'); },
  };
  const provider = createAscProvider(asc, bridge, dir, { cache, now });
  const recarregar = () => createAscProvider(asc, bridge, dir, { cache: new MetaCache({ file, now }).load(), now });
  return { provider, cache, estado, concluidos, relogio, bridge, dir, file, now, recarregar, asc };
}
const video = { type: 'movie', imdbId: IMDB };
const rede = () => new AscError('Não foi possível conectar ao ASC. Tente novamente.', 'network');
const sessao = () => new AscError('Sessão expirada. Entre novamente.', 'session');

test('site fora do ar: cai para o arquivo local completo e diz por quê, sem baixar nada', async (t) => {
  const c = cenario(t, { disco: { 1: 'full', 2: 'partial' } });
  assert.equal((await c.provider.lookup(video)).streams.length, 2, 'online lista as duas fontes');
  c.estado.falha = rede();
  const r = await c.provider.lookup(video);
  assert.equal(r.offline.kind, 'network');
  assert.match(r.offline.message, /sem conexão/);
  assert.equal(r.streams.length, 1, 'só o release 1 está completo; o parcial não vira fonte offline');
  assert.equal(r.streams[0].url, `http://127.0.0.1:7010/s/${hashDe(1)}/0?k=TOKEN`, 'URL direta da ponte, não /a/<id>');
  assert.match(r.streams[0].description, /Fontes online indisponíveis/);
  assert.match(r.streams[0].description, /completo neste computador/);
  assert.doesNotMatch(r.streams[0].description, /seeders|freeleech|🆓/i, 'não presume seeders nem freeleech');
  assert.equal(c.estado.downloads, 0, 'nenhum .torrent baixado');
  assert.equal(c.provider.availability().online, false);
});

test('sessão expirada: motivo distinto e nenhuma nova consulta em laço', async (t) => {
  const c = cenario(t);
  await c.provider.lookup(video);
  c.estado.falha = sessao();
  c.estado.connected = false;
  const r = await c.provider.lookup(video);
  assert.equal(r.offline.kind, 'session');
  assert.match(r.offline.message, /sessão do ASC/);
  const buscas = c.estado.buscas;
  c.relogio.agora += 10 * 60_000;
  for (let i = 0; i < 5; i++) assert.equal((await c.provider.lookup(video)).offline.kind, 'session');
  assert.equal(c.estado.buscas, buscas, 'sessão inválida: o site não é consultado de novo');
  // o operador entra de novo no painel: volta a consultar
  c.estado.falha = null;
  c.estado.connected = true;
  const volta = await c.provider.lookup(video);
  assert.equal(volta.offline, null);
  assert.equal(c.estado.buscas, buscas + 1);
  assert.equal(c.provider.availability().online, true);
});

test('falha de rede respeita um intervalo antes de tentar o site de novo', async (t) => {
  const c = cenario(t);
  await c.provider.lookup(video);
  c.estado.falha = rede();
  const antes = c.estado.buscas;
  await c.provider.lookup(video);
  await c.provider.lookup(video);
  await c.provider.lookup(video);
  assert.equal(c.estado.buscas, antes + 1, 'uma tentativa; as outras caem direto no local');
  c.relogio.agora += 31_000;
  await c.provider.lookup(video);
  assert.equal(c.estado.buscas, antes + 2);
});

test('nunca conectou nem tem sessão salva: nem tenta o site', async (t) => {
  const c = cenario(t);
  c.estado.connected = false;
  c.estado.saved = false;
  const r = await c.provider.lookup(video);
  assert.equal(r.offline.kind, 'session');
  assert.equal(c.estado.buscas, 0);
});

test('ausência real de resultados não é confundida com indisponibilidade', async (t) => {
  const c = cenario(t, { rows: [] });
  const r = await c.provider.lookup(video);
  assert.deepEqual(r, { streams: [], offline: null });
  assert.equal(c.provider.availability().online, true);
});

test('filme nunca consultado ou arquivo removido: nada é anunciado', async (t) => {
  const c = cenario(t);
  await c.provider.lookup(video);
  c.estado.falha = rede();
  assert.deepEqual((await c.provider.lookup({ type: 'movie', imdbId: 'tt9999999' })).streams, [], 'sem mapeamento conhecido');
  c.bridge.entries.delete(hashDe(1)); // .torrent removido
  c.relogio.agora += 31_000;
  assert.deepEqual((await c.provider.lookup(video)).streams, [], 'release que saiu da biblioteca não aparece');
  // série segue sem fontes
  assert.deepEqual((await c.provider.lookup({ type: 'series', imdbId: IMDB, season: 1, episode: 1 })).streams, []);
});

test('tamanho cheio sem conclusão registrada no cofre (arquivo esparso de streaming) não vira fonte offline', async (t) => {
  const c = cenario(t);
  await c.provider.lookup(video);
  c.estado.falha = rede();
  c.concluidos.delete(hashDe(1));
  assert.deepEqual((await c.provider.lookup(video)).streams, []);
  c.concluidos.add(hashDe(1));
  c.relogio.agora += 31_000;
  assert.equal((await c.provider.lookup(video)).streams.length, 1);
});

test('arquivo removido do disco (sem dados) deixa de ser anunciado', async (t) => {
  const disco = { 1: 'full' };
  const c = cenario(t, { disco });
  await c.provider.lookup(video);
  c.estado.falha = rede();
  assert.equal((await c.provider.lookup(video)).streams.length, 1);
  disco[1] = 'none';
  c.relogio.agora += 31_000;
  assert.equal((await c.provider.lookup(video)).streams.length, 0);
});

test('depois de reiniciar: o mapeamento vem do disco e continua utilizável', async (t) => {
  const c = cenario(t);
  await c.provider.lookup(video);
  assert.ok(fs.existsSync(c.file));
  const reiniciado = c.recarregar();
  c.estado.falha = rede();
  const r = await reiniciado.lookup(video);
  assert.equal(r.streams.length, 1);
  assert.equal(r.streams[0].behaviorHints.filename, 'filme-1.mkv');
});

test('cache antigo: marcado como desatualizado; vencido: descartado', async (t) => {
  const c = cenario(t);
  await c.provider.lookup(video);
  c.estado.falha = rede();
  c.relogio.agora += STALE_AFTER_MS + DIA;
  const velho = await c.provider.lookup(video);
  assert.equal(velho.streams.length, 1);
  assert.match(velho.streams[0].description, /podem estar desatualizados/);
  c.relogio.agora += EXPIRE_AFTER_MS;
  const vencido = await c.recarregar().lookup(video);
  assert.deepEqual(vencido.streams, [], 'vencido: o mapeamento deixa de valer');
  assert.equal(vencido.offline.kind, 'network');
});

test('cache corrompido, de outra versão ou grande demais é ignorado sem derrubar', (t) => {
  const dir = tmpdir('offline-cache-');
  const file = path.join(dir, 'meta-cache.json');
  for (const conteudo of ['{não é json', JSON.stringify({ version: VERSION + 1, titles: {} }), '[]', 'null', JSON.stringify({ version: VERSION, titles: 7 }), 'x'.repeat(MAX_BYTES * 2 + 1)]) {
    fs.writeFileSync(file, conteudo);
    const cache = new MetaCache({ file }).load();
    assert.equal(cache.get(IMDB), null);
    cache.set(IMDB, [linha(1)]); // volta a gravar por cima
    assert.equal(new MetaCache({ file }).load().get(IMDB).releases[0].id, 1);
  }
});

test('o cache guarda só apresentação: sem seeders, freeleech, cookie, passkey ou URL', (t) => {
  const dir = tmpdir('offline-cache-');
  const file = path.join(dir, 'meta-cache.json');
  const cache = new MetaCache({ file });
  cache.set(IMDB, [linha(7, { passkey: 'SEGREDO', cookie: 'c=1', download: 'https://x/torrents/7/download?passkey=SEGREDO', name: 'Nome\u0000com\ncontrole' })]);
  const bruto = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(bruto, /SEGREDO|cookie|download|seeders|freeleech|passkey/i);
  assert.equal(JSON.parse(bruto).titles[IMDB].releases[0].name, 'Nome com controle');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['meta-cache.json'], 'sem temporário esquecido');
});

test('limites: máximo de títulos e releases por título; busca vazia invalida', () => {
  const dir = tmpdir('offline-cache-');
  const file = path.join(dir, 'meta-cache.json');
  let agora = 1_800_000_000_000;
  const cache = new MetaCache({ file, now: () => agora });
  for (let i = 1; i <= MAX_TITLES + 20; i++) { agora += 1000; cache.set(`tt${String(i).padStart(7, '0')}`, [linha(i)]); }
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).titles).length, MAX_TITLES);
  const muitos = Array.from({ length: 40 }, (_, i) => linha(i + 1));
  cache.set(IMDB, muitos);
  assert.equal(cache.get(IMDB).releases.length, 12);
  cache.set(IMDB, []);
  assert.equal(cache.get(IMDB), null, 'o site disse que não há resultados: o mapeamento antigo cai');
  cache.set('inválido', [linha(1)]);
  assert.equal(cache.get('inválido'), null);
});

test('falha ao gravar o cache não derruba a busca online', async (t) => {
  const c = cenario(t);
  fs.rmSync(c.dir, { recursive: true, force: true });
  fs.writeFileSync(c.dir, 'arquivo no lugar da pasta'); // mkdir/rename falham
  const r = await c.provider.lookup(video);
  assert.equal(r.streams.length, 2);
  fs.rmSync(c.dir, { force: true });
});

test('addon: com o ASC fora do ar, o pedido IMDb traz o aviso e o arquivo local; player com URL antiga segue o /a/<id>', async (t) => {
  const c = cenario(t);
  await c.provider.lookup(video);
  c.estado.falha = rede();
  const addon = createAddon({ remote: c.provider, status: { snapshot: () => ({}), posterBase: 'http://x', panelUrl: 'http://127.0.0.1:7020' } });
  const r = await addon.get('stream', 'movie', IMDB, {});
  assert.equal(r.streams.length, 2);
  assert.match(r.streams[0].name, /ASC indisponível/);
  assert.match(r.streams[0].description, /sem conexão/);
  assert.equal(r.streams[0].externalUrl, 'http://127.0.0.1:7020/');
  assert.match(r.streams[1].url, /\/s\/b+1\/0/);
  assert.equal(c.estado.downloads, 0);
  // sem arquivo local: avisa mesmo assim, sem prometer fonte
  const vazio = await addon.get('stream', 'movie', 'tt9999999', {});
  assert.equal(vazio.streams.length, 1);
  assert.match(vazio.streams[0].description, /Nenhum arquivo deste filme está completo/);
  // URL antiga (/a/<id>) de um release já baixado: o resolve usa o arquivo local, sem baixar .torrent
  assert.deepEqual(await c.provider.resolve('1'), { infoHash: hashDe(1), fileIdx: 0 });
  assert.equal(c.estado.downloads, 0);
});

test('addon: catálogo local reflete o disco (removido some, incompleto é marcado) e catálogo online não explode', async () => {
  const base = { infoHash: hashDe(1), kind: 'movie', size: 1e9, name: 'a', files: [{ index: 0, path: 'a.mkv', length: 1e9 }], videos: [{ index: 0, path: 'a.mkv' }] };
  const itens = [
    { ...base, id: `asc:${hashDe(1)}`, title: 'Completo', disk: 'full' },
    { ...base, infoHash: hashDe(2), id: `asc:${hashDe(2)}`, title: 'Parcial', disk: 'partial' },
    { ...base, infoHash: hashDe(3), id: `asc:${hashDe(3)}`, title: 'Removido', disk: 'none' },
  ];
  const remote = { catalog: async () => { throw rede(); }, meta: () => null, streamsFor: async () => [], lookup: async () => ({ streams: [], offline: null }) };
  const addon = createAddon({ remote, localEntries: () => itens });
  const cat = await addon.get('catalog', 'movie', 'asc', {});
  assert.deepEqual(cat.metas.map((m) => m.name), ['Completo', 'Parcial']);
  assert.match(cat.metas[1].description, /incompleto/);
  const removido = await addon.get('stream', 'movie', `asc:${hashDe(3)}`, {});
  assert.deepEqual(removido.streams, []);
  const online = await addon.get('catalog', 'movie', 'asc-online', {});
  assert.deepEqual(online.metas, []);
});
