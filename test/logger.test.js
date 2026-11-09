const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger, LEVELS } = require('../src/logger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
const PASSKEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('níveis: grava a partir do mínimo, em ordem, com ids crescentes', () => {
  const l = new Logger({ level: 'info' });
  assert.equal(l.write('debug', 'x', 'ignorado'), null);
  const a = l.write('info', 'ponte', 'um');
  const b = l.write('error', 'ponte', 'dois');
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.equal(l.level, 'info');
  assert.equal(l.setLevel('debug'), true);
  assert.ok(l.write('debug', 'x', 'agora entra'));
  assert.equal(l.setLevel('nada'), false);
  assert.equal(l.write('trace', 'x', 'nível inexistente'), null);
});

test('redação: passkey, announce, cookies, senhas e tokens nunca ficam no log', () => {
  const l = new Logger();
  l.addSecret(PASSKEY);
  const e1 = l.write('info', 'asc', `announce https://amigos-share.club/announce/${PASSKEY}?x=1 falhou`);
  assert.doesNotMatch(e1.msg, new RegExp(PASSKEY));
  assert.match(e1.msg, /\[redigido\]/);
  // segredo registrado vale em qualquer lugar, inclusive em dados
  const e2 = l.write('warn', 'asc', 'erro', { url: `x/${PASSKEY}/y`, nested: { passkey: 'qualquer', senha: '123', cookie: 'a=b', ok: 'visível' } });
  assert.equal(JSON.stringify(e2.data).includes(PASSKEY), false);
  assert.equal(e2.data.nested.passkey, '[redigido]');
  assert.equal(e2.data.nested.senha, '[redigido]');
  assert.equal(e2.data.nested.cookie, '[redigido]');
  assert.equal(e2.data.nested.ok, 'visível');
  // padrões sem segredo registrado
  const l2 = new Logger();
  const e3 = l2.write('info', 'asc', 'Cookie: session=abc123; XSRF-TOKEN=zzz');
  assert.doesNotMatch(e3.msg, /abc123|zzz/);
  assert.doesNotMatch(l2.write('info', 'x', 'url ?passkey=segredo123&b=1').msg, /segredo123/);
  assert.doesNotMatch(l2.write('info', 'x', `hex solto ${PASSKEY}`).msg, new RegExp(PASSKEY));
  assert.doesNotMatch(l2.write('info', 'x', `csrf ${'f'.repeat(64)}`).msg, /f{64}/);
  // infoHash (40 hex) é identificação do filme e precisa continuar legível
  const hash = 'c169262d6a2d11b1db5c8609663b191348434911';
  assert.ok(l2.write('info', 'x', `torrent ${hash}`).msg.includes(hash));
  // erro com stack também passa pela redação
  const err = new Error(`falhou ${PASSKEY}`);
  assert.doesNotMatch(JSON.stringify(l.write('error', 'x', 'boom', { err }).data), new RegExp(PASSKEY));
});

test('buffer circular respeita o limite e mantém os mais novos', () => {
  const l = new Logger({ max: 3 });
  for (let i = 1; i <= 5; i++) l.write('info', 'x', `m${i}`);
  assert.deepEqual(l.entries.map((e) => e.msg), ['m3', 'm4', 'm5']);
});

test('consulta: níveis, fonte, texto (inclui dados), tempo, cursor e limite', () => {
  let t = 1_000_000;
  const l = new Logger({ now: () => t });
  const w = (lv, src, msg, d) => { t += 1000; return l.write(lv, src, msg, d); };
  w('debug', 'ponte', 'range 0-1023');
  w('info', 'vault', 'torrent concluído');
  w('warn', 'hnr', 'prazo curto', { dias: 2 });
  w('error', 'asc', 'sessão expirada');
  w('info', 'ponte', 'stream aberto');
  const q = (f, o) => l.query(Logger.parseFilter(new URLSearchParams(f)), o).entries.map((e) => e.msg);
  assert.deepEqual(q('nivel=warn,error'), ['prazo curto', 'sessão expirada']);
  assert.deepEqual(q('fonte=ponte'), ['range 0-1023', 'stream aberto']);
  assert.deepEqual(q('q=EXPIRADA'), ['sessão expirada'], 'busca sem diferenciar maiúsculas');
  assert.deepEqual(q('q=dias'), ['prazo curto'], 'busca também nos dados');
  assert.deepEqual(q(`desde=${1_004_000}`), ['sessão expirada', 'stream aberto']);
  assert.deepEqual(q('', { limit: 2 }), ['sessão expirada', 'stream aberto'], 'limite devolve os mais recentes');
  assert.deepEqual(q('', { after: 3 }), ['sessão expirada', 'stream aberto'], 'after devolve só o que é novo');
  assert.deepEqual(q('', { before: 3, limit: 5 }), ['range 0-1023', 'torrent concluído']);
  assert.equal(l.query({}, { limit: 2 }).more, true);
  assert.equal(l.query({}, { limit: 50 }).more, false);
  assert.deepEqual(l.counts(), { debug: 1, info: 2, warn: 1, error: 1 });
  assert.deepEqual(l.sources(), ['asc', 'hnr', 'ponte', 'vault']);
  assert.equal(Logger.parseFilter(new URLSearchParams('nivel=banana')).levels, null, 'nível inválido é ignorado');
});

test('arquivos: NDJSON 0600, recarrega o histórico e respeita o teto por dia', () => {
  const dir = tmp();
  const a = new Logger({ dir });
  a.write('info', 'app', 'antes do restart', { n: 1 });
  a.write('error', 'app', 'falha');
  const files = a.listFiles();
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^brazuka-\d{4}-\d{2}-\d{2}\.log$/);
  // No Windows o acesso é por ACL (a pasta já é do usuário); chmod não existe.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, files[0].name)).mode & 0o777, 0o600);
  const lines = fs.readFileSync(path.join(dir, files[0].name), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(lines.length, 2);

  const b = new Logger({ dir }); // "restart"
  assert.deepEqual(b.entries.map((e) => e.msg), ['antes do restart', 'falha']);
  assert.equal(b.write('info', 'app', 'depois').id, 3, 'ids seguem do histórico');

  const c = new Logger({ dir: tmp(), maxDayBytes: 50 });
  c.write('warn', 'x', 'a'.repeat(100));
  c.write('info', 'x', 'não deve ir ao arquivo');
  c.write('error', 'x', 'erro entra mesmo assim');
  const txt = fs.readFileSync(path.join(c.dir, c.listFiles()[0].name), 'utf8');
  assert.doesNotMatch(txt, /não deve ir/);
  assert.match(txt, /erro entra/);
  assert.equal(c.entries.length, 3, 'a memória guarda tudo');
});

test('arquivos: segredo não chega ao disco', () => {
  const dir = tmp();
  const l = new Logger({ dir });
  l.addSecret(PASSKEY);
  l.write('error', 'x', `falha em /announce/${PASSKEY}`, { passkey: PASSKEY });
  const txt = fs.readFileSync(path.join(dir, l.listFiles()[0].name), 'utf8');
  assert.equal(txt.includes(PASSKEY), false);
});

test('retenção apaga só arquivos de log antigos; filePath recusa nomes de fora', () => {
  const dir = tmp();
  const now = new Date(2026, 10, 8).getTime();
  fs.writeFileSync(path.join(dir, 'brazuka-2026-10-01.log'), '{}\n');
  fs.writeFileSync(path.join(dir, 'brazuka-2026-11-07.log'), '{}\n');
  fs.writeFileSync(path.join(dir, 'notas.txt'), 'não é meu');
  const l = new Logger({ dir, retentionDays: 14, now: () => now });
  assert.deepEqual(l.listFiles().map((f) => f.name).sort(), ['brazuka-2026-11-07.log']);
  assert.ok(fs.existsSync(path.join(dir, 'notas.txt')), 'não mexe em arquivos que não são logs');
  assert.ok(l.filePath('brazuka-2026-11-07.log'));
  for (const ruim of ['../x', 'brazuka-2026-11-07.log/../../etc/passwd', 'notas.txt', '/etc/passwd', 'brazuka-2026-11-08.log', '', null]) {
    assert.equal(l.filePath(ruim), null, String(ruim));
  }
});

test('captureConsole roteia console.* com prefixo [tag] e sem segredos', () => {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const l = new Logger();
  l.addSecret(PASSKEY);
  try {
    l.captureConsole();
    console.log('[ponte] tudo certo');
    console.warn(`[vault] aviso ${PASSKEY}`);
    console.error('sem tag nenhuma');
    console.log('\n[app] encerrando…');
  } finally { Object.assign(console, saved); }
  const por = l.entries.map((e) => [e.level, e.src, e.msg]);
  assert.deepEqual(por[0], ['info', 'ponte', 'tudo certo']);
  assert.equal(por[1][0], 'warn'); assert.equal(por[1][1], 'vault'); assert.doesNotMatch(por[1][2], new RegExp(PASSKEY));
  assert.deepEqual(por[2], ['error', 'app', 'sem tag nenhuma']);
  assert.deepEqual(por[3], ['info', 'app', 'encerrando…']);
});

test('níveis exportados', () => {
  assert.deepEqual(Object.keys(LEVELS), ['debug', 'info', 'warn', 'error']);
});

test('avisos do próprio Node entram como aviso da fonte "node", não como erro', () => {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const l = new Logger();
  try {
    l.captureConsole();
    console.error('(node:86200) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n(Use `node --trace-deprecation ...`)');
  } finally { Object.assign(console, saved); }
  assert.equal(l.entries[0].level, 'warn');
  assert.equal(l.entries[0].src, 'node');
  assert.doesNotMatch(l.entries[0].msg, /trace-deprecation/, 'só a primeira linha');
});
