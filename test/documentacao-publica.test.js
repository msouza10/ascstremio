const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const barrier = path.resolve(__dirname, '..', 'scripts', 'check-no-secrets.sh');

// A barreira de distribuição é Bash e roda no job Linux da CI.
test('publicação aceita guias explícitos e barra notas privadas inclusive no tarball', {
  skip: process.platform === 'win32',
}, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-publicacao-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const app = path.join(temp, 'pacote');
  fs.mkdirSync(path.join(app, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(app, 'README.md'), '# Exemplo público\n');
  fs.writeFileSync(path.join(app, 'docs', 'uso.md'), '# Uso\n');
  const scan = (target = app) => spawnSync('bash', [barrier, target], { encoding: 'utf8' });
  const publicResult = scan();
  assert.equal(publicResult.status, 0, publicResult.stdout + publicResult.stderr);

  const note = path.join(app, 'docs', 'nota-local.md');
  fs.writeFileSync(note, '# Nota privada simulada\n');
  assert.equal(scan().status, 1, 'uma nota fora da lista pública precisa bloquear');

  const archive = path.join(temp, 'pacote.tar.gz');
  const pack = spawnSync('tar', ['-czf', archive, '-C', temp, 'pacote'], { encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  assert.equal(scan(archive).status, 1, 'a pasta raiz do tarball não pode esconder notas');

  fs.unlinkSync(note);
  const repack = spawnSync('tar', ['-czf', archive, '-C', temp, 'pacote'], { encoding: 'utf8' });
  assert.equal(repack.status, 0, repack.stderr);
  const cleanArchive = scan(archive);
  assert.equal(cleanArchive.status, 0, cleanArchive.stdout + cleanArchive.stderr);

  // Arquivos não Markdown em docs/ também podem conter dados privados.
  fs.writeFileSync(path.join(app, 'docs', 'resposta-site.html'), '<p>Simulação</p>');
  assert.equal(scan().status, 1, 'a permissão dos guias não libera a pasta inteira');
  fs.unlinkSync(path.join(app, 'docs', 'resposta-site.html'));
  fs.mkdirSync(path.join(app, 'private'));
  fs.writeFileSync(path.join(app, 'private', 'conta.txt'), 'dados simulados');
  assert.equal(scan().status, 1, 'a inspeção sem Git não pode ocultar private/');
});

// A licença precisa acompanhar o código em cada formato entregue (tarball, instalador e imagem).
test('a licença MIT está versionada e entra no pacote, no instalador e na imagem', () => {
  const raiz = path.resolve(__dirname, '..');
  const ler = (...partes) => fs.readFileSync(path.join(raiz, ...partes), 'utf8');
  assert.match(ler('LICENSE'), /^MIT License/);
  assert.equal(JSON.parse(ler('package.json')).license, 'MIT');
  for (const arquivo of [['scripts', 'build-release.sh'], ['windows', 'build.sh'], ['Dockerfile']]) {
    assert.match(ler(...arquivo), /\bLICENSE\b/, `${arquivo.join('/')} não copia o LICENSE`);
  }
});
