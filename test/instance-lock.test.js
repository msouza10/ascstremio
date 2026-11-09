const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { tmpdir } = require('./tmp-helper');
const { acquireInstance, LockError, LOCK_NAME } = require('../src/instance-lock');

const MODULO = path.join(__dirname, '..', 'src', 'instance-lock.js');

function dirs(base) {
  return { dataDir: base, torrentDir: path.join(base, 'torrents'), storeDir: path.join(base, 'cache') };
}

// Filho que tenta adquirir a instalação, avisa "OK"/"ERRO" e segura a trava até o stdin fechar.
const FILHO = `
const { acquireInstance } = require(${JSON.stringify(MODULO)});
const cfg = JSON.parse(process.env.CFG);
try {
  const i = acquireInstance(cfg);
  process.stdout.write('OK\\n');
  process.stdin.resume();
  process.stdin.on('end', () => { i.release(); process.exit(0); });
} catch (err) {
  process.stdout.write('ERRO ' + err.message + '\\n');
  process.exit(3);
}
`;

function iniciaFilho(cfg) {
  const child = spawn(process.execPath, ['-e', FILHO], { env: { ...process.env, CFG: JSON.stringify(cfg) } });
  let out = '';
  const pronto = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(out.trim());
    });
    child.on('exit', () => resolve(out.trim()));
  });
  const fim = new Promise((resolve) => child.on('exit', resolve));
  return { child, pronto, fim, parar: () => { child.stdin.end(); return fim; } };
}

test('segunda aquisição da mesma pasta no mesmo processo é recusada e a liberação reabre', () => {
  const base = tmpdir('lock-a-');
  const a = acquireInstance(dirs(base));
  assert.ok(fs.existsSync(path.join(base, LOCK_NAME)));
  assert.throws(() => acquireInstance(dirs(base)), LockError);
  a.release();
  assert.ok(!fs.existsSync(path.join(base, LOCK_NAME)));
  acquireInstance(dirs(base)).release();
});

test('a trava guarda dados mínimos para diagnóstico', () => {
  const base = tmpdir('lock-b-');
  const a = acquireInstance(dirs(base));
  const dados = JSON.parse(fs.readFileSync(path.join(base, LOCK_NAME), 'utf8'));
  assert.equal(dados.pid, process.pid);
  assert.equal(dados.hostname, os.hostname());
  assert.ok(dados.startedAt && dados.nonce);
  a.release();
});

test('processos simultâneos na mesma pasta: só um vence, mesmo por caminhos equivalentes', async () => {
  const base = tmpdir('lock-c-');
  const alias = path.join(base, 'sub', '..'); // mesmo diretório por outro caminho
  fs.mkdirSync(path.join(base, 'sub'));
  const filhos = [base, alias, base, alias].map((d) => iniciaFilho(dirs(d)));
  const resultados = await Promise.all(filhos.map((f) => f.pronto));
  const vencedores = resultados.filter((r) => r === 'OK');
  assert.equal(vencedores.length, 1, resultados.join(' | '));
  for (const r of resultados.filter((x) => x !== 'OK')) assert.match(r, /^ERRO .*(em uso|travada)/);
  await Promise.all(filhos.map((f) => f.parar()));
  // Após o vencedor sair limpo, a pasta é liberada.
  assert.ok(!fs.existsSync(path.join(base, LOCK_NAME)));
});

test('trava de processo morto no mesmo host é recuperada', async () => {
  const base = tmpdir('lock-d-');
  const f = iniciaFilho(dirs(base));
  assert.equal(await f.pronto, 'OK');
  const pidMorto = f.child.pid;
  f.child.kill('SIGKILL'); // queda sem liberar
  await f.fim;
  assert.ok(fs.existsSync(path.join(base, LOCK_NAME)), 'a queda deixa a trava para trás');
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, LOCK_NAME), 'utf8')).pid, pidMorto);
  acquireInstance(dirs(base)).release();
});

