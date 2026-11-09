#!/usr/bin/env node
// Auditoria de dependências de produção com lista de exceções justificadas.
// Falha em: qualquer advisory crítico; qualquer advisory alto/moderado que NÃO esteja
// em ACEITOS abaixo. Assim um problema novo derruba o CI, e os já avaliados (sem
// correção publicada pelos mantenedores) não travam a esteira para sempre.
const { spawnSync } = require('node:child_process');

// GHSA -> por que é aceito. Reavalie quando houver versão corrigida (npm audit fix).
const ACEITOS = {
  'GHSA-2p57-rm9w-gvfp': 'ip (via webtorrent): classificação de IP público; a ponte não busca URLs informadas por terceiros. Sem correção publicada.',
  'GHSA-9wv6-86v2-598j': 'path-to-regexp (via stremio-addon-sdk): ReDoS; o addon só atende o próprio computador, com checagem de Host.',
  'GHSA-rhx6-c78j-4q9w': 'path-to-regexp (via stremio-addon-sdk): idem.',
  'GHSA-37ch-88jc-xwx2': 'path-to-regexp (via stremio-addon-sdk): idem; as rotas do addon são fixas.',
  'GHSA-52f5-9888-hmc6': 'tmp (via inquirer do CLI do stremio-addon-sdk): não é carregado em execução.',
  'GHSA-ph9p-34f9-6g65': 'tmp (via inquirer do CLI do stremio-addon-sdk): não é carregado em execução.',
};

const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
let report;
try { report = JSON.parse(r.stdout); } catch { console.error('npm audit não devolveu JSON:', r.stderr || r.stdout); process.exit(2); }

const achados = new Map();
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via === 'string') continue;
    const id = String(via.url ?? '').split('/').pop();
    achados.set(id, { severidade: via.severity, titulo: via.title, pacote: via.name });
  }
}

let falhou = false;
for (const [id, a] of achados) {
  const aceito = ACEITOS[id];
  const bloqueia = a.severidade === 'critical' || !aceito;
  if (bloqueia) falhou = true;
  console.log(`${bloqueia ? 'FALHA ' : 'aceito'} ${a.severidade.padEnd(8)} ${a.pacote} ${id} — ${a.titulo}${aceito ? `\n         motivo: ${aceito}` : ''}`);
}
for (const id of Object.keys(ACEITOS)) {
  if (!achados.has(id)) console.log(`obsoleto: ${id} não aparece mais; remova de ACEITOS`);
}
console.log(falhou ? '\nAuditoria reprovada.' : `\nAuditoria ok (${achados.size} advisory(ies), todos avaliados).`);
process.exit(falhou ? 1 : 0);
