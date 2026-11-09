const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { getRouter } = require('stremio-addon-sdk');
const { createAddon } = require('./addon');
const { loadLibrary } = require('./library');
const { Bridge } = require('./bridge');
const { AscClient } = require('./asc-client');
const { startConfig } = require('./config-server');
const { createAscProvider } = require('./asc-provider');
const { readPasskey, DEFAULT_ANNOUNCE_BASE } = require('./passkey');
const { SeedVault } = require('./seedvault');
const crypto = require('crypto');
const { inContainer, hostAllowed } = require('./safety');
const settings = require('./settings');
const hnr = require('./hnr-guard');
const { posterRoute } = require('./stremio-status');
const { KeepAwake } = require('./keepawake');
const { logger, initFiles } = require('./logger');

// Onde ficam passkey, sessão, cofre, logs, .torrent e cache. Fora do código para
// sobreviver a atualizações (instalador, contêiner, Windows em %LOCALAPPDATA%).
const DATA_DIR = settings.resolveDataDir(process.env);

// Chave das URLs de stream: aleatória, guardada em DATA_DIR (0600) para sobreviver a reinícios.
function loadAccessKey(file) {
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(saved)) return saved;
  } catch { /* primeira execução */ }
  const key = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

// Endereço que o Stremio deve usar para chegar aqui. No contêiner o IP interno não
// serve: a porta é publicada no 127.0.0.1 da máquina.
function advertisedHost(host) {
  return host === '127.0.0.1' || inContainer() ? '127.0.0.1' : lanAddress();
}

function lanAddress() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const net of interfaces ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

const log = logger.child('app');
logger.echo = true; // falhas de partida também aparecem no terminal/journald

