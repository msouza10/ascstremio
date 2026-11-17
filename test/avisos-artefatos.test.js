'use strict';
// Verificação estática (sem rede, Docker nem Windows) de que os avisos de terceiros
// acompanham cada artefato: tarball Linux, instalador Windows e imagem Docker (issue #103).
// Os testes leem os scripts de empacotamento; a conferência no artefato real fica nos
// testes de fumaça (scripts/smoke-container.sh e o job windows-smoke do CI).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.resolve(__dirname, '..');
const ler = (...partes) => fs.readFileSync(path.join(raiz, ...partes), 'utf8');
const linhas = (texto) => texto.split(/\r?\n/);
const publicos = new Set(linhas(ler('scripts', 'documentation-files.txt')).filter(Boolean));

test('a lista pública traz o guia de terceiros e o LEGAL.md', () => {
  assert.ok(publicos.has('docs/terceiros.md'));
  assert.ok(publicos.has('LEGAL.md'));
});

test('imagem Docker: docs/terceiros.md chega por nome exato, no mesmo caminho do tarball', () => {
  const dockerfile = ler('Dockerfile');
  assert.match(dockerfile, /^COPY docs\/terceiros\.md \.\/docs\/terceiros\.md$/m);
  assert.match(dockerfile, /^COPY package\.json LICENSE LEGAL\.md \.\/$/m);
  assert.match(dockerfile, /^COPY --from=deps \/app\/THIRD-PARTY-INVENTORY\.json /m);
  // As artes e licenças da UI (Inter e Lucide) vão junto de src/.
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  for (const aviso of ['INTER-LICENSE.txt', 'LUCIDE-LICENSE.txt']) {
    assert.ok(fs.existsSync(path.join(raiz, 'src', 'ui', 'assets', aviso)), aviso);
  }
});

test('.dockerignore mantém docs/ fora e só libera arquivos públicos por nome exato', () => {
  const regras = linhas(ler('.dockerignore')).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(regras.includes('docs'), 'docs/ continua excluída (notas privadas)');
  const excecoes = regras.filter((r) => r.startsWith('!'));
  assert.ok(excecoes.includes('!docs/terceiros.md'));
  for (const excecao of excecoes) {
    const nome = excecao.slice(1);
    assert.ok(publicos.has(nome), `${excecao} não está em scripts/documentation-files.txt`);
    assert.doesNotMatch(nome, /[*?[\]]/, `${excecao} deve ser nome exato, sem curinga`);
  }
  // A exceção vem depois da exclusão: no Docker vale a última regra que casa.
  assert.ok(regras.indexOf('!docs/terceiros.md') > regras.indexOf('docs'));
});

test('tarball Linux: copia a lista pública, o LICENSE e o inventário', () => {
  const build = ler('scripts', 'build-release.sh');
  assert.match(build, /done < scripts\/documentation-files\.txt/);
  assert.match(build, /\bcp -R src scripts windows package\.json .*\bLICENSE\b/);
  assert.match(build, /license-inventory\.js \. "dist\/stage\/\$NAME\/THIRD-PARTY-INVENTORY\.json"/);
});

test('instalador Windows: terceiros.md, inventário e licenças de runtime entram na pasta montada', () => {
  const build = ler('windows', 'build.sh');
  assert.match(build, /done < scripts\/documentation-files\.txt/);
  assert.match(build, /^cp LEGAL\.md "\$STAGE\/app\/"$/m);
  assert.match(build, /cp README\.md LICENSE /);
  assert.match(build, /THIRD-PARTY-INVENTORY\.json" --installed/);
  assert.match(build, /WinSW-LICENSE\.txt/);
  assert.match(build, /\/LICENSE "\$STAGE\/node\/"/);
  // O NSIS copia a pasta montada inteira: nenhum arquivo do staging fica de fora.
  assert.match(ler('windows', 'installer.nsi'), /File \/r "\$\{STAGE\}\\\*\.\*"/);
});

test('WinSW: avisos de log4net e YamlDotNet vêm da tag oficial, com SHA-256 fixado e conferido', () => {
  const build = ler('windows', 'build.sh');
  const hash = (nome) => {
    const m = new RegExp(`^${nome}=([0-9a-f]{64})$`, 'm').exec(build);
    assert.ok(m, `${nome} deve ser um SHA-256 fixado em windows/build.sh`);
    return m[1];
  };
  const hashes = ['LOG4NET_LICENSE_SHA256', 'LOG4NET_NOTICE_SHA256', 'YAMLDOTNET_LICENSE_SHA256'].map(hash);
  assert.equal(new Set(hashes).size, hashes.length, 'cada arquivo tem o próprio hash');
  // Tags exatas, nunca ramo móvel.
  assert.match(build, /^LOG4NET_TAG=rel\/2\.0\.12$/m);
  assert.match(build, /^YAMLDOTNET_TAG=v8\.1\.2$/m);
  assert.match(build, /apache\/logging-log4net\/\$LOG4NET_TAG\/LICENSE/);
  assert.match(build, /apache\/logging-log4net\/\$LOG4NET_TAG\/NOTICE/);
  assert.match(build, /aaubry\/YamlDotNet\/\$YAMLDOTNET_TAG\/LICENSE\.txt/);
  // A conferência falha o build; o arquivo agregado só nasce depois dela.
  assert.match(build, /\$LOG4NET_LICENSE_SHA256.*\|\| \{ echo .*não confere.*exit 1/);
  assert.match(build, /\$LOG4NET_NOTICE_SHA256.*\|\| \{ echo .*não confere.*exit 1/);
  assert.match(build, /\$YAMLDOTNET_LICENSE_SHA256.*\|\| \{ echo .*não confere.*exit 1/);
  assert.match(build, /THIRD-PARTY-WinSW\.txt/);
  // O agregado só é escrito depois das três conferências (o build usa set -e e cada uma sai com exit 1).
  assert.ok(build.lastIndexOf('YAMLDOTNET_LICENSE_SHA256') < build.indexOf('> "$STAGE/THIRD-PARTY-WinSW.txt"'),
    'o agregado deve ser montado depois das conferências');
  // As versões citadas no guia continuam coerentes com o que o build baixa.
  const guia = ler('docs', 'terceiros.md');
  assert.ok(guia.includes('log4net'), 'docs/terceiros.md cita log4net');
  assert.ok(guia.includes('YamlDotNet'), 'docs/terceiros.md cita YamlDotNet');
});

test('fumaça confere os avisos no artefato real (imagem e instalador)', () => {
  assert.match(ler('scripts', 'smoke-container.sh'), /\/app\/docs\/terceiros\.md/);
  for (const arquivo of ['/app/LICENSE', '/app/LEGAL.md', '/app/THIRD-PARTY-INVENTORY.json']) {
    assert.ok(ler('scripts', 'smoke-container.sh').includes(arquivo), arquivo);
  }
  const ci = ler('.github', 'workflows', 'ci.yml');
  for (const arquivo of ['docs\\terceiros.md', 'THIRD-PARTY-WinSW.txt', 'WinSW-LICENSE.txt', 'app\\THIRD-PARTY-INVENTORY.json']) {
    assert.ok(ci.includes(arquivo), `ci.yml não confere ${arquivo} na instalação`);
  }
});
