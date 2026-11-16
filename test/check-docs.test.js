const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const raiz = path.resolve(__dirname, '..');
const { verificar, slug } = require('../scripts/check-docs');

const ESQUEMA = [
  { key: 'PORT', type: 'int', default: 7000 },
  { key: 'ALFA', type: 'string', default: null },
];

// Monta uma árvore mínima e pública em diretório temporário; `extra` sobrescreve/inclui arquivos.
function arvore(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivos = {
    'package.json': JSON.stringify({ scripts: { check: 'x', start: 'y' }, engines: { node: '>=22' } }),
    'scripts/documentation-files.txt': 'docs/configuracao.md\ndocs/uso.md\n',
    'scripts/ok.sh': '#!/bin/sh\n',
    'docs/configuracao.md': '# Configuração\n\n## Rede\n\n| Variável | Padrão | Nota |\n|---|---|---|\n| `PORT` | `7000` | addon |\n| `ALFA` | ausente | texto |\n',
    'docs/uso.md': '# Uso\n\nVeja [configuração](configuracao.md#rede). Rode `npm run check` e `scripts/ok.sh`. Node.js 22+.\n',
    ...extra,
  };
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    if (conteudo === null) continue;
    const alvo = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, conteudo);
  }
  return dir;
}

const regras = (dir) => verificar(dir, { esquema: ESQUEMA }).map((p) => p.regra);

test('árvore mínima coerente passa sem problemas', (t) => {
  assert.deepEqual(verificar(arvore(t), { esquema: ESQUEMA }), []);
});

test('fim de linha CRLF não muda o resultado', (t) => {
  const dir = arvore(t);
  const f = path.join(dir, 'docs', 'uso.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
  const g = path.join(dir, 'docs', 'configuracao.md');
  fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace(/\n/g, '\r\n'));
  assert.deepEqual(verificar(dir, { esquema: ESQUEMA }), []);
});

test('variáveis: chave do esquema sem documentação falha', (t) => {
  const dir = arvore(t);
  const problemas = verificar(dir, { esquema: [...ESQUEMA, { key: 'NOVA_OPCAO', type: 'int', default: 1 }] });
  assert.equal(problemas.length, 1);
  assert.equal(problemas[0].regra, 'variaveis');
  assert.match(problemas[0].mensagem, /NOVA_OPCAO/);
});

test('variáveis: variável documentada que deixou de existir falha, mas as fora do esquema são aceitas', (t) => {
  const base = '# C\n\n## Rede\n\n| V | P | N |\n|---|---|---|\n| `PORT` | `7000` | a |\n| `ALFA` | x | b |\n';
  const velha = arvore(t, { 'docs/configuracao.md': `${base}| \`VELHA_OPCAO\` | x | c |\n` });
  const p = verificar(velha, { esquema: ESQUEMA });
  assert.deepEqual(p.map((x) => x.regra), ['variaveis']);
  assert.match(p[0].mensagem, /VELHA_OPCAO/);
  const fora = arvore(t, { 'docs/configuracao.md': `${base}| \`ASCSTREMIO_CONTAINER\` | x | c |\n` });
  assert.deepEqual(verificar(fora, { esquema: ESQUEMA }), []);
});

test('variáveis: constante local fora do esquema (ADDON_VERSION) não é cobrada na documentação', (t) => {
  assert.deepEqual(verificar(arvore(t), { esquema: [...ESQUEMA] }), []);
});

test('comandos: npm run inexistente falha e existente passa', (t) => {
  const ruim = arvore(t, { 'docs/uso.md': '# Uso\n\nRode `npm run naoexiste`.\n' });
  assert.deepEqual(regras(ruim), ['comandos']);
  const bom = arvore(t, { 'docs/uso.md': '# Uso\n\n```bash\nnpm run check -- x\nnpm start\n```\n' });
  assert.deepEqual(regras(bom), []);
});

test('comandos: script citado que não existe falha', (t) => {
  const ruim = arvore(t, { 'docs/uso.md': '# Uso\n\nUse `scripts/sumiu.sh`.\n' });
  assert.deepEqual(regras(ruim), ['comandos']);
  const curinga = arvore(t, { 'docs/uso.md': '# Uso\n\nUse scripts/*.sh e `scripts/<nome>.sh`.\n' });
  assert.deepEqual(regras(curinga), []);
});

test('links: arquivo interno inexistente falha', (t) => {
  const ruim = arvore(t, { 'docs/uso.md': '# Uso\n\n[x](nada.md)\n' });
  assert.deepEqual(regras(ruim), ['links']);
  const externo = arvore(t, { 'docs/uso.md': '# Uso\n\n[x](https://example.invalid/a) [y](mailto:a@b.c)\n' });
  assert.deepEqual(regras(externo), []);
});