test('trava de outro host, de PID vivo ou ilegível recusa e explica a recuperação', () => {
  const base = tmpdir('lock-e-');
  const file = path.join(base, LOCK_NAME);
  const registro = { pid: 999999, hostname: os.hostname(), startedAt: 'x', nonce: 'n' };

  fs.writeFileSync(file, JSON.stringify({ ...registro, hostname: `${os.hostname()}-outro` }));
  assert.throws(() => acquireInstance(dirs(base)), (e) => e instanceof LockError && /apague o arquivo/.test(e.message) && /outra máquina ou contêiner/.test(e.message));

  fs.writeFileSync(file, JSON.stringify({ ...registro, pid: process.ppid })); // processo pai: vivo
  assert.throws(() => acquireInstance(dirs(base)), /em uso por outra instância/);

  fs.writeFileSync(file, '{lixo');
  assert.throws(() => acquireInstance(dirs(base)), /ilegível ou incompleta/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{lixo', 'não apaga o que não consegue provar obsoleto');
});

test('PID igual ao nosso com outro nonce é execução anterior (PID 1 de contêiner)', () => {
  const base = tmpdir('lock-f-');
  fs.writeFileSync(path.join(base, LOCK_NAME), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: 'x', nonce: 'antigo' }));
  acquireInstance(dirs(base)).release();
});

test('armazenamento externo compartilhado entre DATA_DIR diferentes é recusado', () => {
  const raiz = tmpdir('lock-g-');
  const compartilhado = path.join(raiz, 'cache');
  const a = acquireInstance({ dataDir: path.join(raiz, 'a'), torrentDir: path.join(raiz, 'a', 't'), storeDir: compartilhado });
  assert.throws(
    () => acquireInstance({ dataDir: path.join(raiz, 'b'), torrentDir: path.join(raiz, 'b', 't'), storeDir: compartilhado }),
    LockError,
  );
  // Aninhado dentro de pasta já travada também é recusado.
  assert.throws(
    () => acquireInstance({ dataDir: path.join(raiz, 'c'), torrentDir: path.join(raiz, 'c', 't'), storeDir: path.join(compartilhado, 'sub') }),
    /dentro de uma pasta já/,
  );
  // A falha não deixou trava em DATA_DIR de b.
  assert.ok(!fs.existsSync(path.join(raiz, 'b', LOCK_NAME)));
  a.release();
  acquireInstance({ dataDir: path.join(raiz, 'b'), torrentDir: path.join(raiz, 'b', 't'), storeDir: compartilhado }).release();
});

test('trava ilegível em pasta ancestral recusa a instalação aninhada', () => {
  const raiz = tmpdir('lock-k-');
  fs.writeFileSync(path.join(raiz, LOCK_NAME), '{incompleta');
  assert.throws(
    () => acquireInstance({ dataDir: path.join(raiz, 'd'), torrentDir: path.join(raiz, 'd', 't'), storeDir: path.join(raiz, 'loja') }),
    /ilegível ou incompleta/,
  );
  assert.ok(!fs.existsSync(path.join(raiz, 'd', LOCK_NAME)));
});

test('symlink para a mesma pasta de dados é reconhecido como a mesma instalação', (t) => {
  const raiz = tmpdir('lock-h-');
  const real = path.join(raiz, 'real');
  const link = path.join(raiz, 'link');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, link, 'junction'); } catch { t.skip('sem permissão para symlink'); return; }
  const a = acquireInstance(dirs(real));
  assert.throws(() => acquireInstance(dirs(link)), LockError);
  a.release();
});

test('torrents e cache sobrepostos, ou DATA_DIR dentro do armazenamento, são recusados', () => {
  const base = tmpdir('lock-i-');
  assert.throws(() => acquireInstance({ dataDir: base, torrentDir: path.join(base, 'x'), storeDir: path.join(base, 'x', 'y') }), /uma dentro da outra/);
  assert.throws(() => acquireInstance({ dataDir: path.join(base, 'd'), torrentDir: tmpdir('lock-j-'), storeDir: base }), /não pode ficar dentro de BRIDGE_STORE/);
});
