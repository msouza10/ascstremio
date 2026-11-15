#!/usr/bin/env node
// Hook PreToolUse (Edit, Write, MultiEdit) do Claude Code: lembra do TDD (AGENTS.md) quando alguém
// vai editar código em `src/` e nenhum teste de `test/` foi criado ou alterado ainda.
//
// É só um lembrete: informa o agente e deixa a edição seguir. Nunca bloqueia nem decide permissão,
// e na dúvida (entrada quebrada, fora de um repositório git, git indisponível) fica em silêncio:
// um lembrete que atrapalha o trabalho pior do que ajuda. Lembra uma vez por arquivo e por sessão.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const EXTENSOES = new Set(['.js', '.cjs', '.mjs']);

const MENSAGEM = [
  'TDD (AGENTS.md): você vai editar código em src/ e nenhum teste de test/ foi criado ou alterado ainda.',
  'Escreva e rode primeiro o teste que falha, pela porta de entrada real (rota do painel ou função pública),',
  'e só então altere src/. Antes de começar a tarefa, rode ecc:ecc-recipes <descrição> para escolher o fluxo.',
  'Se for só texto, comentário ou renomeação sem mudar comportamento, siga em frente.',
].join(' ');

// Decisão pura. `arquivo` é o alvo da edição; `raiz`, a raiz do repositório.
function decidir({ arquivo, raiz, testesAlterados, marcadorExiste }) {
  const nao = { lembrar: false };
  if (typeof arquivo !== 'string' || arquivo === '' || typeof raiz !== 'string') return nao;
  const rel = path.relative(raiz, path.resolve(raiz, arquivo));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return nao;
  const partes = rel.split(path.sep);
  if (partes[0] !== 'src' || partes.length < 2 || !EXTENSOES.has(path.extname(rel))) return nao;
  if (testesAlterados || marcadorExiste) return nao;
  return { lembrar: true, mensagem: MENSAGEM };
}

// Marcador por sessão e por arquivo. O id da sessão vem de fora: só letras, números, _ e - entram no
// nome, então ele nunca sai do diretório temporário.
function marcadorPath(sessao, arquivo) {
  const id = String(sessao ?? 'sem-sessao').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const hash = createHash('sha1').update(String(arquivo)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `ascstremio-tdd-${id}-${hash}`);
}

// realpath que aceita arquivo ainda inexistente (Write cria): resolve a pasta e junta o nome. Usa o
// `.native` porque só ele expande os nomes curtos 8.3 do Windows (o TEMP do runner é `RUNNER~1`),
// enquanto o git devolve o caminho longo: sem isso o arquivo parece estar fora do repositório.
function real(p) {
  try { return fs.realpathSync.native(p); } catch { /* segue */ }
  try { return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)); } catch { return p; }
}

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });

function main() {
  let entrada;
  try { entrada = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const alvo = entrada?.tool_input?.file_path ?? entrada?.tool_input?.notebook_path;
  if (typeof alvo !== 'string' || alvo === '') return;
  const cwd = typeof entrada.cwd === 'string' && entrada.cwd ? entrada.cwd : process.cwd();

  const topo = git(cwd, 'rev-parse', '--show-toplevel');
  if (topo.status !== 0 || !topo.stdout.trim()) return;
  const raiz = real(topo.stdout.trim());
  const arquivo = real(path.resolve(cwd, alvo));

  // Pré-checagem barata antes de gastar um `git status`.
  if (!decidir({ arquivo, raiz, testesAlterados: false, marcadorExiste: false }).lembrar) return;
  const estado = git(raiz, 'status', '--porcelain', '--untracked-files=all', '--', 'test');
  if (estado.status !== 0) return;
  const marcador = marcadorPath(entrada.session_id, arquivo);
  const decisao = decidir({ arquivo, raiz, testesAlterados: estado.stdout.trim() !== '', marcadorExiste: fs.existsSync(marcador) });
  if (!decisao.lembrar) return;
  try { fs.writeFileSync(marcador, ''); } catch { /* sem marcador o lembrete só pode repetir */ }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decisao.mensagem } })}\n`);
}

if (require.main === module) {
  try { main(); } catch { /* o lembrete nunca derruba a edição */ }
}

module.exports = { decidir, marcadorPath, MENSAGEM };
