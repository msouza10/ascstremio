#!/usr/bin/env node
// Administração do painel pela LAN no terminal do host (issue #24): senha de administração,
// revogação de sessões, ativação e desativação. É o caminho de recuperação local: não depende
// da conta do ASC, do painel nem de rede.
//
//   npm run admin-painel -- status [--json]
//   npm run admin-painel -- definir [--trocar] [--senha-arquivo ARQ]   (pergunta sem eco; nunca por argumento)
//   npm run admin-painel -- gerar [--trocar]                           (cria uma senha aleatória e a mostra UMA vez)
//   npm run admin-painel -- revogar-sessoes                            (derruba todas as sessões abertas, na hora)
//   npm run admin-painel -- remover                                    (apaga a senha: o acesso remoto fecha, na hora)
//   npm run admin-painel -- ativar [--https URL | --http-claro] [--ip IPV4] [--sim]
//   npm run admin-painel -- desativar [--sim]
//
// definir/gerar/revogar-sessoes/remover funcionam com o aplicativo ligado (o servidor relê o
// arquivo). ativar/desativar mexem na configuração e exigem o aplicativo parado (trava da instância)
// e reinício. Códigos de saída: 0 ok; 1 recusado; 2 uso incorreto; 3 aplicativo em execução.

const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');
const settings = require('./settings');
const configAdmin = require('./config-admin');
const auth = require('./admin-auth');
const access = require('./admin-access');

const USO = `uso: admin-painel <comando>
  status [--json]                           situação da administração pela LAN (nunca mostra a senha)
  definir [--trocar] [--senha-arquivo ARQ]  define a senha de administração (pergunta sem eco)
  gerar [--trocar]                          gera uma senha aleatória e a mostra uma única vez
  revogar-sessoes                           encerra todas as sessões abertas
  remover                                   apaga a senha e fecha o acesso remoto
  ativar [--https URL | --http-claro] [--ip IPV4] [--sim]   habilita (aplicativo parado)
  desativar [--sim]                         desabilita (aplicativo parado)
A senha nunca vai por argumento. Não é a senha do ASC.`;

const EXIT = { ok: 0, fail: 1, usage: 2, instance: 3 };

function parseArgs(args) {
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (['https', 'senha-arquivo', 'ip'].includes(key)) { flags[key] = args[i + 1]; i += 1; } else flags[key] = true;
  }
  return { flags, pos };
}

// Leitura sem eco no terminal.
function secretFromTty(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const write = rl._writeToOutput;
    rl._writeToOutput = (text) => { if (!muted) write.call(rl, text); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

const defaultIo = () => ({
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  secret: secretFromTty,
  confirm: (prompt) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim().toLowerCase() === 'sim'); });
  }),
});

function describe(env, { interfaces } = {}) {
  const ctx = configAdmin.context({ env });
  const snap = settings.resolve({ dataDir: ctx.dataDir, env: ctx.env, interfaces });
  const credential = new auth.AdminCredential({ dataDir: ctx.dataDir });
  const plan = access.plan({
    values: snap.values, mode: snap.mode, container: snap.container, net: snap.derived.network,
    credentialConfigured: credential.configured(), interfaces: interfaces ?? null, port: snap.values.CONFIG_PORT,
  });
  return { ctx, snap, credential, plan };
}

async function chooseNewPassword(io, flags) {
  if (flags['senha-arquivo']) {
    let text;
    try { text = fs.readFileSync(flags['senha-arquivo'], 'utf8'); } catch { throw new auth.AdminAuthError('io', 'não foi possível ler o arquivo de senha.'); }
    return text.replace(/\r?\n$/, '');
  }
  if (!io.tty) throw new auth.AdminAuthError('usage', 'sem terminal: use --senha-arquivo ARQUIVO (o arquivo deve ter permissão restrita) ou rode em um terminal.');
  const a = await io.secret('Nova senha de administração (mín. 12 caracteres, não é a do ASC): ');
  const b = await io.secret('Repita a senha: ');
  if (a !== b) throw new auth.AdminAuthError('mismatch', 'as senhas não coincidem; nada foi alterado.');
  return a;
}

