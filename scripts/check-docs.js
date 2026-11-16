#!/usr/bin/env node
// Verificador determinístico de documentação (issue #131, camada 1).
//
// Falha quando a documentação pública contradiz o código: variáveis do esquema de
// src/settings.js, comandos e scripts citados, links/âncoras/imagens internos, versão
// mínima do Node, nome do projeto e portas padrão. Sem rede, sem dependências e sem ler
// nada fora da lista fixa de arquivos.
//
// Escopo: SÓ os arquivos de scripts/documentation-files.txt (mais os EXTRAS abaixo, que são
// nomes exatos e públicos). Nunca glob de docs/: lá existem notas locais ignoradas pelo Git
// (invariante 1 do AGENTS.md); varrê-las faria o resultado diferir entre máquina e CI.
//
// Uso: node scripts/check-docs.js [raiz]    (sai 1 e imprime os problemas em stderr)
// Como corrigir: ajuste o texto da doc ao código (ou o código, se a doc estiver certa).

'use strict';

const fs = require('fs');
const path = require('path');

const LISTA = path.join('scripts', 'documentation-files.txt');
const DOC_VARIAVEIS = path.join('docs', 'configuracao.md');

// Arquivos públicos também verificados, fora de documentation-files.txt (que alimenta a
// barreira de distribuição). Sempre por nome exato.
const EXTRAS = ['README.md', 'AGENTS.md'];

// Variáveis que a doc pode citar sem estarem no esquema (lidas direto do ambiente ou de
// arquivos próprios). `ADDON_VERSION` NÃO entra: é uma constante local de src/addon.js, não
// uma variável de ambiente; o verificador parte do esquema e não de um regex sobre
// process.env justamente para não cobrar nem aceitar esses nomes.
const FORA_DO_ESQUEMA = new Set([
  'ASC_TORRENT_DIR', 'BRIDGE_STORE', 'ANNOUNCE_BASE', 'TORRENT_PORT',
  'ASCSTREMIO_CONTAINER', 'PASSKEY_FILE',
]);

// Onde o nome antigo `brazuka` ainda é legítimo (migração do serviço, prefixo de logs
// antigos, a regra que o proíbe e o teste que cobre o nome antigo).
const EXCECOES_BRAZUKA = new Set([
  'scripts/install.sh', 'src/logger.js', 'AGENTS.md', '.gitleaks.toml', 'test/monitor.test.js',
]);

const PREFIXOS_CITADOS = ['scripts', 'windows', 'src', 'test'];

