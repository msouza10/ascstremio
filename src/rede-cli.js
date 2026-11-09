#!/usr/bin/env node
// Diagnóstico do endereço anunciado aos clientes da LAN (veja docs/configuracao.md#endereço-anunciado-na-lan).
//   npm run rede                       (mostra modo, escuta, endereço anunciado, interfaces candidatas e avisos)
//   npm run rede -- validar <endereço> (simula LAN_ADVERTISE_HOST=<endereço> sem gravar nada)
//   npm run rede -- --json
//   npm run rede -- peers              (só a porta de peers: escuta, contêiner, firewall/NAT, entradas)
//
// Só lê: não grava configuração, não abre conexões e não toca em credenciais. As URLs saem
// com o marcador <credencial>; o token só aparece, uma vez, em `credenciais criar`.
// Validar que o endereço é deste computador NÃO prova que a TV o alcança (roteador, firewall,
// isolamento de Wi-Fi): o alcance pelo cliente é sempre "desconhecido".
// A porta de peers vem do resumo que o aplicativo em execução grava em DATA_DIR (contadores,
// sem endereços); sem ele (parado ou resumo velho) o estado é "desconhecido". Nada é testado
// de fora e nenhum serviço de terceiros é contatado.

const path = require('path');
const settings = require('./settings');
const network = require('./network');

const USO = 'uso: rede [--json] | rede validar <endereço> [--json] | rede peers [--json]';

function hostOf(url) {
  try { return url ? new URL(url).hostname : null; } catch { return null; }
}

function peerReport(snap, dataDir, now) {
  const { engine, observed } = network.readPeerStatus(dataDir, now);
  return network.evaluatePeerPort({
    engine, observed, configuredPort: snap.values.TORRENT_PORT ?? 0, container: snap.container, now,
  });
}

function printPeers(p, out) {
  out(`Porta de peers: ${p.state.toUpperCase().replace('_', ' ')}`);
  out(p.summary);
  const e = p.layers.escuta;
  out(`  1. Escuta: configurada ${e.configurada || 'automática (0)'}; em uso ${e.real ?? 'desconhecida'}; ${e.protocolo}; estado ${e.estado}.`);
  out(`  2. Publicação (${p.layers.publicacao.modo}): ${p.layers.publicacao.nota}`);
  out(`  3. Firewall/NAT: ${p.layers.firewallNat.estado}. ${p.layers.firewallNat.nota}`);
  const n = p.layers.entrada;
  out(`  4. Entradas observadas desde ${n.desde ?? '-'}: ${n.observada} com evidência${n.deRedeLocal ? `, ${n.deRedeLocal} da rede local` : ''}; última: ${n.ultima ?? 'nenhuma'}.`);
  for (const x of p.notes) out(`Nota: ${x}`);
  for (const x of p.advice) out(`Orientação: ${x}`);
}

function report(snap, interfaces, dataDir, now = Date.now()) {
  const plan = snap.derived.network;
  const nomes = [...new Set([
    ...String(snap.values.ALLOWED_HOSTS || '').split(',').filter(Boolean),
    ...(plan.hostKind === 'dns' && plan.host ? [plan.host] : []),
    hostOf(snap.values.BRIDGE_PUBLIC_URL),
    hostOf(snap.values.ADDON_PUBLIC_URL),
  ].filter(Boolean))];
  return {
    modo: snap.mode,
    conteiner: snap.container,
    escuta: plan.bind,
    anunciado: { host: plan.host, origem: plan.hostSource, addon: plan.urls.addon, ponte: plan.urls.bridge, fontes: plan.sources },
    instalacao: plan.urls.addon ? `${plan.urls.addon}/<credencial>/manifest.json` : null,
    hostsAceitos: { ipLiteral: true, localhost: true, nomes },
    candidatos: snap.mode === 'lan' && !snap.container ? network.listCandidates(interfaces) : [],
    ambigua: plan.ambiguous,
    alcancePeloCliente: plan.clientReachability,
    portaPeers: dataDir ? peerReport(snap, dataDir, now) : null,
    problemas: snap.problems,
    avisos: snap.warnings,
    notas: plan.info,
  };
}

function print(r, out) {
  out(`Modo: ${r.modo}${r.conteiner ? ' (contêiner)' : ''}; escuta em ${r.escuta}.`);
  out(`Endereço anunciado: ${r.anunciado.host ?? '(nenhum utilizável)'} [origem: ${r.anunciado.origem}]`);
  out(`  addon: ${r.anunciado.addon ?? '-'} [${r.anunciado.fontes.addon}]`);
  out(`  ponte: ${r.anunciado.ponte ?? '-'} [${r.anunciado.fontes.bridge}]`);
  if (r.instalacao) out(`URL de instalação (modelo): ${r.instalacao}  (o token vem de: npm run credenciais -- criar "<nome>")`);
  out(`Hosts aceitos no cabeçalho Host: IP literal, localhost${r.hostsAceitos.nomes.length ? `, ${r.hostsAceitos.nomes.join(', ')}` : ''}.`);
  out('Alcance pelo aparelho cliente: desconhecido (esta checagem é local e não prova que a TV chega aqui).');
  if (r.candidatos.length) {
    out('Interfaces (+ automática, ~ só por escolha explícita, - excluída):');
    for (const c of r.candidatos) out(`  ${c.usable ? (c.auto ? '+' : '~') : '-'} ${c.address} (${c.interface}, ${c.family}) ${c.reason}`);
  }
  if (r.portaPeers) printPeers(r.portaPeers, out);
  for (const n of r.notas) out(`Nota: ${n}`);
  for (const w of r.avisos) out(`Aviso: ${w}`);
  for (const p of r.problemas) out(`PROBLEMA: ${p}`);
}

function run(argv, { env = process.env, interfaces = network.systemInterfaces(), out = console.log, now = Date.now() } = {}) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'private'));
  const validar = args[0] === 'validar';
  const peers = args[0] === 'peers';
  if ((validar && args.length !== 2) || (peers && args.length !== 1) || (!validar && !peers && args.length)) { out(USO); return 2; }
  // validar simula a escolha com a mesma validação da gravação (estrita), sem gravar nada.
  const useEnv = validar ? { ...env, LAN_ADVERTISE_HOST: args[1], ASCSTREMIO_MODE: 'lan' } : env;
  const snap = settings.resolve({ dataDir, env: useEnv, interfaces, strictNetwork: validar });
  if (peers) {
    const p = peerReport(snap, dataDir, now);
    if (json) out(JSON.stringify(p, null, 2)); else printPeers(p, out);
    return snap.ok ? 0 : 1;
  }
  const r = report(snap, interfaces, validar ? null : dataDir, now);
  if (json) out(JSON.stringify(r, null, 2)); else print(r, out);
  return snap.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exit(run(process.argv.slice(2))); } catch (err) { console.error(`erro: ${err.message}`); process.exit(1); }
}

module.exports = { run, report };