async function setPassword(ctx, password, { replace }) {
  const record = await auth.buildRecord(password);
  const exists = fs.existsSync(auth.filePath(ctx.dataDir));
  if (exists && !replace) throw new auth.AdminAuthError('exists', 'já existe uma senha de administração. Para trocar, use --trocar (as sessões abertas são encerradas); para apagar, "remover".');
  auth.writeRecord(ctx.dataDir, record, { exclusive: !exists });
}

async function run(args, { env = process.env, io = defaultIo(), interfaces } = {}) {
  const { flags, pos } = parseArgs(args);
  const cmd = pos[0];
  const json = Boolean(flags.json);
  try {
    if (cmd === 'status') {
      const d = describe(env, { interfaces });
      const out = {
        requested: d.plan.requested, enabled: d.plan.enabled && d.credential.configured(), passwordDefined: d.credential.configured(),
        transport: d.plan.transport, hosts: d.plan.hosts, bind: d.plan.bind, problems: d.plan.problems,
      };
      if (json) { io.out(JSON.stringify(out)); return EXIT.ok; }
      io.out(`Administração pela LAN: ${out.enabled ? 'ATIVA' : 'desligada'}${out.requested && !out.enabled ? ' (pedida, mas recusada)' : ''}`);
      io.out(`Senha de administração: ${out.passwordDefined ? 'definida' : 'não definida'}`);
      if (out.requested) {
        io.out(`Transporte: ${out.transport === 'https-proxy' ? 'HTTPS por proxy reverso no próprio computador' : 'HTTP em claro na LAN'}`);
        if (out.hosts.length) io.out(`Host aceito: ${out.hosts.join(', ')} (e 127.0.0.1:${d.snap.values.CONFIG_PORT}, também com senha)`);
        for (const p of out.problems) io.out(`  pendência: ${p}`);
      }
      return EXIT.ok;
    }
    if (cmd === 'definir' || cmd === 'gerar') {
      const ctx = configAdmin.context({ env });
      const password = cmd === 'gerar' ? crypto.randomBytes(18).toString('base64url') : await chooseNewPassword(io, flags);
      await setPassword(ctx, password, { replace: Boolean(flags.trocar) });
      if (cmd === 'gerar') {
        io.out('Senha de administração gerada (anote agora; ela não é guardada em lugar nenhum e não será mostrada de novo):');
        io.out(password);
      } else io.out('Senha de administração definida.');
      io.out(flags.trocar ? 'Sessões anteriores foram encerradas.' : 'Para usar o painel pela LAN ainda é preciso "ativar".');
      return EXIT.ok;
    }
    if (cmd === 'revogar-sessoes') {
      const ctx = configAdmin.context({ env });
      const c = new auth.AdminCredential({ dataDir: ctx.dataDir });
      const rec = c.load();
      if (!rec) { io.err('Não há senha de administração válida; nenhuma sessão pode estar aberta.'); return EXIT.fail; }
      auth.writeRecord(ctx.dataDir, { ...rec, generation: crypto.randomBytes(8).toString('hex'), updatedAt: new Date().toISOString() });
      io.out('Todas as sessões de administração foram encerradas (valem na hora, sem reiniciar).');
      return EXIT.ok;
    }
    if (cmd === 'remover') {
      const ctx = configAdmin.context({ env });
      const removed = auth.removeRecord(ctx.dataDir);
      io.out(removed ? 'Senha de administração apagada: o acesso remoto está fechado e as sessões caíram. O painel local segue normalmente.' : 'Não havia senha de administração.');
      return EXIT.ok;
    }
    if (cmd === 'ativar') {
      const d = describe(env, { interfaces });
      if (flags.https && flags['http-claro']) { io.err('Escolha --https URL ou --http-claro, não os dois.'); return EXIT.usage; }
      if (!flags.https && !flags['http-claro']) { io.err('Informe o transporte: --https https://painel.casa.lan (proxy reverso neste computador) ou --http-claro (aceita HTTP sem criptografia na LAN).'); return EXIT.usage; }
      const changes = { CONFIG_ALLOW_LAN: true };
      if (flags.https) { changes.CONFIG_PUBLIC_URL = String(flags.https); changes.CONFIG_ADMIN_HTTP_CLEAR = null; }
      else { changes.CONFIG_ADMIN_HTTP_CLEAR = true; changes.CONFIG_PUBLIC_URL = null; }
      if (flags.ip) changes.CONFIG_BIND_ADDRESS = String(flags.ip);
      // Confere as pré-condições com os valores propostos ANTES de gravar.
      const proposed = { ...d.snap.values };
      for (const [k, v] of Object.entries(changes)) proposed[k] = v;
      const pre = access.plan({ values: proposed, mode: d.snap.mode, container: d.snap.container, net: d.snap.derived.network, credentialConfigured: d.credential.configured(), interfaces: interfaces ?? null, port: proposed.CONFIG_PORT });
      if (!pre.enabled) {
        io.err('Não é possível ativar ainda:');
        for (const p of pre.problems) io.err(`  - ${p}`);
        return EXIT.fail;
      }
      io.out('O que muda ao ativar:');
      io.out(`  - o painel passa a escutar também em ${pre.bind.filter((a) => a !== '127.0.0.1').join(', ') || '127.0.0.1 (atrás do seu proxy)'}, porta ${proposed.CONFIG_PORT}`);
      io.out(`  - Host aceito: ${pre.hosts.join(', ')} (sem curinga)`);
      io.out('  - TODAS as rotas do painel, inclusive em 127.0.0.1, passam a exigir a senha de administração');
      io.out('  - a ponte e as rotas administrativas (credenciais, /credentials, token admin) continuam inacessíveis por esse caminho');
      io.out(pre.transport === 'http-clear'
        ? '  - RISCO: HTTP sem criptografia; quem observa a rede local lê a senha e a sessão. Use só em rede doméstica confiável.'
        : '  - o cookie de sessão é Secure; o proxy deve repassar o Host original e terminar o HTTPS');
      if (!flags.sim) {
        if (!io.tty) { io.err('Confirmação necessária: rode com --sim (sem terminal não há como perguntar).'); return EXIT.usage; }
        if (!await io.confirm('Digite "sim" para ativar: ')) { io.out('Cancelado; nada foi alterado.'); return EXIT.ok; }
      }
      configAdmin.change({ env, changes });
      io.out('Ativado na configuração. Reinicie o aplicativo para valer.');
      return EXIT.ok;
    }
    if (cmd === 'desativar') {
      const d = describe(env, { interfaces });
      if (d.snap.sources.CONFIG_ALLOW_LAN === 'env') { io.err('CONFIG_ALLOW_LAN vem do ambiente (service.env/Compose): remova-a de lá. Para fechar já, use "remover" (apaga a senha).'); return EXIT.fail; }
      if (!flags.sim && io.tty && !await io.confirm('Digite "sim" para desativar a administração pela LAN: ')) { io.out('Cancelado; nada foi alterado.'); return EXIT.ok; }
      if (!flags.sim && !io.tty) { io.err('Confirmação necessária: rode com --sim.'); return EXIT.usage; }
      configAdmin.change({ env, changes: { CONFIG_ALLOW_LAN: null } });
      io.out('Desativado na configuração. Reinicie o aplicativo para valer (a senha continua guardada; "remover" a apaga).');
      return EXIT.ok;
    }
  } catch (err) {
    if (err instanceof auth.AdminAuthError) { io.err(`erro: ${err.message}`); return err.code === 'usage' ? EXIT.usage : EXIT.fail; }
    if (err instanceof configAdmin.AdminError) { io.err(`erro: ${err.message}`); return err.code === 'instance' ? EXIT.instance : EXIT.fail; }
    if (err instanceof settings.SettingsError) { io.err(`erro: ${err.problems.join(' ')}`); return EXIT.fail; }
    throw err;
  }
  io.err(USO);
  return EXIT.usage;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`erro: ${err.message}`); process.exit(1); });
}

module.exports = { run, USO, EXIT };