const posix = (p) => p.split(path.sep).join('/');
const ler = (arquivo) => fs.readFileSync(arquivo, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const existe = (arquivo) => fs.existsSync(arquivo);

// Mesma regra do GitHub: minúsculas, remove tudo que não é letra, número, espaço, `_` ou `-`
// (mantém acentos), espaços viram `-`. Formatação inline do título não entra no texto.
function slug(titulo) {
  return titulo
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

// Troca o miolo de blocos de código cercados por linhas vazias, preservando a numeração.
function semBlocosDeCodigo(texto) {
  let dentro = null;
  return texto.split('\n').map((linha) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(linha);
    if (m) {
      if (!dentro) dentro = m[1][0];
      else if (m[1][0] === dentro) dentro = null;
      return '';
    }
    return dentro ? '' : linha;
  }).join('\n');
}

function ancoras(texto) {
  const vistos = new Map();
  const conjunto = new Set();
  for (const linha of semBlocosDeCodigo(texto).split('\n')) {
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(linha);
    if (!m) continue;
    const base = slug(m[1]);
    const n = vistos.get(base) ?? 0;
    vistos.set(base, n + 1);
    conjunto.add(n === 0 ? base : `${base}-${n}`);
  }
  return conjunto;
}

function lerLista(raiz) {
  const arquivo = path.join(raiz, LISTA);
  if (!existe(arquivo)) return { erro: `${posix(LISTA)} não existe`, itens: [] };
  const itens = ler(arquivo).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { itens };
}

function verificar(raiz, opcoes = {}) {
  const esquema = opcoes.esquema ?? require('../src/settings').SCHEMA;
  const problemas = [];
  const erro = (arquivo, linha, regra, mensagem) => problemas.push({ arquivo, linha, regra, mensagem });

  const { itens, erro: erroLista } = lerLista(raiz);
  if (erroLista) erro(posix(LISTA), 0, 'lista', erroLista);
  const publicos = new Set(itens);
  const arquivos = [...itens];
  for (const extra of EXTRAS) if (existe(path.join(raiz, extra)) && !publicos.has(extra)) arquivos.push(extra);

  const textos = new Map();
  for (const rel of arquivos) {
    const abs = path.join(raiz, ...rel.split('/'));
    if (!existe(abs)) {
      erro(posix(LISTA), 0, 'lista', `${rel} está na lista pública mas não existe`);
      continue;
    }
    textos.set(rel, ler(abs));
  }

  let pacote = {};
  try { pacote = JSON.parse(ler(path.join(raiz, 'package.json'))); } catch (e) {
    erro('package.json', 0, 'node', `package.json ilegível: ${e.message}`);
  }
  const scriptsNpm = new Set(Object.keys(pacote.scripts ?? {}));
  const minNode = /(\d+)/.exec(pacote.engines?.node ?? '')?.[1];
  if (!minNode) erro('package.json', 0, 'node', 'engines.node ausente: não há versão mínima do Node para conferir');

  const chaves = new Set(esquema.map((e) => e.key));

  // (a) variáveis: esquema -> doc e doc -> esquema.
  const doc = textos.get(posix(DOC_VARIAVEIS));
  if (doc === undefined) {
    erro(posix(DOC_VARIAVEIS), 0, 'variaveis', 'guia de configuração ausente da lista pública');
  } else {
    for (const chave of chaves) {
      if (!doc.includes(`\`${chave}\``)) {
        erro(posix(DOC_VARIAVEIS), 0, 'variaveis', `${chave} está no esquema (src/settings.js) mas não é documentada`);
      }
    }
    doc.split('\n').forEach((linha, i) => {
      const m = /^\|\s*`([A-Z][A-Z0-9_]+)`/.exec(linha);
      if (m && !chaves.has(m[1]) && !FORA_DO_ESQUEMA.has(m[1])) {
        erro(posix(DOC_VARIAVEIS), i + 1, 'variaveis', `${m[1]} é documentada mas não existe no esquema`);
      }
    });
  }

  // Portas padrão do esquema + a de peers do contêiner (fixada no Dockerfile).
  const portas = new Set(esquema.filter((e) => /PORT$/.test(e.key) && e.default > 0).map((e) => String(e.default)));
  try {
    const m = /TORRENT_PORT=(\d+)/.exec(ler(path.join(raiz, 'Dockerfile')));
    if (m) portas.add(m[1]);
  } catch { /* sem Dockerfile na árvore (fixtures) */ }

  for (const [rel, texto] of textos) {
    const linhas = texto.split('\n');
    const dir = path.dirname(path.join(raiz, ...rel.split('/')));
    const limpo = semBlocosDeCodigo(texto);

    linhas.forEach((linha, i) => {
      const n = i + 1;

      // (b) comandos npm.
      for (const m of linha.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
        if (!scriptsNpm.has(m[1])) erro(rel, n, 'comandos', `\`npm run ${m[1]}\` não existe em package.json`);
      }
      for (const m of linha.matchAll(/\bnpm (start|test)\b/g)) {
        if (!scriptsNpm.has(m[1])) erro(rel, n, 'comandos', `\`npm ${m[1]}\` não existe em package.json`);
      }

      // (b) caminhos de scripts, windows, src e test citados.
      const re = new RegExp(`(?<![\\w./%\\\\-])((?:${PREFIXOS_CITADOS.join('|')})/[\\w./*<>$\\{\\}-]*)`, 'g');
      for (const m of linha.matchAll(re)) {
        const alvo = m[1].replace(/[.,;:]+$/, '');
        if (/[*<>$\\{}]/.test(alvo) || alvo.endsWith('/')) continue;
        if (!existe(path.join(raiz, ...alvo.split('/')))) erro(rel, n, 'comandos', `${alvo} é citado mas não existe`);
      }

      // (d) versão mínima do Node.
      if (minNode) {
        for (const m of linha.matchAll(/\bNode(?:\.js)?\s+(?:(?:>=|≥)\s*(\d+)|(\d+)(?:\+|\s+ou\s+superior))/g)) {
          const v = m[1] ?? m[2];
          if (v !== minNode) erro(rel, n, 'node', `Node ${v} citado, mas engines exige >=${minNode}`);
        }
      }

      // (e) nome antigo.
      if (/brazuka/i.test(linha) && !EXCECOES_BRAZUKA.has(rel)) {
        erro(rel, n, 'nome', 'nome antigo `brazuka` fora dos pontos de migração');
      }

      // (f) portas 70xx citadas precisam ser as do esquema.
      for (const m of linha.matchAll(/(?<!\w|\d\.)(70\d\d)(?!\w|\.\d)/g)) {
        if (!portas.has(m[1])) erro(rel, n, 'portas', `porta ${m[1]} não bate com o esquema (${[...portas].join('/')})`);
      }

      // (f) linha da tabela de variáveis com padrão de porta divergente.
      if (rel === posix(DOC_VARIAVEIS)) {
        const t = /^\|\s*`((?:[A-Z][A-Z0-9_]*_)?PORT)`\s*\|\s*([^|]*)\|/.exec(linha);
        const entrada = t && esquema.find((e) => e.key === t[1]);
        if (entrada && entrada.default > 0 && !new RegExp(`(?<!\\d)${entrada.default}(?!\\d)`).test(t[2])) {
          erro(rel, n, 'portas', `padrão de ${t[1]} deveria ser ${entrada.default}`);
        }
      }
    });

    // (c) links e imagens internos (fora de blocos e de código inline).
    const prosa = limpo.split('\n').map((l) => l.replace(/`[^`]*`/g, (c) => ' '.repeat(c.length)));
    prosa.forEach((linha, i) => {
      const alvos = [...linha.matchAll(/(!?)\[(?:[^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => [m[1], m[2]]);
      // Imagem dentro de link (selo clicável): [![alt](img)](destino); o destino também vale.
      for (const m of linha.matchAll(/\[!\[[^\]]*\]\([^)]*\)\]\(\s*<?([^)\s>]+)>?\s*\)/g)) alvos.push(['', m[1]]);
      for (const [imagem, alvoCru] of alvos) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(alvoCru) || alvoCru.startsWith('//')) continue;
        const [caminhoCru, ancoraCrua] = alvoCru.split('#');
        let caminho = caminhoCru;
        let ancora = ancoraCrua;
        try { caminho = decodeURIComponent(caminhoCru); } catch { /* mantém cru */ }
        try { if (ancora !== undefined) ancora = decodeURIComponent(ancora); } catch { /* mantém cru */ }
        const regra = imagem ? 'imagens' : 'links';
        const abs = caminho ? path.resolve(dir, ...caminho.split('/')) : path.join(raiz, ...rel.split('/'));
        const relAlvo = posix(path.relative(raiz, abs));
        if (relAlvo.startsWith('..')) { erro(rel, i + 1, regra, `${alvoCru} aponta para fora do repositório`); continue; }
        if (!existe(abs)) { erro(rel, i + 1, regra, `${alvoCru} não existe`); continue; }
        // Guia em docs/ fora da lista pública pode existir só localmente (nota ignorada pelo Git).
        if (/^docs\/[^/]+\.md$/.test(relAlvo) && !publicos.has(relAlvo)) {
          erro(rel, i + 1, regra, `${alvoCru} não está na lista pública (${posix(LISTA)}); no clone limpo o link quebra`);
          continue;
        }
        // Âncora só é conferida em guias verificados (lista pública e extras); outros alvos só precisam existir.
        if (ancora && !imagem && textos.has(relAlvo)) {
          const textoAlvo = textos.get(relAlvo);
          if (!ancoras(textoAlvo).has(ancora.toLowerCase())) erro(rel, i + 1, regra, `âncora #${ancora} não existe em ${relAlvo}`);
        }
      }
    });
  }

  return problemas;
}

function main() {
  const raiz = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
  const problemas = verificar(raiz);
  if (!problemas.length) {
    console.log('Documentação coerente com o código.');
    return 0;
  }
  for (const p of problemas) console.error(`${p.arquivo}${p.linha ? `:${p.linha}` : ''}: [${p.regra}] ${p.mensagem}`);
  console.error(`\n${problemas.length} problema(s). Corrija a documentação (ou o código); veja docs/desenvolvimento.md.`);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { verificar, slug };
