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
  fs.writeFileSync(path.join(app, 'LEGAL.md'), '# Avisos legais\n');
  fs.writeFileSync(path.join(app, 'docs', 'conformidade-juridica.md'), '# Matriz pública\n');
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

test('avisos legais acompanham os caminhos de distribuição e ficam acessíveis na documentação', () => {
  const raiz = path.resolve(__dirname, '..');
  const ler = (...partes) => fs.readFileSync(path.join(raiz, ...partes), 'utf8');
  const documentos = ler('scripts', 'documentation-files.txt').trim().split(/\r?\n/);
  assert.ok(documentos.includes('LEGAL.md'));
  assert.ok(documentos.includes('docs/conformidade-juridica.md'));
  for (const documento of documentos) assert.ok(fs.statSync(path.join(raiz, documento)).isFile(), documento);
  for (const arquivo of [['scripts', 'build-release.sh'], ['windows', 'build.sh']]) {
    assert.match(ler(...arquivo), /done < scripts\/documentation-files\.txt/, `${arquivo.join('/')} não usa a lista pública`);
  }
  assert.match(ler('Dockerfile'), /^COPY .*\bLEGAL\.md\b.*\.\/$/m);
  assert.match(ler('windows', 'build.sh'), /^cp LEGAL\.md "\$STAGE\/app\/"$/m);
  assert.match(ler('README.md'), /\]\(LEGAL\.md\)/);
  assert.match(ler('docs', 'README.md'), /\]\(\.\.\/LEGAL\.md\)/);
});

test('apresentação referencia somente imagens públicas existentes, com tema e texto alternativo', () => {
  const raiz = path.resolve(__dirname, '..');
  const readme = fs.readFileSync(path.join(raiz, 'README.md'), 'utf8');
  const lista = new Set(fs.readFileSync(path.join(raiz, 'scripts', 'documentation-files.txt'), 'utf8').trim().split(/\r?\n/));
  // O tarball também executa estes testes, mas não distribui o .gitignore do repositório.
  const arquivoIgnore = path.join(raiz, '.gitignore');
  const ignore = fs.existsSync(arquivoIgnore) ? fs.readFileSync(arquivoIgnore, 'utf8').split(/\r?\n/) : null;
  const citadas = new Set();
  const quadros = [...readme.matchAll(/<picture>([\s\S]*?)<\/picture>/g)];
  assert.ok(quadros.length > 0, 'a apresentação precisa mostrar a interface');
  for (const [, quadro] of quadros) {
    assert.match(quadro, /<source\b[^>]*media="\(prefers-color-scheme: dark\)"/);
    assert.match(quadro, /<img\b[^>]*alt="[^"\s][^"]*"/);
    for (const [, arquivo] of quadro.matchAll(/(?:src|srcset)="([^"]+)"/g)) {
      assert.ok(arquivo.startsWith('docs/imagens/'), arquivo);
      assert.ok(lista.has(arquivo), `${arquivo} precisa estar na lista pública`);
      assert.ok(fs.statSync(path.join(raiz, arquivo)).isFile(), arquivo);
      if (ignore) assert.ok(ignore.lastIndexOf(`!${arquivo}`) > ignore.lastIndexOf('*.png'), `${arquivo} precisa de exceção exata depois de *.png`);
      citadas.add(path.basename(arquivo));
    }
  }
  // A imagem do social preview não aparece no README: é enviada à mão (Settings > Social preview).
  const imagens = fs.readdirSync(path.join(raiz, 'docs', 'imagens')).filter((nome) => nome !== 'social-preview.png').sort();
  assert.deepEqual([...citadas].sort(), imagens, 'nenhuma imagem pode ficar sem referência ou liberação');
});

test('imagem do social preview tem 1280x640 e está liberada por nome exato', () => {
  const raiz = path.resolve(__dirname, '..');
  const rel = 'docs/imagens/social-preview.png';
  const bytes = fs.readFileSync(path.join(raiz, rel));
  assert.equal(bytes.readUInt32BE(16), 1280);
  assert.equal(bytes.readUInt32BE(20), 640);
  assert.ok(new Set(fs.readFileSync(path.join(raiz, 'scripts', 'documentation-files.txt'), 'utf8').trim().split(/\r?\n/)).has(rel));
  const arquivoIgnore = path.join(raiz, '.gitignore');
  if (fs.existsSync(arquivoIgnore)) {
    const ignore = fs.readFileSync(arquivoIgnore, 'utf8').split(/\r?\n/);
    assert.ok(ignore.lastIndexOf(`!${rel}`) > ignore.lastIndexOf('*.png'));
  }
});

test('guias em docs/ só citam imagens existentes, liberadas e com texto alternativo', () => {
  const raiz = path.resolve(__dirname, '..');
  const lista = new Set(fs.readFileSync(path.join(raiz, 'scripts', 'documentation-files.txt'), 'utf8').trim().split(/\r?\n/));
  for (const guia of [...lista].filter((f) => /^docs\/[^/]+\.md$/.test(f))) {
    const texto = fs.readFileSync(path.join(raiz, guia), 'utf8');
    for (const [tag] of texto.matchAll(/<img\b[^>]*>/g)) assert.match(tag, /alt="[^"\s][^"]*"/, `${guia}: imagem sem alt`);
    for (const [, alvo] of texto.matchAll(/(?:src|srcset)="([^"]+)"/g)) {
      const relativo = path.posix.normalize(path.posix.join('docs', alvo));
      assert.ok(lista.has(relativo), `${guia}: ${relativo} precisa estar na lista pública`);
      assert.ok(fs.statSync(path.join(raiz, relativo)).isFile(), `${guia}: ${relativo}`);
    }
  }
});

test('capturas públicas respeitam tamanho, dimensões e exclusão de metadados', () => {
  const pasta = path.resolve(__dirname, '..', 'docs', 'imagens');
  let total = 0;
  for (const nome of fs.readdirSync(pasta)) {
    assert.match(nome, /\.png$/, 'as capturas atuais usam PNG');
    const bytes = fs.readFileSync(path.join(pasta, nome));
    total += bytes.length;
    assert.ok(bytes.length <= 200 * 1024, `${nome} excede 200 KiB`);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', nome);
    assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 1280, `${nome}: largura`);
    assert.ok(bytes.readUInt32BE(20) > 0, `${nome}: altura`);
    let offset = 8;
    let fim = false;
    while (offset < bytes.length) {
      assert.ok(offset + 12 <= bytes.length, `${nome}: bloco truncado`);
      const tamanho = bytes.readUInt32BE(offset);
      const tipo = bytes.toString('ascii', offset + 4, offset + 8);
      assert.ok(!['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(tipo), `${nome}: metadados ${tipo}`);
      offset += tamanho + 12;
      assert.ok(offset <= bytes.length, `${nome}: tamanho de bloco inválido`);
      if (tipo === 'IEND') { fim = true; break; }
    }
    assert.ok(fim && offset === bytes.length, `${nome}: fim de PNG inválido`);
  }
  assert.ok(total <= 2 * 1024 * 1024, 'a pasta de capturas excede 2 MiB');
});
