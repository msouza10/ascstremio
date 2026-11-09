const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DiskGuard, DiskRefusal, statDir, GIB } = require('../src/disk-policy');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { CredentialStore } = require('../src/credentials');
const settings = require('../src/settings');
const { tmpdir } = require('./tmp-helper');

const HASH = 'b'.repeat(40);
const HASH2 = 'c'.repeat(40);
const store = new CredentialStore({ file: path.join(tmpdir('disco-cred-'), 'credentials.json') });
const { token: TOKEN } = store.create({ name: 'teste' });
const LOCAL = { remoteAddress: '127.0.0.1' };

function guard(over = {}, medida = { free: 10 * GIB, total: 100 * GIB }) {
  const m = { ...medida };
  const g = new DiskGuard({ dir: '/x', measure: () => { if (m.erro) throw new Error(m.erro); return { free: m.free, total: m.total }; }, ...over });
  return { g, m };
}

test('reserva efetiva: a maior entre bytes e percentual', () => {
  assert.equal(guard({ reserveBytes: 2 * GIB, reservePercent: 0 }).g.measure().reserve, 2 * GIB);
  assert.equal(guard({ reserveBytes: 2 * GIB, reservePercent: 10 }).g.measure().reserve, 10 * GIB, '10% de 100 GiB vence 2 GiB');
  assert.equal(guard({ reserveBytes: 20 * GIB, reservePercent: 10 }).g.measure().reserve, 20 * GIB, 'bytes vence');
  assert.equal(guard({ reserveBytes: 0, reservePercent: 0 }).g.measure().reserve, 0);
});

test('percentual sem tamanho do volume é estado desconhecido (fail-closed)', () => {
  const g = new DiskGuard({ dir: '/x', reservePercent: 5, measure: () => 50 * GIB });
  const m = g.measure();
  assert.equal(m.known, false);
  assert.equal(g.admit({ holder: HASH, need: 1 }).code, 'medicao-indisponivel');
});

test('parâmetros inválidos são recusados', () => {
  assert.throws(() => new DiskGuard({ dir: '/x', reserveBytes: -1 }), RangeError);
  assert.throws(() => new DiskGuard({ dir: '/x', reservePercent: 101 }), RangeError);
  assert.throws(() => new DiskGuard({ dir: '/x', reserveBytes: NaN }), RangeError);
});

