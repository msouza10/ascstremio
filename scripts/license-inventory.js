#!/usr/bin/env node
'use strict';

// O lockfile descreve candidatos; somente a árvore montada prova o que foi redistribuído.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Regras simples e conservadoras: só esta lista curta de SPDX permissivos dispensa atenção;
// todo o resto vai para revisão humana. Não é parecer jurídico nem juízo de compatibilidade.
const PERMISSIVAS = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
const COPYLEFT_FRACO = /^(MPL|LGPL|EPL|CDDL)/i;
const COPYLEFT = /^(GPL|AGPL|EUPL|CC-BY-SA)/i;

// Lê a licença do package.json instalado: `license` string SPDX, `license` objeto legado {type}
// e o campo legado `licenses` (array). O lockfile v3 não traz licença, por isso ela vem daqui.
function lerLicenca(manifesto) {
  if (!manifesto || typeof manifesto !== 'object') return { licenca: null, legado: false };
  const l = manifesto.license;
  if (typeof l === 'string' && l.trim()) return { licenca: l.trim(), legado: false };
  // `license: ['MIT']` é um formato antigo: trata como lista legada.
  if (Array.isArray(l)) return lerLicenca({ licenses: l });
  if (l && typeof l === 'object' && typeof l.type === 'string' && l.type.trim()) return { licenca: l.type.trim(), legado: true };
  if (Array.isArray(manifesto.licenses)) {
    const tipos = manifesto.licenses.map(x => (typeof x === 'string' ? x : x && x.type)).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    if (tipos.length) return { licenca: tipos.join(' OR '), legado: true };
  }
  return { licenca: null, legado: false };
}

function motivosDeLicenca(licenca) {
  if (licenca === 'desconhecida') return ['licenca-desconhecida'];
  // Espaços ao redor: 'GPL-3.0-or-later' é um identificador, não uma expressão composta.
  if (/\s(OR|AND|WITH)\s/i.test(licenca)) return ['licenca-composta'];
  // Só um par externo balanceado sai; parêntese solto deixa o texto fora da lista permissiva.
  const id = licenca.replace(/^\((.*)\)$/, '$1').trim();
  if (PERMISSIVAS.has(id)) return [];
  if (COPYLEFT_FRACO.test(id)) return ['copyleft-fraco'];
  return [COPYLEFT.test(id) ? 'copyleft' : 'licenca-incomum'];
}

// Manifesto ilegível não pode se confundir com "sem licença": o motivo fica registrado.
function lerManifesto(diretorio) {
  try {
    return { manifesto: JSON.parse(fs.readFileSync(path.join(diretorio, 'package.json'), 'utf8')) };
  } catch (err) {
    return { manifesto: null, erro: err.message };
  }
}

function inventariar(raiz, { instalado = false } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8'));
  const componentes = [];
  for (const [local, pacote] of Object.entries(lock.packages || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!local || pacote.dev) continue;
    const diretorio = path.join(raiz, local);
    if (instalado && !fs.existsSync(path.join(diretorio, 'package.json'))) continue;
    const textos = [];
    const binarios = [];
    function visitar(pasta) {
      for (const item of fs.readdirSync(pasta, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (item.isSymbolicLink()) continue;
        const arquivo = path.join(pasta, item.name);
        if (item.isDirectory()) {
          if (item.name !== 'node_modules' && item.name !== '.git') visitar(arquivo);
        } else if (item.isFile()) {
          const relativo = path.relative(raiz, arquivo).split(path.sep).join('/');
          if (/^(licen[cs]e|copying|copyright|notice|authors)([.\-_]|$)/i.test(item.name) && !/\.(m?js|cjs|ts|json)$/i.test(item.name)) textos.push(relativo);
          if (/\.(node|dll|exe|dylib|so(?:\.\d+)*)$/i.test(item.name)) binarios.push({ caminho: relativo, sha256: crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex') });
        }
      }
    }
    if (instalado) visitar(diretorio);
    const lido = instalado ? lerManifesto(diretorio) : { manifesto: null };
    const manifesto = lido.manifesto;
    const lida = lerLicenca(manifesto);
    const licenca = lida.licenca || (typeof pacote.license === 'string' && pacote.license) || 'desconhecida';
    const atencao = motivosDeLicenca(licenca);
    if (lida.legado) atencao.push('campo-legado');
    if (lido.erro) atencao.push('manifesto-ilegivel');
    if (instalado && !textos.length) atencao.push('sem-texto-de-licenca');
    componentes.push({ caminho: local, nome: (manifesto && typeof manifesto.name === 'string' && manifesto.name) || pacote.name || local.split('node_modules/').at(-1), versao: pacote.version,
      origem: pacote.resolved || null, integridade: pacote.integrity || null, licencaDeclarada: licenca, atencao,
      textos, binarios, revisao: instalado && textos.length ? 'Revisar termos e avisos nos textos indicados.' : 'Pendente: conferir textos e obrigações no artefato instalado.' });
  }
  return { formato: 1, escopo: instalado ? 'Árvore npm efetivamente instalada; não inclui dependências internas de binários nem sistema operacional.' : 'Candidatos de produção do lockfile; inclui opcionais de outras plataformas e não comprova instalação.',
    componentes, atencao: componentes.filter(c => c.atencao.length).map(c => ({ caminho: c.caminho, nome: c.nome, versao: c.versao, licencaDeclarada: c.licencaDeclarada, motivos: c.atencao })),
    pendencias: ['Cada item em `atencao` requer revisão humana; a ausência de item não é aprovação nem conclusão jurídica.', 'A declaração SPDX não substitui leitura dos termos.', 'Node, WinSW, sistema operacional e bibliotecas incorporadas em binários exigem inventário e revisão próprios.', 'Metadados, artes, marcas e conteúdo remoto não têm permissão comprovada por este inventário.'] };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const instalado = args.includes('--installed');
  const posicionais = args.filter(arg => arg !== '--installed');
  if (posicionais.length !== 2) {
    console.error('Uso: node scripts/license-inventory.js RAIZ SAÍDA [--installed]');
    process.exitCode = 2;
  } else {
    const destino = path.resolve(posicionais[1]);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const inventario = inventariar(path.resolve(posicionais[0]), { instalado });
    fs.writeFileSync(destino, `${JSON.stringify(inventario, null, 2)}\n`);
    // Só informa: a revisão é humana e o inventário não decide nada sozinho.
    console.error(`Inventário: ${inventario.componentes.length} componentes; ${inventario.atencao.length} requerem revisão (ver "atencao").`);
  }
}
module.exports = { inventariar };
