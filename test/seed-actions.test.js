const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Bridge } = require('../src/bridge');
const { SeedVault } = require('../src/seedvault');
const settings = require('../src/settings');
const { tmpdir } = require('./tmp-helper');

const HASH = 'b'.repeat(40);
function setup() {
  const dir = tmpdir('decisao-seed-');
  const vault = new SeedVault({ file: path.join(dir, 'vault.json') });
  vault.markSeen(HASH, { name: 'Vídeo de teste', torrentPath: path.join(dir, 'asc-123.torrent') });
  vault.markCompleted(HASH);
  const file = path.join(dir, 'video.mkv');
  fs.writeFileSync(file, 'vídeo sintético');
  const b = new Bridge({ torrentDir: dir, storeDir: dir, vault, afterSeed: 'manual' });
  b.entries.set(HASH, { files: [{ path: 'video.mkv', length: fs.statSync(file).size }] });
  let stops = 0;
  const torrent = { infoHash: HASH, ready: true, done: true, destroy(opts, cb) {
    assert.equal(opts.destroyStore, false);
    stops++;
    b.client.torrents = [];
    cb();
  } };
  b.client = { torrents: [torrent] };
  b.trackerCheck = async (hashes, opts) => {
    assert.deepEqual(hashes, [HASH]); assert.equal(opts.force, true);
    vault.setTracker(HASH, { satisfied: true, completedAtMs: vault.get(HASH).completedAt, remainingMs: 0, hitAndRun: false });
    return { checked: 1, failed: 0, semRegistro: 0 };
  };
  return { b, vault, file, dir, stops: () => stops };
}

test('modo manual preserva padrão e não libera automaticamente depois da confirmação', async () => {
  const s = setup();
  assert.equal(settings.load({ dataDir: s.dir, env: {} }).values.AFTER_SEED, 'delete');
  assert.equal(settings.load({ dataDir: s.dir, env: { AFTER_SEED: 'manual' } }).values.AFTER_SEED, 'manual');
  await s.b.trackerCheck([HASH], { force: true });
  assert.deepEqual(await s.b.releaseSatisfied(), []);
  assert.equal(s.stops(), 0); assert.ok(fs.existsSync(s.file));
});

test('parar mantém arquivos e persiste a decisão; excluir funciona mesmo com o seed já parado', async () => {
  const s = setup();
  await s.b.manageSeed(HASH, 'stop');
  assert.equal(s.stops(), 1); assert.ok(fs.existsSync(s.file));
  assert.equal(new SeedVault({ file: s.vault.file }).get(HASH).seedChoice, 'stop');
  await s.b.manageSeed(HASH, 'delete');
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(s.vault.get(HASH).releasedAs, 'delete');
  assert.ok(fs.existsSync(s.vault.file), 'o cofre não é apagado');
});

test('manter semeando protege a escolha individual mesmo no modo automático', async () => {
  const s = setup();
  await s.b.manageSeed(HASH, 'keep');
  s.b.afterSeed = 'delete';
  assert.deepEqual(await s.b.releaseSatisfied(), []);
  assert.equal(s.stops(), 0); assert.ok(fs.existsSync(s.file));
});

test('tracker indisponível, sem registro, pendente ou hit-and-run não autoriza exclusão', async () => {
  for (const state of ['falha', 'sem-registro', 'pendente', 'hnr', 'antigo']) {
    const s = setup();
    await s.b.trackerCheck([HASH], { force: true });
    s.b.trackerCheck = async () => {
      if (state === 'falha') throw new Error('sem rede');
      if (state === 'pendente') s.vault.get(HASH).tracker.satisfied = false;
      if (state === 'hnr') s.vault.get(HASH).tracker.hitAndRun = true;
      if (state === 'antigo') s.vault.get(HASH).tracker.checkedAt = 1;
      return { checked: 1, failed: 0, semRegistro: state === 'sem-registro' ? 1 : 0 };
    };
    await assert.rejects(s.b.manageSeed(HASH, 'delete'), (e) => [409, 503].includes(e.status));
    assert.equal(s.stops(), 0, state); assert.ok(fs.existsSync(s.file), state);
  }
});

test('reprodução, sessão recente, carregamento e operação concorrente bloqueiam a ação', async () => {
  for (const kind of ['stream', 'sessao', 'carregamento', 'concorrente']) {
    const s = setup();
    if (kind === 'stream') s.b.streams.set(HASH, 1);
    if (kind === 'sessao') s.b.limiter.hasKeyPrefix = () => true;
    if (kind === 'carregamento') s.b.loading.set(HASH, Promise.resolve());
    if (kind === 'concorrente') s.b.retention.retiring.add(HASH);
    await assert.rejects(s.b.manageSeed(HASH, 'delete'), (e) => e.status === 409);
    assert.equal(s.stops(), 0); assert.ok(fs.existsSync(s.file));
  }
});

test('novo play é recusado durante a revalidação e uma segunda ação não disputa o conteúdo', async () => {
  const s = setup(); const original = s.b.trackerCheck;
  let release; const wait = new Promise((resolve) => { release = resolve; });
  s.b.trackerCheck = async (...args) => { await wait; return original(...args); };
  const first = s.b.manageSeed(HASH, 'stop');
  await assert.rejects(s.b.getTorrent(HASH), (e) => e.status === 503);
  await assert.rejects(s.b.manageSeed(HASH, 'delete'), (e) => e.status === 409);
  release(); await first;
  assert.equal(s.b.retention.isRetiring(HASH), false);
});

test('arquivos ainda em download ou verificação não são removidos', async () => {
  const s = setup();
  s.b.client.torrents[0].done = false;
  await assert.rejects(s.b.manageSeed(HASH, 'delete'), (e) => e.status === 409);
  assert.equal(s.stops(), 0); assert.ok(fs.existsSync(s.file));
});

