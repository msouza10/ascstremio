const fs = require('fs');
const http = require('http');
const path = require('path');

const { getRouter } = require('stremio-addon-sdk');
const { createAddon } = require('./addon');
const { loadLibrary, describeEntry } = require('./library');
const { MetaCache } = require('./meta-cache');
const { Bridge } = require('./bridge');
const { AscClient } = require('./asc-client');
const { migrateLegacyFreeleech } = require('./freeleech-migration');
const { startConfig } = require('./config-server');
const { createAscProvider } = require('./asc-provider');
const { readPasskey, DEFAULT_ANNOUNCE_BASE } = require('./passkey');
const { SeedVault } = require('./seedvault');
const crypto = require('crypto');
const { hostAllowed } = require('./safety');
const network = require('./network');
const settings = require('./settings');
const hnr = require('./hnr-guard');
const { CredentialStore, currentCredential, currentToken } = require('./credentials');
const { createAddonHandler } = require('./addon-auth');
const { KeepAwake } = require('./keepawake');
const { logger, initFiles } = require('./logger');
const { acquireInstance }  = require('./instance-lock');
const { createPanelSettings } = require('./panel-settings');
const adminAccess = require('./admin-access');
const { AdminCredential } = require('./admin-auth');
const { AlertManager, configFromValues, OBSERVE_INTERVAL_MS } = require('./alerts');

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

const log = logger.child('app');
logger.echo = true; // falhas de partida também aparecem no terminal/journald

