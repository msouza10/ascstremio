const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { tmpdir } = require('./tmp-helper');

const LOCAL = { remoteAddress: '127.0.0.1' };
const tmp = () => path.join(tmpdir('lazy-'), 'v.json');
const HASH = '1'.padStart(40, 'a');

function ponte(over = {}) {
  const b = new Bridge({ torrentDir: '/tmp', storeDir: '/tmp', port: 7099, publicUrl: 'http://127.0.0.1:7010/', vault: new SeedVault({ file: tmp() }), ...over });
  b.client = { torrents: [] };
  return b;
}
function resposta() {
  const r = new EventEmitter();
  Object.assign(r, { statusCode: 0, headers: {}, chunks: [], ended: false, headersSent: false, writableFinished: false, writableEnded: false,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); this.headersSent = true; },
    write(c) { this.chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) this.chunks.push(Buffer.from(c)); this.ended = true; this.writableEnded = true; this.writableFinished = true; this.emit('close'); },
    off(ev, fn) { return this.removeListener(ev, fn); } });
  return r;
}
const pedido = (method, url, headers = {}) => ({ method, url, headers, socket: LOCAL });
const corpo = (res) => Buffer.concat(res.chunks).toString();

function torrentFalso(bytes) {
  return { ready: true, numPeers: 2, progress: 0, files: [{ length: bytes.length, path: 'filme.mkv', createReadStream: ({ start, end }) => Readable.from([bytes.subarray(start, end + 1)]) }] };
}

test('lazyUrl e entryByAscId', () => {
  const b = ponte();
  assert.equal(b.lazyUrl(67440), 'http://127.0.0.1:7010/a/67440');
  b.entries.set(HASH, { infoHash: HASH, torrentPath: '/x/asc-1.torrent' });
  b.entries.set('f'.repeat(40), { infoHash: 'f'.repeat(40), torrentPath: '/x/outro-asc-1.torrent' });
  assert.equal(b.entryByAscId('1').infoHash, HASH);
  assert.equal(b.entryByAscId('11'), null, 'não confunde asc-1 com asc-11');
  assert.equal(b.entryByAscId('2'), null);
});

