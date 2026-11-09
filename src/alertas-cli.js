#!/usr/bin/env node
// Alertas por webhook pelo terminal (issue #31).
//   npm run alertas -- estado [--json]
//   npm run alertas -- definir        (lê a URL e o token opcional da entrada; nunca por argumento)
//   npm run alertas -- remover
//   npm run alertas -- testar         (envia UMA mensagem sintética ao destino salvo)
//   npm run alertas -- ativar | desativar   (liga/desliga ALERTS_ENABLED; vale ao reiniciar)
// A URL é segredo: não aparece em argumentos, saída nem logs. Ativar/desativar altera o
// settings.json (mesma validação de npm run configurar).

const readline = require('readline');
const settings = require('./settings');
const alerts = require('./alerts');

const USO = 'uso: alertas estado [--json] | definir | remover | testar | ativar | desativar';

function ask(rl, q) { return new Promise((resolve) => rl.question(q, resolve)); }

async function main(argv, env = process.env, out = console.log) {
  const [cmd, ...rest] = argv;
  const dataDir = settings.resolveDataDir(env);
  const snap = settings.resolve({ dataDir, env });
  const mgr = new alerts.AlertManager({ dataDir, env, config: alerts.configFromValues(snap.values), timers: false });
  switch (cmd) {
    case 'estado': {
      const st = mgr.status();
      if (rest.includes('--json')) out(JSON.stringify(st, null, 2));
      else {
        out(`habilitado: ${st.enabled ? 'sim' : 'não'}; destino: ${st.configured ? `configurado (${st.source}${st.host ? `, host ${st.host}` : ''})` : 'não configurado'}`);
        if (st.problem) out(`problema: ${st.problem}`);
        out(`último envio: ${st.lastSuccessAt ?? 'nunca'}; último erro: ${st.lastError ?? 'nenhum'}`);
      }
      return 0;
    }
    case 'definir': {
      if (!process.stdin.isTTY) { out('Execute em um terminal interativo (a URL não vai por argumento).'); return 2; }
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const url = (await ask(rl, 'URL do destino: ')).trim();
      const bearer = (await ask(rl, 'Token bearer (opcional): ')).trim();
      rl.close();
      const r = mgr.setDestination({ url, bearerToken: bearer || null });
      out(r.ok ? 'Destino salvo (0600). Use "testar" para conferir.' : r.error);
      return r.ok ? 0 : 1;
    }
    case 'remover': {
      // Desabilita antes (habilitado sem destino impediria a próxima partida).
      try { settings.update({ dataDir, env, changes: { ALERTS_ENABLED: null }, expectedRevision: snap.revision }); } catch { /* ambiente define o valor */ }
      mgr.cfg.enabled = settings.resolve({ dataDir, env }).values.ALERTS_ENABLED === true;
      const r = mgr.removeDestination();
      if (!r.ok) { out(r.error); return 1; }
      out('Destino removido; os alertas ficaram desabilitados.');
      return 0;
    }
    case 'testar': {
      mgr.cfg.enabled = true; // o teste valida o destino mesmo com os alertas desligados
      const r = await mgr.test();
      out(r.ok ? 'Mensagem de teste entregue.' : `Falhou: ${r.error}`);
      return r.ok ? 0 : 1;
    }
    case 'ativar':
    case 'desativar': {
      try {
        const on = cmd === 'ativar';
        settings.update({ dataDir, env, changes: { ALERTS_ENABLED: on }, expectedRevision: snap.revision });
        out(on ? 'Alertas habilitados (valem ao reiniciar).' : 'Alertas desabilitados.');
        return 0;
      } catch (err) { out(err.problems?.[0] ?? err.message); return 1; }
    }
    default:
      out(USO);
      return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
module.exports = { main };