test('admissão considera livre, reserva e necessidade', () => {
  const { g } = guard({ reserveBytes: 2 * GIB }); // 10 livres - 2 = 8 utilizáveis
  assert.equal(g.admit({ holder: HASH, need: 8 * GIB, reserve: false }).ok, true);
  const r = g.admit({ holder: HASH, need: 8 * GIB + 1, reserve: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'sem-espaco');
  assert.match(r.message, /Espaço insuficiente/);
});

test('orçamento coordenado: dois downloads não aprovam a mesma folga', () => {
  const { g } = guard({ reserveBytes: 2 * GIB }); // 8 GiB utilizáveis
  assert.equal(g.admit({ holder: HASH, need: 5 * GIB }).ok, true);
  const segundo = g.admit({ holder: HASH2, need: 5 * GIB });
  assert.equal(segundo.ok, false, 'a folga de 5 GiB já está comprometida');
  assert.equal(segundo.committed, 5 * GIB);
  assert.equal(g.admit({ holder: HASH2, need: 3 * GIB }).ok, true, 'cabe nos 3 GiB restantes');
});

test('o próprio titular não se conta duas vezes e a promessa cai quando termina', () => {
  const { g } = guard({ reserveBytes: 2 * GIB });
  assert.equal(g.admit({ holder: HASH, need: 6 * GIB }).ok, true);
  assert.equal(g.admit({ holder: HASH, need: 6 * GIB }).ok, true, 'mesma chave: reavalia sem somar de novo');
  let estado = 6 * GIB;
  const live = () => estado;
  assert.equal(g.admit({ holder: HASH2, need: 3 * GIB, live }).ok, false);
  estado = null; // terminou: o que gravou já aparece em "livre"
  assert.equal(g.admit({ holder: HASH2, need: 3 * GIB, live }).ok, true);
  assert.equal(g.commitments.has(HASH), false);
});

test('promessa de torrent ausente só expira depois da tolerância', () => {
  const { g } = guard({ reserveBytes: 0 });
  g.admit({ holder: HASH, need: 4 * GIB });
  assert.equal(g.committed(() => false, null, Date.now() + 1000), 4 * GIB);
  assert.equal(g.committed(() => false, null, Date.now() + 10 * 60_000), 0);
});

test('falha de medição: desconhecido, recusa novos downloads e não vira infinito', () => {
  const { g, m } = guard();
  m.erro = 'EIO';
  const r = g.admit({ holder: HASH, need: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'medicao-indisponivel');
  assert.match(r.message, /EIO/);
  assert.throws(() => g.require({ holder: HASH, need: 1 }), (e) => e instanceof DiskRefusal && e.status === 503 && e.expose);
  const st = g.status();
  assert.equal(st.state, 'unknown');
  assert.equal(st.available, null);
  assert.equal(st.blocked, true);
});

test('recusa por falta de espaço devolve 507 com detalhe sem caminhos', () => {
  const { g } = guard({ reserveBytes: 9 * GIB });
  assert.throws(() => g.require({ holder: HASH, need: 2 * GIB }), (e) => {
    assert.equal(e.status, 507);
    assert.equal(e.code, 'sem-espaco');
    assert.equal(e.detail.needBytes, 2 * GIB);
    assert.ok(!JSON.stringify(e.detail).includes('/x'));
    return true;
  });
});

test('alerta com histerese: entra ao esgotar e só sai com folga renovada', () => {
  const { g, m } = guard({ reserveBytes: 2 * GIB }, { free: 2 * GIB + 100, total: 100 * GIB });
  assert.equal(g.status().state, 'ok');
  m.free = 2 * GIB; // available = 0
  assert.equal(g.status().state, 'low');
  m.free = 2 * GIB + 50 * 1024 ** 2; // sobra pouca: continua em alerta
  assert.equal(g.status().state, 'low');
  m.free = 2 * GIB + 300 * 1024 ** 2; // folga acima da margem
  assert.equal(g.status().state, 'ok');
});

test('statDir: usa o ancestral existente e trata statfs zerado como desconhecido', () => {
  const dir = tmpdir('disco-stat-');
  const visto = [];
  const fake = (p) => {
    visto.push(p);
    if (p === dir) return { bavail: 10, bsize: 4096, blocks: 100 };
    const e = new Error('x'); e.code = 'ENOENT'; throw e;
  };
  assert.deepEqual(statDir(path.join(dir, 'a', 'b'), fake), { free: 40960, total: 409600 });
  assert.equal(visto.length, 3);
  assert.throws(() => statDir(dir, () => ({ bavail: 0, bsize: 0, blocks: 0 })), /não informa/);
  assert.throws(() => statDir(dir, () => ({ bavail: NaN, bsize: 4096, blocks: 1 })));
  // medida real do sistema (Linux, Windows e contêiner)
  assert.ok(statDir(dir).free >= 0);
});

// --- Integração com a ponte ---
function ponte(over = {}) {
  const dir = tmpdir('disco-store-');
  const b = new Bridge({ torrentDir: '/tmp', storeDir: dir, port: 7097, publicUrl: 'http://127.0.0.1:7010/', credentials: store,
    vault: new SeedVault({ file: path.join(tmpdir('disco-v-'), 'v.json') }), minFreeBytes: 1000, freeSpace: () => 1e9, ...over });
  const adicionados = [];
  b.client = { torrents: [], get: async () => null, add: (...a) => { adicionados.push(a); return new EventEmitter(); } };
  b.entries.set(HASH, { infoHash: HASH, torrentPath: '/x/asc-1.torrent', files: [{ path: 'filme.mkv', length: 5e8 }] });
  return { b, dir, adicionados };
}
function resposta() {
  const r = new EventEmitter();
  Object.assign(r, { statusCode: 0, headers: {}, chunks: [], headersSent: false, writableEnded: false, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); this.headersSent = true; },
    write(c) { this.chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) this.chunks.push(Buffer.from(c)); this.writableEnded = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); } });
  return r;
}
const pedido = (method, url) => ({ method, url: `${url}?k=${TOKEN}`, headers: {}, socket: LOCAL });
const corpo = (res) => JSON.parse(Buffer.concat(res.chunks).toString());
const quieto = async (fn) => {
  const w = console.warn; const e = console.error;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

test('streaming de torrent novo sem folga é recusado antes de abrir (507) e o HEAD continua sem efeitos', async () => {
  const { b, adicionados } = ponte({ freeSpace: () => 4e8 }); // precisa de 5e8 + reserva 1000
  const head = resposta();
  await b.handle(pedido('HEAD', `/s/${HASH}/0`), head);
  assert.equal(head.statusCode, 200, 'HEAD segue respondendo pelos metadados');
  const get = resposta();
  await quieto(() => b.handle(pedido('GET', `/s/${HASH}/0`), get).catch(() => {}));
  assert.equal(adicionados.length, 0, 'nenhum torrent aberto/anunciado');
});

test('recusa de disco chega ao player como 507 com mensagem clara', async () => {
  const { b } = ponte({ freeSpace: () => 4e8 });
  b.server = null;
  const res = resposta();
  await quieto(async () => {
    try { await b.handle(pedido('GET', `/s/${HASH}/0`), res); } catch (err) {
      // o servidor HTTP converte a exceção como abaixo
      assert.equal(err.status, 507);
      assert.equal(err.expose, true);
      assert.match(err.message, /Espaço insuficiente/);
      return;
    }
    assert.fail('devia recusar');
  });
});

test('sem medição, novo download é recusado (503) e nada é aberto', async () => {
  const { b, adicionados } = ponte({ freeSpace: () => { throw new Error('statfs indisponível'); } });
  await quieto(async () => {
    await assert.rejects(b.handle(pedido('GET', `/s/${HASH}/0`), resposta()), (e) => e.status === 503 && e.code === 'medicao-indisponivel');
  });
  assert.equal(adicionados.length, 0);
});

test('play sob demanda (/a/<id>) é recusado antes de baixar o .torrent', async () => {
  const { b } = ponte({ freeSpace: () => 100 }); // abaixo da reserva de 1000
  let resolvido = 0;
  b.ascResolver = async () => { resolvido++; return { infoHash: HASH, fileIdx: 0 }; };
  b.ascSizeHint = () => 5e8;
  const get = resposta();
  await quieto(() => b.handle(pedido('GET', '/a/77'), get));
  assert.equal(resolvido, 0, 'sem snatch');
  assert.equal(get.statusCode, 507);
  assert.equal(corpo(get).disco.code, 'sem-espaco');
  const head = resposta();
  await b.handle(pedido('HEAD', '/a/77'), head);
  assert.equal(head.statusCode, 200);
  assert.equal(resolvido, 0);
});

test('play sob demanda sem medição responde 503 com Retry-After', async () => {
  const { b } = ponte({ freeSpace: () => { throw new Error('x'); } });
  let resolvido = 0;
  b.ascResolver = async () => { resolvido++; return { infoHash: HASH, fileIdx: 0 }; };
  const get = resposta();
  await quieto(() => b.handle(pedido('GET', '/a/78'), get));
  assert.equal(resolvido, 0);
  assert.equal(get.statusCode, 503);
  assert.equal(get.headers['Retry-After'], '60');
});

test('dois plays simultâneos de downloads grandes não aprovam a mesma folga', () => {
  const { b } = ponte({ freeSpace: () => 6e8 });
  b.entries.set(HASH2, { infoHash: HASH2, torrentPath: '/x/asc-2.torrent', files: [{ path: 'outro.mkv', length: 4e8 }] });
  b.admitTorrent(HASH); // 5e8 de 6e8 - 1000
  assert.throws(() => b.admitTorrent(HASH2), (e) => e instanceof DiskRefusal && e.status === 507);
});

test('torrent concluído e inteiro em disco só semeia: não passa pela reserva, nem sem medição', () => {
  const { b, dir } = ponte({ freeSpace: () => { throw new Error('statfs indisponível'); } });
  fs.writeFileSync(path.join(dir, 'filme.mkv'), Buffer.alloc(1));
  b.entries.get(HASH).files = [{ path: 'filme.mkv', length: 1 }];
  b.vault.markSeen(HASH, {});
  b.vault.markCompleted(HASH);
  b.admitTorrent(HASH); // não lança
});

// No Windows o statfs/stat não expõe blocos alocados (st.blocks): a contagem usa o tamanho aparente.
test('arquivo esparso com tamanho aparente completo, mas não concluído, continua sujeito à reserva', { skip: process.platform === 'win32' }, () => {
  const { b, dir } = ponte({ freeSpace: () => 100 });
  const arquivo = path.join(dir, 'filme.mkv');
  fs.writeFileSync(arquivo, '');
  fs.truncateSync(arquivo, 5e8); // só o tamanho aparente; sem blocos alocados
  assert.equal(b.diskState(HASH), 'full', 'o tamanho aparente engana o diskState');
  assert.throws(() => b.admitTorrent(HASH), (e) => e instanceof DiskRefusal && e.status === 507);
});

test('torrent já no motor não paga de novo a cada Range', () => {
  const { b } = ponte({ freeSpace: () => 100 });
  b.client.torrents.push({ infoHash: HASH, ready: true, length: 5e8, progress: 0.1 });
  b.admitTorrent(HASH); // não lança
});

test('conclusão em segundo plano: fail-closed sem medição e usa o orçamento comum', async () => {
  const vault = new SeedVault({ file: path.join(tmpdir('disco-bg-'), 'v.json') });
  vault.markSeen(HASH, {});
  const selecoes = [];
  const { b } = ponte({ vault, backgroundMode: 'auto', idleMs: 1000, freeSpace: () => { throw new Error('sem medida'); } });
  const t = { infoHash: HASH, name: 'F', ready: true, done: false, length: 5000, downloaded: 1000, pieces: new Array(4), progress: 0.2, select: (...a) => selecoes.push(a) };
  b.client.torrents.push(t);
  b.entries.set(HASH, { infoHash: HASH, freeleech: true, files: [] });
  b.startedAt.set(HASH, 0);
  await quieto(async () => b.completionTick(1e6));
  assert.equal(selecoes.length, 0, 'não inicia sem saber o espaço');
  b.disk.measureFn = () => 1e9;
  await quieto(async () => b.completionTick(1e6));
  assert.equal(selecoes.length, 1, 'com medida e folga, inicia');
});

test('snapshot expõe limite, livres, reservas e motivo', () => {
  const { b } = ponte({ freeSpace: () => ({ free: 3e9, total: 10e9 }), reservePercent: 50 });
  const { summary, settings: cfg } = b.snapshot();
  assert.equal(summary.disk.reserve, 5e9, '50% de 10 GB vence 1000 B');
  assert.equal(summary.disk.state, 'low');
  assert.equal(summary.disk.blocked, true);
  assert.match(summary.disk.reason, /reserva/);
  assert.equal(summary.freeBytes, 3e9);
  assert.equal(cfg.diskReservePercent, 50);
});

test('snapshot com statfs indisponível: livres nulos e estado desconhecido', () => {
  const { b } = ponte({ freeSpace: () => { throw new Error('x'); } });
  const { summary } = b.snapshot();
  assert.equal(summary.freeBytes, null);
  assert.equal(summary.disk.state, 'unknown');
});

test('resumePending adia a retomada sem derrubar nada quando falta espaço', async () => {
  const vault = new SeedVault({ file: path.join(tmpdir('disco-rp-'), 'v.json') });
  vault.markSeen(HASH, {});
  vault.setBackground(HASH, true);
  const { b, adicionados } = ponte({ vault, freeSpace: () => 100 });
  const err = console.error; const msgs = []; console.error = (m) => msgs.push(m);
  try { await b.resumePending(); } finally { console.error = err; }
  assert.equal(adicionados.length, 0);
  assert.match(msgs.join(), /retomada adiada/);
});

test('configuração: unidade e faixa da reserva são validadas', () => {
  const dir = tmpdir('disco-cfg-');
  const ok = settings.load({ dataDir: dir, env: { DISK_RESERVE_GIB: '5.5', DISK_RESERVE_PERCENT: '10' } });
  assert.equal(ok.values.DISK_RESERVE_GIB, 5.5);
  assert.equal(ok.values.DISK_RESERVE_PERCENT, 10);
  const padrao = settings.load({ dataDir: dir, env: {} });
  assert.equal(padrao.values.DISK_RESERVE_GIB, 2);
  assert.equal(padrao.values.DISK_RESERVE_PERCENT, 0);
  for (const env of [{ DISK_RESERVE_GIB: '-1' }, { DISK_RESERVE_GIB: 'dois' }, { DISK_RESERVE_PERCENT: '95' }, { DISK_RESERVE_PERCENT: '-5' }]) {
    assert.throws(() => settings.load({ dataDir: dir, env }), /DISK_RESERVE/, JSON.stringify(env));
  }
});
