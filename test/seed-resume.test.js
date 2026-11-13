const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const { readTorrent } = require('../src/library');
const { tmpdir } = require('./tmp-helper');

const sha = (data) => createHash('sha1').update(data).digest();
function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(k => [encode(k), encode(value[k])]), Buffer.from('e')]);
}

async function setup() {
  const dir = tmpdir('retomar-seed-');
  const data = Buffer.from('abcdefghijk');
  const info = { name: 'Filme', private: 1, 'piece length': 4, pieces: Buffer.concat([sha(data.subarray(0, 4)), sha(data.subarray(4, 8)), sha(data.subarray(8))]), files: [{ length: 3, path: ['video.mkv'] }, { length: 8, path: ['extra.nfo'] }] };
  const torrentPath = path.join(dir, 'asc-123.torrent');
  fs.writeFileSync(torrentPath, encode({ announce: 'http://tracker.invalid/announce', info }));
  const lib = await readTorrent(torrentPath);
  fs.mkdirSync(path.join(dir, 'Filme'));
  fs.writeFileSync(path.join(dir, 'Filme', 'video.mkv'), data.subarray(0, 3));
  fs.writeFileSync(path.join(dir, 'Filme', 'extra.nfo'), data.subarray(3));
  const hash = lib.infoHash;
  const vault = new SeedVault({ file: path.join(dir, 'vault.json') });
  vault.markSeen(hash, { name: 'Teste', torrentPath }); vault.markCompleted(hash);
  vault.setSeedChoice(hash, 'stop'); vault.markReleased(hash, 'stop');
  const b = new Bridge({ torrentDir: dir, storeDir: dir, vault, afterSeed: 'delete', freeSpace: () => 0 });
  b.entries.set(hash, lib);
  let opened = 0;
  b.client = { torrents: [], get: async () => null, add(source, options, ready) {
    opened++;
    const torrent = Object.assign(new EventEmitter(), { infoHash: hash, ready: true, done: true, length: data.length, files: lib.files, name: 'Teste', destroy(opts, callback) { b.client.torrents = []; callback(); } });
    b.client.torrents.push(torrent);
    queueMicrotask(() => ready(torrent));
    return torrent;
  } };
  b.trackerCheck = async () => {
    vault.setTracker(hash, { satisfied: true, completedAtMs: vault.get(hash).completedAt, remainingMs: 0, hitAndRun: false });
    return { checked: 1, failed: 0, semRegistro: 0 };
  };
  return { b, vault, hash, dir, lib, opened: () => opened };
}

test('voltar a semear verifica todas as peças (inclusive entre arquivos), grava keep e retoma no reinício', async () => {
  const s = await setup();
  const out = await s.b.manageSeed(s.hash, 'resume');
  assert.equal(out.action, 'resume');
  assert.equal(s.opened(), 1);
  assert.equal(s.vault.get(s.hash).seedChoice, 'keep');
  assert.equal(s.vault.get(s.hash).releasedAs, undefined);
  assert.equal(s.vault.get(s.hash).releasedAt, undefined);
  assert.equal(s.b.shouldResume(new SeedVault({ file: s.vault.file }).get(s.hash)), true);
  assert.deepEqual(await s.b.releaseSatisfied(), [], 'não apaga ao cumprir o seed');
  assert.equal(s.b.retention.isRetiring(s.hash), false);
  s.b.client.torrents = [];
  s.b.vault = new SeedVault({ file: s.vault.file });
  let restarted = 0;
  s.b.getTorrent = async () => { restarted++; return { length: 11 }; };
  await s.b.resumePending();
  assert.equal(restarted, 1);
});

for (const problem of ['ausente', 'truncado', 'corrompido', 'compartilhado', 'metadados']) {
  test(`voltar a semear recusa ${problem} antes de abrir/anunciar e mantém a parada`, async () => {
    const s = await setup();
    const file = path.join(s.dir, 'Filme', 'extra.nfo');
    if (problem === 'ausente') fs.unlinkSync(file);
    if (problem === 'truncado') fs.writeFileSync(file, 'curto');
    if (problem === 'corrompido') fs.writeFileSync(file, 'XXXXXXXX');
    if (problem === 'compartilhado') s.b.entries.set('a'.repeat(40), { files: [s.lib.files[1]] });
    if (problem === 'metadados') fs.writeFileSync(s.lib.torrentPath, 'inválido');
    await assert.rejects(s.b.manageSeed(s.hash, 'resume'), e => e.status === 409);
    assert.equal(s.opened(), 0);
    assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
    assert.equal(s.vault.get(s.hash).releasedAs, 'stop');
    assert.equal(s.b.retention.isRetiring(s.hash), false);
  });
}

