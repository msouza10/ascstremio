const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('./tmp-helper');
const { decidir, marcadorPath } = require('../scripts/tdd-lembrete');

const RAIZ = path.resolve('/projeto');
const base = { raiz: RAIZ, testesAlterados: false, marcadorExiste: false };
const em = (rel) => path.join(RAIZ, rel);

test('editar src/ sem teste alterado nem marcador: lembra, citando o teste e o ecc-recipes', () => {
  const r = decidir({ ...base, arquivo: em('src/bridge.js') });
  assert.equal(r.lembrar, true);
  assert.match(r.mensagem, /teste/i);
  assert.match(r.mensagem, /ecc:ecc-recipes/);
});

test('a mesma regra vale para a interface do painel', () => {
  assert.equal(decidir({ ...base, arquivo: em('src/ui/views.js') }).lembrar, true);
});

test('com teste alterado na árvore de trabalho não lembra', () => {
  assert.equal(decidir({ ...base, arquivo: em('src/bridge.js'), testesAlterados: true }).lembrar, false);
});

test('já lembrou para este arquivo nesta sessão: não repete', () => {
  assert.equal(decidir({ ...base, arquivo: em('src/bridge.js'), marcadorExiste: true }).lembrar, false);
});

test('fora de src/ não lembra: testes, documentação, scripts, workflows e a raiz', () => {
  for (const rel of ['test/x.test.js', 'docs/seed.md', 'AGENTS.md', 'scripts/install.sh', '.github/workflows/ci.yml', 'package.json', 'srcx/a.js']) {
    assert.equal(decidir({ ...base, arquivo: em(rel) }).lembrar, false, rel);
  }
});

test('só lembra para código: markdown e dados dentro de src/ não contam', () => {
  assert.equal(decidir({ ...base, arquivo: em('src/ui/style.css') }).lembrar, false, 'css não tem teste de unidade');
  assert.equal(decidir({ ...base, arquivo: em('src/notas.md') }).lembrar, false);
});

test('caminho fora do projeto, relativo com .. ou inválido não decide nada', () => {
  assert.equal(decidir({ ...base, arquivo: path.resolve('/outro/src/bridge.js') }).lembrar, false);
  assert.equal(decidir({ ...base, arquivo: em('src/../../fora/src/a.js') }).lembrar, false);
  assert.equal(decidir({ ...base, arquivo: undefined }).lembrar, false);
  assert.equal(decidir({ ...base, arquivo: '' }).lembrar, false);
  assert.equal(decidir({ ...base, arquivo: 42 }).lembrar, false);
});

test('o marcador é por sessão e por arquivo, e o id da sessão não escapa do diretório temporário', () => {
  const a = marcadorPath('s1', em('src/a.js'));
  assert.notEqual(a, marcadorPath('s1', em('src/b.js')), 'arquivo diferente, marcador diferente');
  assert.notEqual(a, marcadorPath('s2', em('src/a.js')), 'sessão diferente, marcador diferente');
  const malicioso = marcadorPath('../../etc/passwd', em('src/a.js'));
  assert.equal(path.dirname(malicioso), os.tmpdir(), 'não sai do diretório temporário');
  assert.doesNotMatch(path.basename(malicioso), /[\\/]/);
});

// --- execução como o Claude Code faz: JSON na entrada padrão, saída JSON ou nada ---
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'tdd-lembrete.js');
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
function repo() {
  const dir = tmpdir('tdd-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.invalid'); git(dir, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '1');
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
const roda = (dir, entrada) => spawnSync(process.execPath, [SCRIPT], { cwd: dir, input: typeof entrada === 'string' ? entrada : JSON.stringify(entrada), encoding: 'utf8' });
const sessao = () => `teste-${process.pid}-${Math.random().toString(16).slice(2)}`;
const limpa = (id, dir) => { for (const f of fs.readdirSync(os.tmpdir())) if (f.includes(id)) fs.rmSync(path.join(os.tmpdir(), f), { force: true }); fs.rmSync(dir, { recursive: true, force: true }); };

test('execução: lembra uma vez, no formato do hook PreToolUse, e não repete na mesma sessão', () => {
  const dir = repo(); const id = sessao();
  try {
    const entrada = { session_id: id, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'a.js') } };
    const primeira = roda(dir, entrada);
    assert.equal(primeira.status, 0, 'nunca bloqueia a edição');
    const saida = JSON.parse(primeira.stdout);
    assert.equal(saida.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(saida.hookSpecificOutput.additionalContext, /TDD/);
    assert.equal(saida.hookSpecificOutput.permissionDecision, undefined, 'só informa, não decide permissão');
    const segunda = roda(dir, entrada);
    assert.equal(segunda.status, 0);
    assert.equal(segunda.stdout, '', 'mesma sessão e mesmo arquivo: silêncio');
    const outroArquivo = roda(dir, { ...entrada, tool_input: { file_path: path.join(dir, 'src', 'b.js') } });
    assert.match(outroArquivo.stdout, /TDD/, 'outro arquivo lembra de novo');
  } finally { limpa(id, dir); }
});

