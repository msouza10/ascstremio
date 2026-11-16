#!/usr/bin/env node
'use strict';

// O lockfile descreve candidatos; somente a árvore montada prova o que foi redistribuído.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Regras simples e conservadoras: só esta lista curta de SPDX permissivos dispensa atenção;
// todo o resto vai para revisão humana. Não é parecer jurídico nem juízo de compatibilidade.
const PERMISSIVAS = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
const COPYLEFT = /^(MPL|LGPL|GPL|AGPL|EPL|CDDL|EUPL|CC-BY-SA)/i;

// Lê a licença do package.json instalado: `license` string SPDX, `license` objeto legado {type}
// e o campo legado `licenses` (array). O lockfile v3 não traz licença, por isso ela vem daqui.
function lerLicenca(manifesto) {
  if (!manifesto || typeof manifesto !== 'object') return { licenca: null, legado: false };
  const l = manifesto.license;
  if (typeof l === 'string' && l.trim()) return { licenca: l.trim(), legado: false };
  if (l && typeof l === 'object' && typeof l.type === 'string' && l.type.trim()) return { licenca: l.type.trim(), legado: true };
  if (Array.isArray(manifesto.licenses)) {
    const tipos = manifesto.licenses.map(x => (typeof x === 'string' ? x : x && x.type)).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    if (tipos.length) return { licenca: tipos.join(' OR '), legado: true };
  }
  return { licenca: null, legado: false };
}

function motivosDeLicenca(licenca) {
  if (licenca === 'desconhecida') return ['licenca-desconhecida'];
  if (/\b(OR|AND|WITH)\b/i.test(licenca)) return ['licenca-composta'];
  const id = licenca.replace(/[()]/g, '').trim();
  if (PERMISSIVAS.has(id)) return [];
  return [COPYLEFT.test(id) ? 'copyleft-fraco' : 'licenca-incomum'];
}

function lerManifesto(diretorio) {
  try { return JSON.parse(fs.readFileSync(path.join(diretorio, 'package.json'), 'utf8')); } catch { return null; }
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
          if (/^(licen[cs]e|copying|copyright|notice|authors)([.\-_]|$)/i.test(item.name)) textos.push(relativo);
          if (/\.(node|dll|exe|dylib|so(?:\.\d+)*)$/i.test(item.name)) binarios.push({ caminho: relativo, sha256: crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex') });
        }
      }
    }
    if (instalado) visitar(diretorio);
    const manifesto = instalado ? lerManifesto(diretorio) : null;
    const lida = lerLicenca(manifesto);
    const licenca = lida.licenca || (typeof pacote.license === 'string' && pacote.license) || 'desconhecida';
    const atencao = motivosDeLicenca(licenca);
    if (lida.legado) atencao.push('campo-legado');
    if (instalado && !textos.length) atencao.push('sem-texto-de-licenca');
    componentes.push({ caminho: local, nome: (manifesto && manifesto.name) || pacote.name || local.split('node_modules/').at(-1), versao: pacote.version,
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
    fs.writeFileSync(destino, `${JSON.stringify(inventariar(path.resolve(posicionais[0]), { instalado }), null, 2)}\n`);
  }
}
module.exports = { inventariar };