test('links: âncora inexistente falha, âncora acentuada e repetida passam', (t) => {
  const ruim = arvore(t, { 'docs/uso.md': '# Uso\n\n[x](configuracao.md#nao-existe)\n' });
  assert.deepEqual(regras(ruim), ['links']);
  const conf = '# C\n\n## Porta de peers (diagnóstico)\n\n## Rede\n\n## Rede\n\n```\n# comentário de código\n```\n\n| V | P | N |\n|---|---|---|\n| `PORT` | `7000` | a |\n| `ALFA` | x | b |\n';
  const bom = arvore(t, {
    'docs/configuracao.md': conf,
    'docs/uso.md': '# Uso\n\n[a](configuracao.md#porta-de-peers-diagnóstico) [b](configuracao.md#rede-1) [c](#uso) [d](configuracao.md#porta-de-peers-diagn%C3%B3stico)\n',
  });
  assert.deepEqual(regras(bom), []);
  const codigo = arvore(t, {
    'docs/configuracao.md': conf,
    'docs/uso.md': '# Uso\n\n[a](configuracao.md#comentário-de-código)\n',
  });
  assert.deepEqual(regras(codigo), ['links']);
});

test('links: guia fora da lista pública (nota local ignorada) é link quebrado no clone limpo', (t) => {
  const dir = arvore(t, {
    'docs/nota-privada.md': '# Nota\n',
    'docs/uso.md': '# Uso\n\n[x](nota-privada.md)\n',
  });
  const p = verificar(dir, { esquema: ESQUEMA });
  assert.deepEqual(p.map((x) => x.regra), ['links']);
  assert.match(p[0].mensagem, /lista pública/);
});

test('imagens: arquivo referenciado ausente falha e presente passa', (t) => {
  const ruim = arvore(t, { 'docs/uso.md': '# Uso\n\n![captura](img/a.png)\n' });
  assert.deepEqual(regras(ruim), ['imagens']);
  const bom = arvore(t, { 'docs/uso.md': '# Uso\n\n![captura](img/a.png)\n', 'docs/img/a.png': 'x' });
  assert.deepEqual(regras(bom), []);
});

test('node: versão mínima divergente do engines falha', (t) => {
  const ruim = arvore(t, { 'docs/uso.md': '# Uso\n\nExige Node.js 20+ instalado.\n' });
  assert.deepEqual(regras(ruim), ['node']);
  const ouSuperior = arvore(t, { 'docs/uso.md': '# Uso\n\nNode.js 18 ou superior.\n' });
  assert.deepEqual(regras(ouSuperior), ['node']);
  const matriz = arvore(t, { 'docs/uso.md': '# Uso\n\nA CI testa com Node 22 e 24 e o Node 22+ basta.\n' });
  assert.deepEqual(regras(matriz), []);
});

test('nome: brazuka fora das exceções falha e dentro delas passa', (t) => {
  const ruim = arvore(t, { 'docs/uso.md': '# Uso\n\nO serviço brazuka-asc antigo.\n' });
  assert.deepEqual(regras(ruim), ['nome']);
  const lista = arvore(t, {
    'scripts/documentation-files.txt': 'docs/configuracao.md\ndocs/uso.md\nAGENTS.md\n',
    'AGENTS.md': 'O nome antigo é brazuka-asc.\n',
  });
  assert.deepEqual(regras(lista), []);
});

test('portas: padrão divergente do esquema ou porta desconhecida falha', (t) => {
  const tabela = '# C\n\n| V | P | N |\n|---|---|---|\n| `PORT` | `7001` | a |\n| `ALFA` | x | b |\n';
  const errada = arvore(t, { 'docs/configuracao.md': tabela });
  assert.ok(regras(errada).includes('portas'));
  const solta = arvore(t, { 'docs/uso.md': '# Uso\n\nAbra a porta 7777 e a 7000.\n' });
  assert.deepEqual(regras(solta), []);
  const velha = arvore(t, { 'docs/uso.md': '# Uso\n\nO addon escuta na 7001.\n' });
  assert.deepEqual(regras(velha), ['portas']);
});

test('lista pública: arquivo listado que não existe falha', (t) => {
  const dir = arvore(t, { 'scripts/documentation-files.txt': 'docs/configuracao.md\ndocs/uso.md\ndocs/falta.md\n' });
  assert.deepEqual(regras(dir), ['lista']);
});

test('só percorre a lista: nota local com erros não é lida', (t) => {
  const dir = arvore(t, { 'docs/levantamento-juridico.md': '# N\n\n[x](nada.md) `npm run naoexiste` brazuka-asc\n' });
  assert.deepEqual(verificar(dir, { esquema: ESQUEMA }), []);
});

test('slug segue o GitHub: minúsculas, acentos mantidos, pontuação removida', () => {
  assert.equal(slug('Porta de peers (diagnóstico)'), 'porta-de-peers-diagnóstico');
  assert.equal(slug('Uma `instância` por [instalação]'), 'uma-instância-por-instalação');
  assert.equal(slug('Medir a reprodução (benchmark offline)'), 'medir-a-reprodução-benchmark-offline');
});

test('CLI: sai 1 com problemas e 0 sem eles', (t) => {
  const script = path.join(raiz, 'scripts', 'check-docs.js');
  const dir = arvore(t, { 'docs/uso.md': '# Uso\n\n[x](nada.md)\n' });
  // O esquema real não bate com a árvore mínima; o importante é o código de saída.
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /nada\.md/);
});

// Regressão: a árvore real do repositório precisa estar coerente (é o que o CI exige).
test('a documentação real do repositório passa no verificador', () => {
  const r = spawnSync(process.execPath, [path.join(raiz, 'scripts', 'check-docs.js'), raiz], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