for (const problem of ['tracker', 'hnr', 'pendente', 'loading', 'retencao', 'stream', 'sessao', 'quota', 'ativo', 'excluido']) {
  test(`voltar a semear recusa ${problem} sem abrir o motor`, async () => {
    const s = await setup();
    if (problem === 'tracker') s.b.trackerCheck = async () => ({ failed: 1 });
    if (problem === 'hnr' || problem === 'pendente') s.b.trackerCheck = async () => {
      s.vault.setTracker(s.hash, { satisfied: problem !== 'pendente', completedAtMs: s.vault.get(s.hash).completedAt, remainingMs: problem === 'pendente' ? 1000 : 0, hitAndRun: problem === 'hnr' });
      return { checked: 1 };
    };
    if (problem === 'loading') s.b.loading.set(s.hash, Promise.resolve());
    if (problem === 'retencao') s.b.retention.retiring.add(s.hash);
    if (problem === 'stream') s.b.streams.set(s.hash, 1);
    if (problem === 'sessao') s.b.limiter.acquire('c_teste', `s:${s.hash}:0`);
    if (problem === 'quota') { s.b.limiter.maxSessions = 1; s.b.limiter.acquire('c_teste', 's:outro:0'); }
    if (problem === 'ativo') s.b.client.torrents.push({ infoHash: s.hash, ready: true, done: true });
    if (problem === 'excluido') s.vault.markReleased(s.hash, 'delete');
    await assert.rejects(s.b.manageSeed(s.hash, 'resume'), e => [409, 503].includes(e.status));
    assert.equal(s.opened(), 0);
    assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
  });
}

test('voltar a semear bloqueia play e outra decisão durante a consulta e reconfirma o tracker antes da abertura', async () => {
  const s = await setup();
  let release, started;
  const gate = new Promise(r => { release = r; });
  const entered = new Promise(r => { started = r; });
  let checks = 0;
  const check = s.b.trackerCheck;
  s.b.trackerCheck = async () => { checks++; if (checks === 1) { started(); await gate; return check(); } return { failed: 1 }; };
  const run = s.b.manageSeed(s.hash, 'resume');
  await entered;
  await assert.rejects(s.b.getTorrent(s.hash), e => e.status === 503);
  await assert.rejects(s.b.manageSeed(s.hash, 'delete'), e => e.status === 409);
  release();
  await assert.rejects(run, e => e.status === 503);
  assert.equal(checks, 2);
  assert.equal(s.opened(), 0);
  assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
  assert.equal(s.b.retention.isRetiring(s.hash), false);
});

test('voltar a semear recusa arquivos alterados enquanto o tracker reconfirma', async () => {
  const s = await setup();
  const check = s.b.trackerCheck;
  let checks = 0;
  s.b.trackerCheck = async () => {
    if (++checks === 2) fs.writeFileSync(path.join(s.dir, 'Filme', 'extra.nfo'), 'mudou!!!');
    return check();
  };
  await assert.rejects(s.b.manageSeed(s.hash, 'resume'), e => e.status === 409);
  assert.equal(s.opened(), 0);
  assert.equal(s.vault.get(s.hash).releasedAs, 'stop');
});

test('falha ao salvar keep encerra o torrent e preserva a decisão anterior', async () => {
  const s = await setup();
  const save = s.vault.save.bind(s.vault);
  s.vault.save = () => { if (s.vault.get(s.hash).seedChoice === 'keep') throw new Error('disco indisponível'); save(); };
  await assert.rejects(s.b.manageSeed(s.hash, 'resume'), e => e.status === 503);
  assert.equal(s.b.client.torrents.length, 0);
  assert.equal(s.vault.get(s.hash).releasedAs, 'stop');
  assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
  assert.equal(new SeedVault({ file: s.vault.file }).get(s.hash).releasedAs, 'stop');
});

test('pedidos manuais dividem o limite de retomada e liberam a fila após falha', async () => {
  const s = await setup();
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  const first = s.b.withResumeSlot(async () => { entered(); await gate; throw new Error('worker falhou'); });
  const handled = assert.rejects(first, /worker falhou/);
  await started;
  const run = s.b.manageSeed(s.hash, 'resume');
  assert.equal(s.b.retention.isRetiring(s.hash), true);
  assert.equal(s.opened(), 0);
  release(); await handled; await run;
  assert.equal(s.opened(), 1);
  assert.equal(s.b.resumeSlots, 0);
});