test('exclusão recusa arquivo compartilhado ou caminho fora do armazenamento', async () => {
  for (const kind of ['compartilhado', 'caminho']) {
    const s = setup();
    if (kind === 'compartilhado') s.b.entries.set('c'.repeat(40), { files: [{ path: 'video.mkv' }] });
    else s.b.entries.get(HASH).files[0].path = '../video.mkv';
    await assert.rejects(s.b.manageSeed(HASH, 'delete'), (e) => e.status === 409);
    assert.equal(s.stops(), 0); assert.ok(fs.existsSync(s.file));
  }
});

test('falha ao encerrar o motor ou obrigação reaberta durante a parada preserva arquivos', async () => {
  for (const kind of ['motor', 'tracker']) {
    const s = setup();
    s.b.client.torrents[0].destroy = (opts, cb) => {
      if (kind === 'tracker') s.vault.get(HASH).tracker.satisfied = false;
      cb(kind === 'motor' ? new Error('falhou') : null);
    };
    await assert.rejects(s.b.manageSeed(HASH, 'delete'));
    assert.ok(fs.existsSync(s.file)); assert.equal(s.b.retention.isRetiring(HASH), false);
  }
});

test('exclusão parcial persiste a parada e não volta a baixar após reiniciar', async (t) => {
  const s = setup();
  s.vault.setBackground(HASH, true);
  const locked = path.join(s.dir, 'em-uso.mkv');
  fs.writeFileSync(locked, 'arquivo em uso');
  s.b.entries.get(HASH).files.push({ path: 'em-uso.mkv', length: fs.statSync(locked).size });
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (file === locked) throw Object.assign(new Error('arquivo em uso'), { code: 'EBUSY' });
    return unlink(file);
  });
  await assert.rejects(s.b.manageSeed(HASH, 'delete'), (e) => e.status === 409);
  assert.equal(fs.existsSync(s.file), false, 'o primeiro arquivo já saiu');
  assert.ok(fs.existsSync(locked), 'o arquivo em uso permaneceu');
  s.b.vault = new SeedVault({ file: s.vault.file });
  assert.equal(s.b.vault.get(HASH).backgroundComplete, true);
  assert.equal(s.b.vault.get(HASH).seedChoice, 'stop');
  assert.equal(s.b.vault.get(HASH).releasedAs, 'stop');
  let resumed = 0;
  s.b.getTorrent = async () => { resumed++; return { length: 10 }; };
  await s.b.resumePending();
  assert.equal(resumed, 0, 'nem a retomada nem a conclusão podem recriar o download');
  t.mock.restoreAll();
  // O transporte simulado precisa atualizar o cofre recarregado, como o tracker real faz.
  s.b.trackerCheck = async () => {
    const entry = s.b.vault.get(HASH);
    s.b.vault.setTracker(HASH, { ...entry.tracker, completedAtMs: entry.completedAt });
    return { checked: 1, failed: 0, semRegistro: 0 };
  };
  await s.b.manageSeed(HASH, 'delete');
  assert.equal(fs.existsSync(locked), false, 'uma nova tentativa remove o que sobrou');
  assert.equal(s.b.vault.get(HASH).seedChoice, 'delete');
});

test('reinício retoma conteúdo cumprido no modo manual e respeita decisão de parar', async () => {
  const s = setup();
  await s.b.trackerCheck([HASH], { force: true }); s.b.client.torrents = [];
  let resumed = 0;
  s.b.getTorrent = async () => { resumed++; return { length: 10 }; };
  await s.b.resumePending(); assert.equal(resumed, 1);
  // Uma queda entre persistir a decisão e marcar a liberação não perde a escolha.
  s.vault.setSeedChoice(HASH, 'stop');
  await s.b.resumePending(); assert.equal(resumed, 1);
});

test('retenção confirmada prevalece sobre keep, mesmo quando o arquivo fica em uso', async (t) => {
  for (const locked of [false, true]) {
    const s = setup();
    s.vault.setBackground(HASH, true);
    await s.b.manageSeed(HASH, 'keep');
    if (locked) t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('ocupado'), { code: 'EBUSY' }); });
    const result = await s.b.retention.retire({ infoHash: HASH, name: 'Teste', files: ['video.mkv'] });
    assert.equal(result.failed.length, locked ? 1 : 0);
    t.mock.restoreAll();
    s.b.vault = new SeedVault({ file: s.vault.file });
    assert.equal(s.b.vault.get(HASH).seedChoice, 'stop');
    let resumed = 0;
    s.b.getTorrent = async () => { resumed++; return { length: 10 }; };
    await s.b.resumePending();
    assert.equal(resumed, 0, 'a limpeza não pode ser desfeita por um download automático');
    assert.equal(fs.existsSync(s.file), locked);
  }
});

test('liberação salva prevalece sobre keep antigo; uma nova escolha explícita pode retomar', async () => {
  const s = setup();
  await s.b.manageSeed(HASH, 'keep');
  s.vault.markReleased(HASH, 'retencao');
  const torrent = s.b.client.torrents[0];
  s.b.client.torrents = [];
  let resumed = 0;
  s.b.getTorrent = async () => { resumed++; return { length: 10 }; };
  await s.b.resumePending(); assert.equal(resumed, 0);
  s.b.client.torrents = [torrent];
  await s.b.manageSeed(HASH, 'keep');
  assert.equal(s.vault.get(HASH).releasedAs, undefined);
  s.b.client.torrents = [];
  await s.b.resumePending(); assert.equal(resumed, 1);
});
