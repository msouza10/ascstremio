#!/usr/bin/env node
'use strict';

// O lockfile descreve candidatos; somente a árvore montada prova o que foi redistribuído.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
    componentes.push({ caminho: local, nome: pacote.name || local.split('node_modules/').at(-1), versao: pacote.version,
      origem: pacote.resolved || null, integridade: pacote.integrity || null, licencaDeclarada: pacote.license || null,
      textos, binarios, revisao: instalado && textos.length ? 'Revisar termos e avisos nos textos indicados.' : 'Pendente: conferir textos e obrigações no artefato instalado.' });
  }
  return { formato: 1, escopo: instalado ? 'Árvore npm efetivamente instalada; não inclui dependências internas de binários nem sistema operacional.' : 'Candidatos de produção do lockfile; inclui opcionais de outras plataformas e não comprova instalação.',
    componentes, pendencias: ['A declaração SPDX não substitui leitura dos termos.', 'Node, WinSW, sistema operacional e bibliotecas incorporadas em binários exigem inventário e revisão próprios.', 'Metadados, artes, marcas e conteúdo remoto não têm permissão comprovada por este inventário.'] };
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