test('execução: teste novo ou alterado na árvore de trabalho silencia o lembrete', () => {
  for (const preparar of [
    (dir) => fs.writeFileSync(path.join(dir, 'test', 'novo.test.js'), '1'), // não rastreado
    (dir) => fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), '2'), // alterado
  ]) {
    const dir = repo(); const id = sessao();
    try {
      preparar(dir);
      const r = roda(dir, { session_id: id, cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'a.js') } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    } finally { limpa(id, dir); }
  }
});

test('execução: entrada quebrada, vazia ou fora de um repositório git nunca falha nem fala', () => {
  const dir = repo(); const id = sessao();
  const semGit = tmpdir('tdd-sem-git-');
  try {
    for (const entrada of ['', 'não é json', '{}', '{"tool_input":null}', JSON.stringify({ session_id: id, cwd: dir, tool_input: { file_path: 7 } })]) {
      const r = roda(dir, entrada);
      assert.equal(r.status, 0, JSON.stringify(entrada));
      assert.equal(r.stdout, '');
    }
    const r = roda(semGit, { session_id: id, cwd: semGit, tool_name: 'Edit', tool_input: { file_path: path.join(semGit, 'src', 'a.js') } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'sem como saber se há teste, fica em silêncio em vez de adivinhar');
  } finally { limpa(id, dir); fs.rmSync(semGit, { recursive: true, force: true }); }
});

test('o hook versionado em .claude/settings.json aponta para este script e só cobre edições', () => {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.claude', 'settings.json'), 'utf8'));
  const entradas = cfg.hooks?.PreToolUse ?? [];
  const nosso = entradas.filter((e) => (e.hooks ?? []).some((h) => /scripts[\\/]tdd-lembrete\.js/.test(h.command ?? '')));
  assert.equal(nosso.length, 1, 'uma única entrada para o lembrete');
  assert.equal(nosso[0].matcher, 'Edit|Write|MultiEdit', 'só edições de arquivo, nunca Bash nem leitura');
  assert.equal(nosso[0].hooks.length, 1);
  assert.equal(nosso[0].hooks[0].type, 'command');
  assert.match(nosso[0].hooks[0].command, /^node "\$CLAUDE_PROJECT_DIR\/scripts\/tdd-lembrete\.js"$/);
  assert.equal(fs.existsSync(SCRIPT), true);
  assert.deepEqual(Object.keys(cfg.hooks), ['PreToolUse'], 'nenhum outro gancho entra por aqui');
});

test('o .gitignore libera só .claude/settings.json; o resto de .claude/ continua local', () => {
  const raiz = path.resolve(__dirname, '..');
  const ignorado = (rel) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: raiz }).status === 0;
  assert.equal(ignorado('.claude/settings.json'), false, 'a configuração do hook precisa ser versionada');
  assert.equal(ignorado('.claude/settings.local.json'), true, 'preferências locais ficam fora do git');
  assert.equal(ignorado('.claude/qualquer-outra-coisa.json'), true);
});

test('o script é versionado com permissão de execução, como o AGENTS.md exige de script novo', () => {
  const raiz = path.resolve(__dirname, '..');
  const r = spawnSync('git', ['ls-files', '-s', 'scripts/tdd-lembrete.js'], { cwd: raiz, encoding: 'utf8' });
  assert.match(r.stdout, /^100755 /, 'git update-index --chmod=+x scripts/tdd-lembrete.js');
});

test('execução: o projeto acessado por um caminho diferente do que o git informa (link simbólico) ainda lembra', { skip: process.platform === 'win32' }, () => {
  const dir = repo(); const id = sessao();
  const atalho = path.join(tmpdir('tdd-atalho-'), 'projeto');
  fs.symlinkSync(dir, atalho, 'dir');
  try {
    const r = roda(atalho, { session_id: id, cwd: atalho, tool_name: 'Edit', tool_input: { file_path: path.join(atalho, 'src', 'a.js') } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /TDD/);
  } finally { limpa(id, dir); fs.rmSync(path.dirname(atalho), { recursive: true, force: true }); }
});