test('symlink, link físico e caminhos fora do armazenamento são recusados', async (t) => {
  for (const kind of ['symlink', 'hardlink', 'escape']) {
    const s = await setup();
    const file = path.join(s.dir, 'Filme', 'extra.nfo');
    if (kind === 'escape') s.lib.files[1].path = path.join('..', 'extra.nfo');
    else {
      const target = path.join(s.dir, 'original.nfo');
      fs.renameSync(file, target);
      try { if (kind === 'hardlink') fs.linkSync(target, file); else fs.symlinkSync(target, file, 'file'); }
      catch (err) { if (process.platform === 'win32' && err.code === 'EPERM') { t.diagnostic('symlink indisponível nesta conta Windows'); continue; } throw err; }
    }
    await assert.rejects(s.b.manageSeed(s.hash, 'resume'), e => e.status === 409);
    assert.equal(s.opened(), 0);
  }
});


test('falha do motor não muda a escolha persistida e libera a trava', async () => {
  const s = await setup();
  s.b.client.add = () => { throw new Error('motor indisponível'); };
  await assert.rejects(s.b.manageSeed(s.hash, 'resume'), e => e.status === 503);
  assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
  assert.equal(s.vault.get(s.hash).releasedAs, 'stop');
  assert.equal(s.b.retention.isRetiring(s.hash), false);
});

test('reprodução iniciada durante a abertura impede gravar keep e encerra a retomada', async () => {
  const s = await setup();
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  s.b.client.get = async () => { entered(); await gate; return null; };
  const run = s.b.manageSeed(s.hash, 'resume');
  await started;
  s.b.streams.set(s.hash, 1);
  release();
  await assert.rejects(run, e => e.status === 409);
  assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
  assert.equal(s.b.client.torrents.length, 0);
});

test('play que já aguardava o motor respeita uma manutenção iniciada durante a espera', async () => {
  const s = await setup();
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  s.b.client.get = async () => { entered(); await gate; return null; };
  const play = s.b.getTorrent(s.hash);
  await started;
  s.b.retention.retiring.add(s.hash);
  release();
  await assert.rejects(play, e => e.status === 503);
  assert.equal(s.opened(), 0);
});

test('verificação do motor pode ultrapassar 30 segundos sem reiniciar a retomada', async (t) => {
  const s = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered, ready;
  const started = new Promise(r => { entered = r; });
  const add = s.b.client.add;
  s.b.client.add = (source, options, callback) => {
    const torrent = add(source, options, () => {});
    ready = () => callback(torrent);
    entered(); return torrent;
  };
  const run = s.b.manageSeed(s.hash, 'resume');
  await started;
  t.mock.timers.tick(31_000);
  ready();
  assert.equal((await run).action, 'resume');
});

test('progresso da verificação renova o prazo de inatividade do motor', async (t) => {
  const s = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered, ready, pending;
  const started = new Promise(r => { entered = r; });
  const add = s.b.client.add;
  s.b.client.add = (source, options, callback) => {
    pending = add(source, options, () => {});
    pending.ready = false;
    ready = () => { pending.ready = true; callback(pending); };
    entered(); return pending;
  };
  const run = s.b.manageSeed(s.hash, 'resume');
  await started;
  t.mock.timers.tick(4 * 60_000);
  pending.emit('verified', 0);
  t.mock.timers.tick(4 * 60_000);
  ready();
  assert.equal((await run).action, 'resume');
});

test('motor sem progresso por cinco minutos aborta sem perder arquivos ou a escolha de parar', async (t) => {
  const s = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered;
  const started = new Promise(r => { entered = r; });
  const add = s.b.client.add;
  s.b.client.add = (source, options) => {
    const torrent = add(source, options, () => {});
    torrent.ready = false;
    entered(); return torrent;
  };
  const run = s.b.manageSeed(s.hash, 'resume');
  await started;
  t.mock.timers.tick(5 * 60_000);
  await assert.rejects(run, e => e.status === 503);
  assert.equal(s.b.client.torrents.length, 0);
  assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
  assert.ok(fs.existsSync(path.join(s.dir, 'Filme', 'video.mkv')));
});

test('alteração enquanto client.get aguarda é recusada antes de abrir/anunciar', async () => {
  const s = await setup();
  s.b.client.get = async () => {
    fs.writeFileSync(path.join(s.dir, 'Filme', 'extra.nfo'), 'alterado');
    return null;
  };
  await assert.rejects(s.b.manageSeed(s.hash, 'resume'), e => e.status === 409);
  assert.equal(s.opened(), 0);
  assert.equal(s.vault.get(s.hash).seedChoice, 'stop');
});
