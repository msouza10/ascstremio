#!/usr/bin/env node
// Retenção por orçamento (issue #27): prévia e execução confirmada. Veja docs/manutencao.md.
//   npm run retencao                          prévia (padrão; não remove nada)
//   npm run retencao -- --executar <plano>    executa o plano que a prévia mostrou
//
// Fala com a ponte em execução pelas rotas administrativas (token de DATA_DIR/admin-key), a mesma
// via das credenciais. Escolha deliberada: a ponte conhece reproduções, sessões e o tracker; com o
// aplicativo parado nada disso é sabido, então não há modo "offline" que apague arquivos.
// A execução exige o id do plano emitido por uma prévia recente (vale 10 minutos).

const fs = require('fs');
const path = require('path');
const { config } = require('./credenciais-cli');

const USO = 'uso: retencao [--executar <plano>]';
const gib = (n) => `${(n / 1024 ** 3).toFixed(2)} GiB`;

async function call(cfg, method, route, doFetch) {
  let token;
  try { token = fs.readFileSync(path.join(cfg.dataDir, 'admin-key'), 'utf8').trim(); } catch {
    throw new Error('não achei admin-key em DATA_DIR: o aplicativo já foi iniciado com este DATA_DIR?');
  }
  let res;
  try { res = await doFetch(`${cfg.bridge}${route}`, { method, headers: { 'X-Admin-Token': token } }); } catch {
    throw new Error(`a ponte não respondeu em ${cfg.bridge}: o aplicativo está em execução?`);
  }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function mostraPrevia(p, out) {
  if (p.desligada) { out('Retenção desligada (RETENTION_MODE=off). Nada a fazer.'); return; }
  const pol = p.politica;
  out(`Política: orçamento ${pol.budgetGiB ? `${pol.budgetGiB} GiB` : 'sem limite'}, máximo ${pol.maxTitles || 'sem limite'} título(s), parado há ${pol.minAgeDays}+ dia(s).`);
  if (p.totalBytes !== undefined) out(`Biblioteca em disco: ${p.totalTitulos} título(s), ${gib(p.totalBytes)} (estimativa).`);
  for (const a of p.avisos ?? []) out(`Aviso: ${a}`);
  if (p.candidatos.length === 0) out('Nenhum candidato.');
  p.candidatos.forEach((c, i) => out(`${i + 1}. ${c.nome} (${c.infoHash.slice(0, 8)}) ${gib(c.bytes)}, último uso há ${c.idadeDias} dia(s), motivo: ${c.motivo}`));
  if (p.protegidos?.length) out(`Protegidos (não saem): ${p.protegidos.length}; motivos: ${[...new Set(p.protegidos.map((x) => x.motivo))].join(', ')}.`);
  if (p.executavel) {
    out(`Total estimado: ${gib(p.bytesEstimados)}. Nada foi removido.`);
    out('Para executar exatamente esta lista (o tracker será relido e cada título reconferido):');
    out(`  npm run retencao -- --executar ${p.plano}`);
  }
}

async function run(argv, { env = process.env, doFetch = fetch, out = console.log } = {}) {
  const cfg = config(env);
  if (argv.length === 0) {
    const r = await call(cfg, 'GET', '/retention', doFetch);
    if (!r.ok) throw new Error(r.body.error || `a ponte recusou (HTTP ${r.status})`);
    mostraPrevia(r.body, out);
    return 0;
  }
  if (argv[0] === '--executar' && argv.length === 2 && /^[0-9a-f]{12}$/.test(argv[1])) {
    const r = await call(cfg, 'POST', `/retention/run?plan=${argv[1]}`, doFetch);
    if (!r.ok) {
      out(`Nada foi removido: ${r.body.error || `HTTP ${r.status}`}`);
      return 1;
    }
    const b = r.body;
    for (const x of b.removidos) out(`Removido: ${x.nome} (${x.infoHash.slice(0, 8)}) ${gib(x.bytes)}`);
    for (const x of b.ignorados) out(`Ignorado: ${x.infoHash.slice(0, 8)} (${x.motivo})`);
    for (const x of b.falhas) out(`Falha: ${x.infoHash.slice(0, 8)} (${x.motivo})`);
    out(`Liberado: ${gib(b.bytesLiberados)}. Meta ${b.alvoAtingido ? 'atingida' : 'NÃO atingida'}.`);
    return 0;
  }
  out(USO);
  return 2;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`erro: ${err.message}`); process.exit(1); });
}

module.exports = { run };