async function main() {
  // Logs primeiro: tudo que vem depois (inclusive os console.* antigos) é gravado,
  // com a passkey e cookies redigidos. Arquivos em private/logs/ (0600).
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* Windows/volume sem chmod */ }
  // Antes de qualquer leitura ou gravação (settings.json, logs, cofre, motor): só um processo
  // por instalação pode escrever o estado (portas diferentes não bastam). Liberada ao sair;
  // ver src/instance-lock.js. Nesta primeira fase só o ambiente é conhecido.
  const envTorrentDir = process.env.ASC_TORRENT_DIR || path.join(DATA_DIR, 'torrents');
  const envStoreDir = process.env.BRIDGE_STORE || path.join(DATA_DIR, 'cache');
  let instance = acquireInstance({ dataDir: DATA_DIR, torrentDir: envTorrentDir, storeDir: envStoreDir });
  process.on('exit', () => instance.release());
  // Configuração central (src/settings.js): ambiente > DATA_DIR/settings.json > padrão.
  // Valor inválido, arquivo corrompido ou combinação insegura recusam a partida.
  const cfg = settings.load({ dataDir: DATA_DIR });
  const v = cfg.values;
  // ASC_TORRENT_DIR/BRIDGE_STORE vindos do settings.json também precisam de trava: se diferem
  // do que o ambiente já travou, refaz a trava com o conjunto final (e confere que o arquivo
  // não mudou nesse intervalo).
  if (v.ASC_TORRENT_DIR !== envTorrentDir || v.BRIDGE_STORE !== envStoreDir) {
    instance.release();
    instance = acquireInstance({ dataDir: DATA_DIR, torrentDir: v.ASC_TORRENT_DIR, storeDir: v.BRIDGE_STORE });
    if (settings.resolve({ dataDir: DATA_DIR }).revision !== cfg.revision) {
      throw new Error('settings.json mudou durante a partida. Inicie de novo.');
    }
  }
  // Leitores antigos (safety, bridge, keepawake) consultam process.env: recebem só o que veio do arquivo.
  // O painel precisa saber o que veio do AMBIENTE de verdade: applyToEnv mistura o arquivo em process.env.
  const bootEnv = { ...process.env };
  settings.applyToEnv(cfg);
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
  // O endereço anunciado é decidido por src/network.js (LAN_ADVERTISE_HOST, LAN_INTERFACE, URLs
  // públicas ou, no modo local, 127.0.0.1); bind e Host aceito são coisas separadas.
  const net = cfg.derived.network;
  for (const info of net.info) log.info(info);
  const publicUrl = net.urls.bridge ?? `http://127.0.0.1:${bridgePort}`;

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
  // Filtro "somente freeleech": fonte única é a configuração (issue #54). Quem tinha escolhido
  // "todos os releases" no login antigo é migrado uma vez para o settings.json.
  const freeleechMigration = await migrateLegacyFreeleech({ client: asc, dataDir: DATA_DIR, env: bootEnv, log });
  if (freeleechMigration.migrated) v.ASC_ONLY_FREELEECH = freeleechMigration.value;
  asc.setOnlyFreeleech(v.ASC_ONLY_FREELEECH);

  const backgroundMode = v.BACKGROUND_COMPLETE;
  const afterSeed = v.AFTER_SEED;
  const idleMinutes = v.BACKGROUND_IDLE_MINUTES;

  log.info('iniciando', {
    node: process.version, pid: process.pid, host, bridgePort, addonPort, configPort, modo: cfg.mode,
    afterSeed, backgroundMode, idleMinutes, keepAwake: v.KEEP_AWAKE,
    reservaDiscoGiB: v.DISK_RESERVE_GIB, reservaDiscoPercent: v.DISK_RESERVE_PERCENT,
    limiteReproducoes: v.PLAYBACK_MAX_SESSIONS, limiteReproducoesPorCredencial: v.PLAYBACK_MAX_PER_CREDENTIAL, retomadasEmParalelo: v.RESUME_CONCURRENCY,
    nivelDeLog: logger.level, uploadLimit, uploadLimitReproducao: v.BRIDGE_STREAM_UPLOAD_LIMIT, passkeyConfigurada: Boolean(passkey),
  });

  // Credenciais de reprodução (token por instalação, só o verificador em disco). A antiga
  // chave única `bridge-key` não vale mais: as URLs antigas passam a dar 403.
  const credentials = new CredentialStore({ file: path.join(DATA_DIR, 'credentials.json') });
  if (fs.existsSync(path.join(DATA_DIR, 'bridge-key'))) {
    log.warn('bridge-key (chave única antiga) é ignorada e pode ser removida; emita uma credencial: npm run credenciais -- criar "Stremio" e reinstale o addon com a URL nova');
  }
  if (!credentials.hasActive()) {
    log.warn('nenhuma credencial de reprodução ativa: o addon recusa tudo. Emita uma: npm run credenciais -- criar "Stremio"');
  }
  const adminKey = loadAccessKey(path.join(DATA_DIR, 'admin-key'));
  logger.addSecret(adminKey);
  const bridge = new Bridge({
    torrentDir, storeDir, port: bridgePort, host, publicUrl, passkey, strictHost: true,
    credentials, adminKey, uploadLimit, announceBase,
    streamUploadLimit: v.BRIDGE_STREAM_UPLOAD_LIMIT, uploadRestoreMs: v.BRIDGE_UPLOAD_RESTORE_SECONDS * 1000, vault,
    backgroundMode, idleMs: idleMinutes * 60 * 1000, afterSeed,
    minFreeBytes: Math.round(v.DISK_RESERVE_GIB * 1024 ** 3), reservePercent: v.DISK_RESERVE_PERCENT,
    maxPlaybacks: v.PLAYBACK_MAX_SESSIONS, maxPlaybacksPerCredential: v.PLAYBACK_MAX_PER_CREDENTIAL,
    playbackGraceMs: v.PLAYBACK_SESSION_GRACE_SECONDS * 1000,
    resumeConcurrency: v.RESUME_CONCURRENCY,
    resumeOnStart: false, // painel e addon sobem primeiro; os torrents retomam em seguida
    keepAwake: new KeepAwake({ mode: v.KEEP_AWAKE }),
    accountNotice: () => asc.inactivityNotice(),
    trackerCheck: (hashes, opts = {}) => hnr.reconcile({ asc, vault, only: hashes, ...opts }),
    retention: {
      mode: v.RETENTION_MODE, budgetBytes: Math.round(v.RETENTION_BUDGET_GIB * 1024 ** 3),
      maxTitles: v.RETENTION_MAX_TITLES, minAgeDays: v.RETENTION_MIN_AGE_DAYS,
    },
  });
  console.log(passkey
    ? '[ponte] passkey carregada em memória (não existe nos .torrent)'
    : '[ponte] sem passkey: torrents privados ficarão sem peers (veja PASSKEY_FILE)');
  await bridge.start();
  // Porta de peers (issue #34): só observa o motor já aberto (escuta e conexões de ENTRADA, em
  // contadores sem endereço). Não abre porta, não abre torrent e não consulta serviço externo.
  const peerObserver = network.createPeerObserver();
  peerObserver.attach(bridge.client);
  const peerPortNow = () => network.evaluatePeerPort({
    engine: network.engineState(bridge.client), observed: peerObserver.snapshot(),
    configuredPort: v.TORRENT_PORT, container: cfg.container,
  });
  const gravaPeers = () => network.writePeerStatus(DATA_DIR, { engine: network.engineState(bridge.client), observed: peerObserver.snapshot() });
  gravaPeers();
  setInterval(gravaPeers, 60_000).unref();
  if (backgroundMode === 'auto') {
    console.log(`[conclusão] automática: freeleech parados há ${idleMinutes} min são concluídos em segundo plano`);
  }

  const library = await loadLibrary(torrentDir);
  console.log(`[addon] ${library.length} título(s) na biblioteca`);

  // Assistente e página de configurações: escrevem no settings.json por este processo, que já
  // detém a trava da instância (não há segundo escritor). LOG_LEVEL vale na hora; o resto, ao reiniciar.
  const alerts = new AlertManager({
    dataDir: DATA_DIR, env: bootEnv, config: configFromValues(v), log: logger.child('alertas'),
    addSecret: (secret) => logger.addSecret(secret), ownPorts: [addonPort, bridgePort, configPort],
  });
  alerts.registerSecrets(); // a URL do destino fica redigida nos logs desde já
  const alertKeys = new Set(['ALERTS_ENABLED', 'ALERT_WEBHOOK_FORMAT', 'ALERT_WEBHOOK_ALLOWED_HOSTS', 'ALERT_WEBHOOK_ALLOW_PRIVATE', 'ALERT_HNR_WITHIN_HOURS', 'ALERT_DISK_FREE_GIB', 'ALERT_TRACKER_FAILURE_MINUTES', 'ALERT_NO_PEERS_MINUTES', 'ALERT_COOLDOWN_MINUTES']);
  const panel = createPanelSettings({
    alertsGuard: (changes) => {
      // Valida com os hosts que valerão após salvar (se vierem na mesma alteração).
      const saved = settings.resolve({ dataDir: DATA_DIR, env: bootEnv }).values;
      const hosts = changes.ALERT_WEBHOOK_ALLOWED_HOSTS ?? saved.ALERT_WEBHOOK_ALLOWED_HOSTS;
      const probe = new AlertManager({ dataDir: DATA_DIR, env: bootEnv, timers: false, config: { ...configFromValues(saved), allowedHosts: String(hosts || '').split(',').map((x) => x.trim()).filter(Boolean) } });
      return probe.configProblem();
    },
    dataDir: DATA_DIR, bootEnv, running: cfg.values, credentials,
    addonBase: net.urls.addon,
    playback: () => bridge.playbackSnapshot(),
    peerPort: peerPortNow,
    addSecret: (secret) => logger.addSecret(secret),
    applyLive: (key, value) => {
      if (key === 'LOG_LEVEL') return logger.setLevel(value);
      if (key === 'ASC_ONLY_FREELEECH') return asc.setOnlyFreeleech(value);
      if (alertKeys.has(key)) { alerts.setConfig({ [key]: value }); return true; }
      return false;
    },
  });
  // Administração do painel pela LAN (opcional, desligada por padrão; issue #24). Falta de
  // pré-condição só desliga a administração remota, nunca impede o motor de retomar o seed.
  const adminCredential = new AdminCredential({ dataDir: DATA_DIR });
  const remoteAdmin = adminAccess.plan({
    values: v, mode: cfg.mode, container: cfg.container, net, credentialConfigured: adminCredential.configured(), port: configPort,
  });
  const config = await startConfig(asc, configPort, {
    snapshot: () => ({ ...bridge.snapshot(), stats: asc.accountStats }),
    complete: (infoHash) => bridge.requestCompletion(infoHash),
    manageSeed: (infoHash, action) => bridge.manageSeed(infoHash, action),
  }, undefined, panel, alerts, { plan: remoteAdmin, credential: adminCredential });
  // Alertas: avaliação a cada minuto sobre o snapshot (leitura pura); a entrega é assíncrona e
  // nunca bloqueia nem derruba o aplicativo.
  setInterval(() => alerts.observe(() => ({ ...bridge.snapshot(), stats: asc.accountStats })), OBSERVE_INTERVAL_MS).unref();
  const metaCache = new MetaCache({ file: path.join(DATA_DIR, 'meta-cache.json') }).load();
  const remote = createAscProvider(asc, bridge, torrentDir, { cache: metaCache });
  // O .torrent de uma fonte só é baixado quando o player pede o vídeo (GET em /a/<id>).
  bridge.ascResolver = (ascId) => remote.resolve(ascId);
  bridge.ascSizeHint = (ascId) => remote.sizeOf(ascId);
  // Catálogo "ASC — status" dentro do Stremio (STATUS_CATALOG=off desliga).
  const addonBase = net.urls.addon ?? `http://127.0.0.1:${addonPort}`;
  const status = v.STATUS_CATALOG === 'off' ? null : {
    snapshot: () => ({ ...bridge.snapshot(), stats: asc.accountStats }),
    // Os cartões saem sob o prefixo da credencial de quem pediu (o Stremio não envia cabeçalhos).
    get posterBase() { return `${addonBase}/${currentToken()}`; },
    panelUrl: `http://127.0.0.1:${configPort}`,
  };
  const addon = createAddon({
    status,
    remote,
    library,
    // Biblioteca atual (inclui o baixado após a partida) com o estado em disco de cada item.
    localEntries: () => [...bridge.entries.values()]
      .map((entry) => { const item = describeEntry(entry); return item && { ...item, disk: bridge.diskState(entry.infoHash) }; })
      .filter(Boolean),
    bridgeUrl: (infoHash, fileIdx) => bridge.urlFor(infoHash, fileIdx),
    demo: v.DEMO_MODE,
    statusAllowed: () => currentCredential()?.status === true,
  });

  // serveHTTP do SDK escuta em todas as interfaces e não aceita host: monta o
  // roteador do SDK num servidor próprio, preso ao mesmo host da ponte.
  const router = getRouter(addon);
  const handleAddon = createAddonHandler({ addon, router, store: credentials, status });
  // Anti DNS rebinding: só IP literal/localhost/hosts autorizados (ver safety.hostAllowed).
  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) { res.writeHead(403); res.end(); return; }
    handleAddon(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(addonPort, host, resolve);
  });
  console.log(`[addon] instale pela URL emitida: ${addonBase}/<credencial>/manifest.json (npm run credenciais; diagnóstico: npm run rede)`);
  console.log(`[config] login em http://127.0.0.1:${configPort}/`);
  console.log(`[ponte] stream em ${publicUrl}/s/<infoHash>/<fileIdx>?k=<credencial>`);

  // Modo LAN: se o endereço anunciado sumir (interface caiu, DHCP trocou o IP), avisa uma vez
  // por mudança. Não altera URLs já entregues nem presume o que o Stremio guardou.
  if (cfg.mode === 'lan') {
    let avisado = null;
    const vigiaRede = () => {
      const aviso = network.staleWarning(net);
      if (aviso && aviso !== avisado) log.warn(aviso);
      if (!aviso && avisado) log.info('endereço anunciado voltou a existir neste computador');
      avisado = aviso;
    };
    vigiaRede();
    setInterval(vigiaRede, 300_000).unref();
  }

  // Anti-HnR: concilia o cofre com o myHistory do tracker (ele vence), retoma
  // obrigações reveladas por ele e avisa de prazo/torrent inativo.
  let hnrRetry = null;
  const vigiaHnr = async () => {
    let leu = false;
    let trackerFalhou = false;
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
      trackerFalhou = Boolean(r.failed);
      if (r.checked || r.failed) {
        console.log(`[hnr] tracker conferido: ${r.checked} torrent(s), ${r.ajustados} ajuste(s), ${r.failed ? 'FALHA de acesso (sessão?)' : 'ok'}`);
      }
      await bridge.releaseSatisfied();
      bridge.keepAwake?.update(bridge.needsAwake());
      await bridge.resumePending();
    } catch (err) {
      trackerFalhou = true;
      console.error(`[hnr] falha na conciliação com o tracker: ${err?.message ?? err}`);
    }
    alerts.trackerResult(leu && !trackerFalhou);
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
