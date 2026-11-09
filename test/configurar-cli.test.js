const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { spawn, spawnSync } = require('child_process');
const { tmpdir } = require('./tmp-helper');
const { run } = require('../src/configurar-cli');
const settings = require('../src/settings');

const CLI = path.join(__dirname, '..', 'src', 'configurar-cli.js');
const LOCK_MODULO = path.join(__dirname, '..', 'src', 'instance-lock.js');

// Executa a CLI em processo, sem terminal, capturando saída e erro.
async function exec(argv, { env, tty = false, input } = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    env,
    tty,
    input: input ?? new PassThrough(),
    output: { write: (t) => out.push(String(t).replace(/\n$/, '')) },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), all: `${out.join('\n')}\n${err.join('\n')}` };
}

const arquivo = (dir) => path.join(dir, 'settings.json');

test('listar --json mostra origem de cada valor e nunca devolve segredo', async () => {
  const dir = tmpdir('cfg-a-');
  fs.writeFileSync(path.join(dir, 'service.env'), '# modelo\nAFTER_SEED=keep\nLOG_LEVEL="warn"\n');
  settings.update({ dataDir: dir, env: {}, changes: { PORT: 8123 }, expectedRevision: 0 });
  const env = { DATA_DIR: dir, PASSKEY: 'passkey-super-secreta-123' };
  const r = await exec(['listar', '--json'], { env });
  assert.equal(r.code, 0);
  assert.ok(!r.all.includes('passkey-super-secreta-123'));
  const j = JSON.parse(r.out);
  const por = Object.fromEntries(j.options.map((o) => [o.key, o]));
  assert.equal(por.PORT.source, 'file');
  assert.equal(por.PORT.value, 8123);
  assert.equal(por.AFTER_SEED.source, 'env');
  assert.equal(por.AFTER_SEED.viaServiceEnv, true);
  assert.equal(por.LOG_LEVEL.value, 'warn');
  assert.equal(por.BRIDGE_PORT.source, 'default');
  assert.equal(por.PASSKEY.secret, true);
  assert.equal(por.PASSKEY.defined, true);
  assert.equal(por.PASSKEY.value, null);
  assert.equal(j.revision, 1);
  assert.equal(por.PORT.restart, true);
  assert.equal(por.LOG_LEVEL.restart, false);
});

test('listar em texto mostra origem e se exige reinício, e obter detalha uma opção', async () => {
  const dir = tmpdir('cfg-b-');
  const env = { DATA_DIR: dir };
  const l = await exec(['listar'], { env });
  assert.equal(l.code, 0);
  assert.match(l.out, /PORT = 7000/);
  assert.match(l.out, /origem: padrão · exige reinício/);
  const o = await exec(['obter', 'AFTER_SEED'], { env });
  assert.match(o.out, /valores: delete \| stop \| keep/);
  const nao = await exec(['obter', 'NAO_EXISTE'], { env });
  assert.equal(nao.code, 1);
  assert.match(nao.err, /desconhecida/);
});

test('definir grava com a mesma validação, avisa do reinício e remover desfaz', async () => {
  const dir = tmpdir('cfg-c-');
  const env = { DATA_DIR: dir };
  const r = await exec(['definir', 'PORT=8001', 'AFTER_SEED=keep', 'DEMO_MODE=true'], { env });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Exige reinício/);
  const doc = JSON.parse(fs.readFileSync(arquivo(dir), 'utf8'));
  assert.deepEqual(doc.values, { PORT: 8001, AFTER_SEED: 'keep', DEMO_MODE: true });
  assert.equal(doc.revision, 1);
  const forma2 = await exec(['definir', 'BRIDGE_PORT', '8002', '--json'], { env });
  assert.deepEqual(JSON.parse(forma2.out).changed, ['BRIDGE_PORT']);
  const rem = await exec(['remover', 'PORT', 'DEMO_MODE'], { env });
  assert.equal(rem.code, 0, rem.all);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(arquivo(dir), 'utf8')).values).sort(), ['AFTER_SEED', 'BRIDGE_PORT']);
});

test('entradas inválidas são recusadas e não tocam o disco', async () => {
  const dir = tmpdir('cfg-d-');
  const env = { DATA_DIR: dir };
  for (const args of [
    ['PORT=abc'], ['PORT=0'], ['AFTER_SEED=apagar'], ['ASCSTREMIO_MODE=nuvem'],
    ['PORT=9000', 'BRIDGE_PORT=9000'], ['ALLOWED_HOSTS=*.exemplo.com'], ['BRIDGE_PUBLIC_URL=http://u:p@x.com'],
    ['DEMO_MODE=talvez'], ['NAO_EXISTE=1'], ['DATA_DIR=/tmp/x'],
  ]) {
    const r = await exec(['definir', ...args], { env });
    assert.equal(r.code, 1, `${args}: ${r.all}`);
    assert.ok(!fs.existsSync(arquivo(dir)), `${args} criou o arquivo`);
  }
  const vazio = await exec(['definir', 'PORT='], { env });
  assert.equal(vazio.code, 2);
  const semValor = await exec(['definir', 'PORT'], { env });
  assert.equal(semValor.code, 2);
  const flagRuim = await exec(['definir', 'PORT=1', '--senha=x'], { env });
  assert.equal(flagRuim.code, 2);
  assert.ok(!flagRuim.all.includes('--senha=x'));
});