test('HEAD em /a/<id> sem .torrent local responde sem baixar, anunciar nem abrir torrent', async () => {
  const b = ponte();
  let resolvido = 0; let aberto = 0;
  b.ascResolver = async () => { resolvido++; return { infoHash: HASH, fileIdx: 0 }; };
  b.getTorrent = async () => { aberto++; };
  const res = resposta();
  await b.handle(pedido('HEAD', '/a/1'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Accept-Ranges'], 'bytes');
  assert.equal(res.headers['Content-Length'], undefined, 'sem .torrent não há tamanho exato');
  assert.equal(resolvido, 0, 'HEAD nunca baixa o .torrent');
  assert.equal(aberto, 0, 'nem abre o torrent (snatch)');
});

test('HEAD em /a/<id> com .torrent local devolve o tamanho exato, ainda sem abrir o torrent', async () => {
  const b = ponte();
  b.entries.set(HASH, { infoHash: HASH, torrentPath: '/x/asc-1.torrent', files: [{ index: 0, path: 'Filme.mkv', length: 123456, isVideo: true }, { index: 1, path: 'a.nfo', length: 3, isVideo: false }] });
  let aberto = 0;
  b.getTorrent = async () => { aberto++; };
  const res = resposta();
  await b.handle(pedido('HEAD', '/a/1'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Length'], '123456');
  assert.equal(aberto, 0);
});

test('GET em /a/<id> é o play: baixa o .torrent uma vez e serve o vídeo com Range', async () => {
  const b = ponte();
  let resolvido = 0;
  const bytes = Buffer.from('0123456789');
  b.ascResolver = async (id) => { resolvido++; assert.equal(id, '1'); return { infoHash: HASH, fileIdx: 0 }; };
  b.getTorrent = async (h) => { assert.equal(h, HASH); return torrentFalso(bytes); };
  const res = resposta();
  await b.handle(pedido('GET', '/a/1', { range: 'bytes=2-5' }), res);
  assert.equal(resolvido, 1);
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['Content-Range'], 'bytes 2-5/10');
  assert.equal(corpo(res), '2345');
});

test('GET em /a/<id> com .torrent já local não chama o resolvedor', async () => {
  const b = ponte();
  b.entries.set(HASH, { infoHash: HASH, torrentPath: '/x/asc-1.torrent', files: [{ index: 0, path: 'F.mkv', length: 10, isVideo: true }] });
  b.ascResolver = async () => { throw new Error('não devia baixar de novo'); };
  b.getTorrent = async () => torrentFalso(Buffer.from('abcdefghij'));
  const res = resposta();
  await b.handle(pedido('GET', '/a/1'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(corpo(res), 'abcdefghij');
});

test('erros do resolvedor viram respostas HTTP claras, sem abrir torrent', async () => {
  const caso = async (erro) => {
    const b = ponte();
    let aberto = 0;
    b.ascResolver = async () => { throw erro; };
    b.getTorrent = async () => { aberto++; };
    const res = resposta();
    await b.handle(pedido('GET', '/a/1'), res);
    return { status: res.statusCode, erro: JSON.parse(corpo(res)).error, aberto };
  };
  const mk = (status, message) => Object.assign(new Error(message), { status });
  assert.deepEqual(await caso(mk(409, 'não é freeleech')), { status: 409, erro: 'não é freeleech', aberto: 0 });
  assert.equal((await caso(mk(422, 'vários vídeos'))).status, 422);
  assert.equal((await caso(mk(401, 'sessão expirada'))).status, 401);
  assert.equal((await caso(new Error('algo inesperado'))).status, 502, 'sem status vira 502');
});

test('/a/<id> sem resolvedor configurado responde 501; ids malformados dão 404', async () => {
  const b = ponte();
  const res = resposta();
  await b.handle(pedido('GET', '/a/1'), res);
  assert.equal(res.statusCode, 501);
  for (const ruim of ['/a/abc', '/a/1/2', '/a/', '/a/12345678901', '/a/1%2f..%2f..']) {
    const r = resposta();
    await b.handle(pedido('GET', ruim), r);
    assert.equal(r.statusCode, 404, ruim);
  }
});

test('rotas /s/<hash> continuam funcionando como antes', async () => {
  const b = ponte();
  b.entries.set(HASH, { infoHash: HASH, files: [{ index: 0, path: 'Filme.mkv', length: 99, isVideo: true }] });
  const res = resposta();
  await b.handle(pedido('HEAD', `/s/${HASH}/0`), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Length'], '99');
});

test('/a/<id> com .torrent local de filme + extras usa o vídeo principal (HEAD e GET)', async () => {
  const arquivos = [
    { index: 0, path: 'Extras.mkv', length: 20, isVideo: true },
    { index: 1, path: 'Filme.mkv', length: 10_000, isVideo: true },
    { index: 2, path: 'Making of.mkv', length: 30, isVideo: true },
  ];
  const b = ponte();
  b.entries.set(HASH, { infoHash: HASH, torrentPath: '/x/asc-1.torrent', files: arquivos });
  b.ascResolver = async () => { throw new Error('já está na biblioteca'); };
  const head = resposta();
  await b.handle(pedido('HEAD', '/a/1'), head);
  assert.equal(head.headers['Content-Length'], '10000', 'tamanho do filme, não do primeiro vídeo');
  let aberto = null;
  b.getTorrent = async (h) => { aberto = h; return { ready: true, numPeers: 1, progress: 0, files: arquivos.map((f) => ({ ...f, createReadStream: () => Readable.from([Buffer.alloc(f.length > 100 ? 4 : 1, 'x')]) })) }; };
  const get = resposta();
  await b.handle(pedido('GET', '/a/1', { range: 'bytes=0-3' }), get);
  assert.equal(aberto, HASH);
  assert.equal(get.headers['Content-Range'], 'bytes 0-3/10000', 'serviu o arquivo índice 1 (o filme)');
});