async function main() {
  // Logs primeiro: tudo que vem depois (inclusive os console.* antigos) é gravado,
  // com a passkey e cookies redigidos. Arquivos em private/logs/ (0600).
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* Windows/volume sem chmod */ }
  // Configuração central (src/settings.js): ambiente > DATA_DIR/settings.json > padrão.
  // Valor inválido, arquivo corrompido ou combinação insegura recusam a partida.
  const cfg = settings.load({ dataDir: DATA_DIR });
  // Leitores antigos (safety, bridge, keepawake) consultam process.env: recebem só o que veio do arquivo.
  settings.applyToEnv(cfg);
  const v = cfg.values;
  logger.setLevel(v.LOG_LEVEL);
  initFiles(path.join(DATA_DIR, 'logs'), { retentionDays: v.LOG_RETENTION_DAYS });
  logger.captureConsole();
  process.on('uncaughtException', (err) => { log.error('exceção não tratada: encerrando', { stack: err?.stack ?? String(err) }); process.exit(1); });
  process.on('unhandledRejection', (reason) => { log.error('promessa rejeitada sem tratamento: encerrando', { motivo: reason?.stack ?? String(reason) }); process.exit(1); });
  for (const aviso of cfg.warnings) log.warn(aviso);

  const torrentDir = v.ASC_TORRENT_DIR;
  const storeDir = v.BRIDGE_STORE;
  const bridgePort = v.BRIDGE_PORT;
  const addonPort = v.PORT;
  const configPort = v.CONFIG_PORT;

  // A URL precisa ser alcançável pelo aparelho onde o Stremio roda: em TV ou
  // celular, 127.0.0.1 aponta para o próprio aparelho, não para este host.
  // Por padrão a ponte só escuta em loopback (conta pessoal, regra 2.2 do ASC).
  // BRIDGE_ALLOW_LAN=1 libera a rede local, por sua conta e risco.
  const host = cfg.derived.bindHost;
  const publicUrl = v.BRIDGE_PUBLIC_URL
    || `http://${advertisedHost(host)}:${bridgePort}`;

  // A passkey não fica nos .torrent: vem de PASSKEY_FILE (0600) ou PASSKEY.
  const passkey = readPasskey({ file: path.join(DATA_DIR, 'passkey.txt') });
  const uploadLimit = v.BRIDGE_UPLOAD_LIMIT;

  // ANNOUNCE_BASE pode carregar credencial: só vem do ambiente, nunca do arquivo.
  const announceBase = process.env.ANNOUNCE_BASE || DEFAULT_ANNOUNCE_BASE;
  logger.addSecret(passkey);

  // Cofre persistente: se o processo cair no meio das 72 h, a contagem não zera.
  const vault = new SeedVault({
    file: path.join(DATA_DIR, 'seed-vault.json'),
    requiredHours: v.SEED_REQUIRED_HOURS,
  });
  const resumo = vault.summary();
  if (resumo.pendentes > 0) {
    console.log(`[vault] ${resumo.pendentes} seed(s) pendente(s), ${resumo.horasPendentes} h no total`);
  }

  const asc = new AscClient({ stateFile: path.join(DATA_DIR, 'asc-session.json') });
  await asc.load();

  const backgroundMode = v.BACKGROUND_COMPLETE;
  const afterSeed = v.AFTER_SEED;
  const idleMinutes = v.BACKGROUND_IDLE_MINUTES;

  log.info('iniciando', {
    node: process.version, pid: process.pid, host, bridgePort, addonPort, configPort, modo: cfg.mode,
    afterSeed, backgroundMode, idleMinutes, keepAwake: v.KEEP_AWAKE,
    nivelDeLog: logger.level, uploadLimit, passkeyConfigurada: Boolean(passkey),
  });

  const accessKey = loadAccessKey(path.join(DATA_DIR, 'bridge-key'));
  logger.addSecret(accessKey);
  const adminKey = loadAccessKey(path.join(DATA_DIR, 'admin-key'));
  logger.addSecret(adminKey);
  const bridge = new Bridge({
    torrentDir, storeDir, port: bridgePort, host, publicUrl, passkey, strictHost: true,
    accessKey, adminKey, uploadLimit, announceBase, vault,
    backgroundMode, idleMs: idleMinutes * 60 * 1000, afterSeed,
    resumeOnStart: false, // painel e addon sobem primeiro; os torrents retomam em seguida
    keepAwake: new KeepAwake({ mode: v.KEEP_AWAKE }),
    accountNotice: () => asc.inactivityNotice(),
    trackerCheck: (hashes) => hnr.reconcile({ asc, vault, only: hashes }),
  });
  console.log(passkey
    ? '[ponte] passkey carregada em memória (não existe nos .torrent)'
    : '[ponte] sem passkey: torrents privados ficarão sem peers (veja PASSKEY_FILE)');
  await bridge.start();
  if (backgroundMode === 'auto') {
    console.log(`[conclusão] automática: freeleech parados há ${idleMinutes} min são concluídos em segundo plano`);
  }

  const library = await loadLibrary(torrentDir);
  console.log(`[addon] ${library.length} título(s) na biblioteca`);

  const config = await startConfig(asc, configPort, {
    snapshot: () => ({ ...bridge.snapshot(), stats: asc.accountStats }),
    complete: (infoHash) => bridge.requestCompletion(infoHash),
  });
  const remote = createAscProvider(asc, bridge, torrentDir);
  // O .torrent de uma fonte só é baixado quando o player pede o vídeo (GET em /a/<id>).
  bridge.ascResolver = (ascId) => remote.resolve(ascId);
  // Catálogo "ASC — status" dentro do Stremio (STATUS_CATALOG=off desliga).
  const addonBase = v.ADDON_PUBLIC_URL || `http://${advertisedHost(host)}:${addonPort}`;
  const status = v.STATUS_CATALOG === 'off' ? null : {
    snapshot: () => ({ ...bridge.snapshot(), stats: asc.accountStats }),
    posterBase: addonBase,
    panelUrl: `http://127.0.0.1:${configPort}`,
  };
  const addon = createAddon({
    status,
    remote,
    library,
    bridgeUrl: (infoHash, fileIdx) => bridge.urlFor(infoHash, fileIdx),
    demo: v.DEMO_MODE,
  });

  // serveHTTP do SDK escuta em todas as interfaces e não aceita host: monta o
  // roteador do SDK num servidor próprio, preso ao mesmo host da ponte.
  const router = getRouter(addon);
  const handleAddon = (req, res) => (status && posterRoute(req, res, status.snapshot, status.panelUrl)) || router(req, res, () => {
    res.writeHead(404);
    res.end();
  });
  // Anti DNS rebinding: só IP literal/localhost/hosts autorizados (ver safety.hostAllowed).
  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) { res.writeHead(403); res.end(); return; }
    handleAddon(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(addonPort, host, resolve);
  });
  console.log(`[addon] instale em http://${advertisedHost(host)}:${addonPort}/manifest.json`);
  console.log(`[config] login em http://127.0.0.1:${configPort}/`);
  console.log(`[ponte] stream em ${publicUrl}/s/<infoHash>/<fileIdx>`);

  // Anti-HnR: concilia o cofre com o myHistory do tracker (ele vence), retoma
  // obrigações reveladas por ele e avisa de prazo/torrent inativo.
  let hnrRetry = null;
  const vigiaHnr = async () => {
    let leu = false;
    try {
      // O que o tracker já cobra (inclusive de antes do cofre existir).
      const act = await hnr.syncActivity({ asc, vault, entries: bridge.entries });
      bridge.setActivity(act);
      leu = true;
      if (act.adopted) console.log(`[hnr] ${act.adopted} obrigação(ões) do tracker adotada(s) no cofre`);
      for (const p of act.pending) {
        const h = p.snapshot.remainingMs === null ? '?' : (p.snapshot.remainingMs / 3_600_000).toFixed(1);
        console.log(`[hnr] tracker cobra seed: "${p.name.slice(0, 50)}" faltam ${h} h`
          + `${p.snapshot.deadlineMs ? `, prazo ${new Date(p.snapshot.deadlineMs).toISOString().slice(0, 16)}Z` : ''}`
          + `${p.local ? '' : ' (SEM .torrent local)'}`);
      }
    } catch (err) {
      console.error(`[hnr] não foi possível ler /atividade: ${err?.message ?? err}`);
    }
    try {
      const r = await hnr.reconcile({ asc, vault });
      if (r.checked || r.failed) {
        console.log(`[hnr] tracker conferido: ${r.checked} torrent(s), ${r.ajustados} ajuste(s), ${r.failed ? 'FALHA de acesso (sessão?)' : 'ok'}`);
      }
      await bridge.releaseSatisfied();
      bridge.keepAwake?.update(bridge.needsAwake());
      await bridge.resumePending();
    } catch (err) {
      console.error(`[hnr] falha na conciliação com o tracker: ${err?.message ?? err}`);
    }
    for (const aviso of bridge.hnrWarnings()) console.warn(`[hnr] ${aviso}`);
    // Sem rede na partida (boot, Wi-Fi subindo): tenta de novo logo, em vez de esperar 1 h.
    clearTimeout(hnrRetry);
    if (!leu) {
      hnrAttempts = Math.min(hnrAttempts + 1, 6);
      const espera = Math.min(15_000 * 2 ** (hnrAttempts - 1), 300_000);
      console.warn(`[hnr] nova tentativa em ${Math.round(espera / 1000)} s`);
      hnrRetry = setTimeout(vigiaHnr, espera);
      hnrRetry.unref();
    } else hnrAttempts = 0;
  };
  let hnrAttempts = 0;
  vigiaHnr();
  setInterval(vigiaHnr, 3_600_000).unref();

  // Regra 2.6: seed headless não conta como acesso ao site. Lembra no log.
  const lembrete = () => {
    const aviso = asc.inactivityNotice();
    if (aviso) console.warn(`[conta] ${aviso}`);
  };
  lembrete();
  setInterval(lembrete, 24 * 3_600_000).unref();

  // Retoma o seed pendente sem segurar o painel (a verificação de dezenas de GB demora).
  bridge.resumePending().catch((err) => console.error(`[vault] falha ao retomar seeds pendentes: ${err?.message ?? err}`));

  const shutdown = async () => {
    const pendentes = vault.list().filter((e) => e.completedAt && !e.satisfiedAt);
    if (pendentes.length > 0) {
      console.log(`[vault] ${pendentes.length} seed(s) pendente(s): o prazo de 12 dias` +
        ' continua correndo; na próxima execução a ponte retoma automaticamente');
    }
    console.log('\n[app] encerrando…');
    server.close?.();
    config.close();
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error(`falhou ao iniciar: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