test('segredo nunca é aceito por argumento nem aparece na saída', async () => {
  const dir = tmpdir('cfg-e-');
  const env = { DATA_DIR: dir };
  for (const k of ['PASSKEY', 'ANNOUNCE_BASE']) {
    const r = await exec(['definir', `${k}=valor-secreto-999`], { env });
    assert.equal(r.code, 1);
    assert.ok(!r.all.includes('valor-secreto-999'));
    assert.match(r.err, /segredo/);
    const j = await exec(['definir', `${k}=valor-secreto-999`, '--json'], { env });
    assert.ok(!j.all.includes('valor-secreto-999'));
    assert.equal(JSON.parse(j.out).code, 'secret');
  }
  assert.ok(!fs.existsSync(arquivo(dir)));
});

test('opção definida pelo ambiente não é sobrescrita pelo arquivo', async () => {
  const dir = tmpdir('cfg-f-');
  const r = await exec(['definir', 'LOG_LEVEL=warn'], { env: { DATA_DIR: dir, LOG_LEVEL: 'info' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /ambiente/);
  assert.ok(!fs.existsSync(arquivo(dir)));
  // também quando vem do service.env
  fs.writeFileSync(path.join(dir, 'service.env'), 'LOG_LEVEL=info\n');
  const r2 = await exec(['definir', 'LOG_LEVEL=warn'], { env: { DATA_DIR: dir } });
  assert.equal(r2.code, 1);
});

test('conflito de revisão é recusado com código 4 e nada muda', async () => {
  const dir = tmpdir('cfg-g-');
  const env = { DATA_DIR: dir };
  assert.equal((await exec(['definir', 'PORT=8001'], { env })).code, 0);
  const r = await exec(['definir', 'PORT=8002', '--revisao', '0'], { env });
  assert.equal(r.code, 4);
  assert.match(r.err, /mudou/);
  assert.equal(JSON.parse(fs.readFileSync(arquivo(dir), 'utf8')).values.PORT, 8001);
  assert.equal((await exec(['definir', 'PORT=8002', '--revisao', '1'], { env })).code, 0);
  assert.equal((await exec(['definir', 'PORT=8003', '--revisao', 'x'], { env })).code, 2);
});

test('modo troca local/LAN e respeita a regra de contêiner', async () => {
  const dir = tmpdir('cfg-h-');
  const env = { DATA_DIR: dir };
  assert.match((await exec(['modo'], { env })).out, /Modo: local/);
  const lan = await exec(['modo', 'lan'], { env });
  assert.equal(lan.code, 0, lan.all);
  assert.match(lan.out, /aviso: Modo LAN/);
  assert.match((await exec(['modo'], { env })).out, /Modo: lan \(origem: arquivo\)/);
  const dir2 = tmpdir('cfg-h2-');
  const emConteiner = await exec(['modo', 'lan'], { env: { DATA_DIR: dir2, ASCSTREMIO_CONTAINER: '1' } });
  assert.equal(emConteiner.code, 1);
  assert.match(emConteiner.err, /BRIDGE_PUBLIC_URL/);
  assert.ok(!fs.existsSync(arquivo(dir2)));
});

test('sem TTY nada espera entrada: sem comando, guiado e recuperar sem --sim falham rápido', async () => {
  const dir = tmpdir('cfg-i-');
  const env = { DATA_DIR: dir };
  const a = await exec([], { env, tty: false });
  assert.equal(a.code, 2);
  assert.match(a.err, /Sem terminal/);
  const b = await exec(['guiado'], { env, tty: false });
  assert.equal(b.code, 2);
  fs.writeFileSync(arquivo(dir), '{ quebrado');
  const c = await exec(['recuperar'], { env, tty: false });
  assert.equal(c.code, 2);
  assert.ok(fs.existsSync(arquivo(dir)));
  const d = await exec(['inexistente'], { env });
  assert.equal(d.code, 2);
});

test('processo real sem TTY e sem stdin termina sozinho', () => {
  const dir = tmpdir('cfg-j-');
  const r = spawnSync(process.execPath, [CLI], { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  assert.equal(r.status, 2);
  assert.match(String(r.stderr), /Sem terminal/);
  const l = spawnSync(process.execPath, [CLI, 'listar', '--json'], { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  assert.equal(l.status, 0);
  assert.equal(JSON.parse(String(l.stdout)).options.length, settings.SCHEMA.length);
});

test('configuração quebrada: validar e diagnosticar apontam, definir recusa e recuperar isola o arquivo', async () => {
  const dir = tmpdir('cfg-k-');
  const env = { DATA_DIR: dir };
  fs.writeFileSync(arquivo(dir), '{ isto não é json');
  const v = await exec(['validar'], { env });
  assert.equal(v.code, 1);
  assert.match(v.out, /não é um JSON válido/);
  const d = await exec(['diagnosticar', '--json'], { env });
  assert.equal(d.code, 1);
  const dj = JSON.parse(d.out);
  assert.equal(dj.fileBroken, true);
  assert.equal(dj.ok, false);
  const l = await exec(['listar'], { env });
  assert.equal(l.code, 1); // lista, mas sinaliza o problema
  assert.match(l.out, /PORT = 7000/);
  const w = await exec(['definir', 'PORT=8001'], { env });
  assert.equal(w.code, 1);
  assert.equal(fs.readFileSync(arquivo(dir), 'utf8'), '{ isto não é json');
  const r = await exec(['recuperar', '--sim'], { env });
  assert.equal(r.code, 0, r.all);
  assert.ok(!fs.existsSync(arquivo(dir)));
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.quebrado-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ isto não é json');
  assert.equal((await exec(['validar'], { env })).code, 0);
  assert.equal((await exec(['definir', 'PORT=8001'], { env })).code, 0);
  assert.match((await exec(['recuperar', '--sim'], { env })).out, /nada a recuperar/);
});

test('arquivo com valor inválido ou segredo gravado à mão também é recuperável', async () => {
  const dir = tmpdir('cfg-l-');
  const env = { DATA_DIR: dir };
  fs.writeFileSync(arquivo(dir), JSON.stringify({ version: 1, revision: 3, values: { PORT: 'x', PASSKEY: 'abc' } }));
  const v = await exec(['validar'], { env });
  assert.equal(v.code, 1);
  assert.ok(!v.all.includes('abc\n') && !/PASSKEY.*abc/.test(v.all));
  assert.equal((await exec(['recuperar', '--sim'], { env })).code, 0);
  assert.equal((await exec(['validar'], { env })).code, 0);
});

test('problema que vem do ambiente não é "recuperado" (a correção é no service.env)', async () => {
  const dir = tmpdir('cfg-m-');
  const env = { DATA_DIR: dir, PORT: 'abc' };
  assert.equal((await exec(['validar'], { env })).code, 1);
  const r = await exec(['recuperar', '--sim'], { env });
  assert.equal(r.code, 0);
  assert.match(r.out, /nada a recuperar/);
});

test('recuperar com TTY pergunta e só age com "sim"', async () => {
  const dir = tmpdir('cfg-n-');
  const env = { DATA_DIR: dir };
  fs.writeFileSync(arquivo(dir), 'lixo');
  const nao = new PassThrough();
  nao.end('nao\n');
  const a = await exec(['recuperar'], { env, tty: true, input: nao });
  assert.match(a.out, /Cancelado/);
  assert.ok(fs.existsSync(arquivo(dir)));
  const sim = new PassThrough();
  sim.end('sim\n');
  const b = await exec(['recuperar'], { env, tty: true, input: sim });
  assert.equal(b.code, 0, b.all);
  assert.ok(!fs.existsSync(arquivo(dir)));
});

// Filho que segura a trava da instância até o stdin fechar (simula o serviço em execução).
const SERVICO = `
const { acquireInstance } = require(${JSON.stringify(LOCK_MODULO)});
const i = acquireInstance(JSON.parse(process.env.CFG));
process.stdout.write('OK\\n');
process.stdin.resume();
process.stdin.on('end', () => { i.release(); process.exit(0); });
`;

function iniciaServico(dir) {
  const cfg = { dataDir: dir, torrentDir: path.join(dir, 'torrents'), storeDir: path.join(dir, 'cache') };
  const child = spawn(process.execPath, ['-e', SERVICO], { env: { ...process.env, CFG: JSON.stringify(cfg) } });
  const pronto = new Promise((resolve) => child.stdout.once('data', resolve));
  const fim = new Promise((resolve) => child.on('exit', resolve));
  return { pronto, parar: () => { child.stdin.end(); return fim; } };
}

test('com o aplicativo ativo: consulta funciona e escrita é recusada (código 3); parado, volta a gravar', async () => {
  const dir = tmpdir('cfg-o-');
  const env = { DATA_DIR: dir };
  const svc = iniciaServico(dir);
  await svc.pronto;
  try {
    assert.equal((await exec(['listar', '--json'], { env })).code, 0);
    const d = await exec(['diagnosticar'], { env });
    assert.match(d.out, /em execução/);
    const w = await exec(['definir', 'PORT=8001'], { env });
    assert.equal(w.code, 3);
    assert.match(w.err, /parado/);
    assert.ok(!fs.existsSync(arquivo(dir)));
    assert.equal((await exec(['remover', 'PORT'], { env })).code, 3);
    assert.equal((await exec(['recuperar', '--sim'], { env })).code, 0); // nada a recuperar: não escreve
    fs.writeFileSync(arquivo(dir), 'lixo');
    assert.equal((await exec(['recuperar', '--sim'], { env })).code, 3);
    assert.equal(fs.readFileSync(arquivo(dir), 'utf8'), 'lixo');
    // processo real, como o usuário rodaria
    const real = spawnSync(process.execPath, [CLI, 'definir', 'PORT=8001'], { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    assert.equal(real.status, 3);
  } finally {
    await svc.parar();
  }
  fs.rmSync(arquivo(dir));
  assert.equal((await exec(['definir', 'PORT=8001'], { env })).code, 0);
});

test('modo guiado: troca o modo, altera e remove opções, e EOF encerra sem gravar', async () => {
  const dir = tmpdir('cfg-p-');
  const env = { DATA_DIR: dir };
  const input = new PassThrough();
  // 2 = modo -> lan ; 3 = alterar -> escolhe pelo nome AFTER_SEED -> keep ; 4 = remover -> número 1 ; q
  input.end(['2', 'lan', '3', 'AFTER_SEED', 'keep', '4', '1', 'q', ''].join('\n'));
  const r = await exec([], { env, tty: true, input });
  assert.equal(r.code, 0, r.all);
  const doc = JSON.parse(fs.readFileSync(arquivo(dir), 'utf8'));
  assert.equal(doc.values.AFTER_SEED, 'keep');
  assert.ok(!('ASCSTREMIO_MODE' in doc.values)); // removido pelo passo 4 (primeira opção do arquivo)
  assert.equal(doc.revision, 3);

  const dir2 = tmpdir('cfg-p2-');
  const eof = new PassThrough();
  eof.end('3\nPORT\n');
  const r2 = await exec([], { env: { DATA_DIR: dir2 }, tty: true, input: eof });
  assert.equal(r2.code, 0);
  assert.ok(!fs.existsSync(arquivo(dir2)));
});

test('modo guiado recusa valor inválido sem gravar e mostra o motivo', async () => {
  const dir = tmpdir('cfg-q-');
  const input = new PassThrough();
  input.end(['3', 'PORT', 'abc', 'q', ''].join('\n'));
  const r = await exec([], { env: { DATA_DIR: dir }, tty: true, input });
  assert.equal(r.code, 0);
  assert.match(r.out, /Recusado: PORT: deve ser um número/);
  assert.ok(!fs.existsSync(arquivo(dir)));
});

test('modo guiado: quem editou o arquivo por fora entre a leitura e a gravação gera conflito', async () => {
  const dir = tmpdir('cfg-r-');
  const env = { DATA_DIR: dir };
  const input = new PassThrough();
  const pronto = exec([], { env, tty: true, input });
  // O menu já leu a revisão 0; outro escritor grava antes da alteração do usuário.
  await new Promise((r) => setTimeout(r, 100));
  settings.update({ dataDir: dir, env: {}, changes: { PORT: 8500 }, expectedRevision: 0 });
  input.end(['3', 'AFTER_SEED', 'keep', 'q', ''].join('\n'));
  const r = await pronto;
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Recusado: A configuração mudou/);
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo(dir), 'utf8')).values, { PORT: 8500 });
});

test('recuperar relê sob a trava: arquivo corrigido ou trocado por outro processo não é isolado', () => {
  const admin = require('../src/config-admin');
  const dir = tmpdir('cfg-s-');
  const env = { DATA_DIR: dir };
  fs.writeFileSync(arquivo(dir), 'lixo 1');
  const assinatura = admin.inspect({ env }).signature;
  // outro processo grava uma configuração válida depois da decisão
  fs.writeFileSync(arquivo(dir), JSON.stringify({ version: 1, revision: 1, values: { AFTER_SEED: 'keep' } }));
  assert.throws(() => admin.recover({ env, expectedSignature: assinatura }), { code: 'nothing' });
  assert.ok(fs.existsSync(arquivo(dir)));
  // ainda quebrado, mas com outro conteúdo que o usuário não viu
  fs.writeFileSync(arquivo(dir), 'lixo 2');
  assert.throws(() => admin.recover({ env, expectedSignature: assinatura }), { code: 'changed' });
  assert.equal(fs.readFileSync(arquivo(dir), 'utf8'), 'lixo 2');
  assert.ok(admin.recover({ env, expectedSignature: admin.inspect({ env }).signature }).backup);
});
