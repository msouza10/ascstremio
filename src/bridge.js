// Ponte de streaming: carrega o .torrent REAL do ASC, anuncia só no tracker do
// site (sem DHT/PEX/LSD) e serve o arquivo por HTTP com Range, baixando apenas
// as peças do trecho pedido.
//
// É o que o motor do Stremio não faz: ele só aceita o equivalente a um magnet
// (info hash) e injeta DHT, o que quebra torrent com a flag `private`.

const fs = require('fs');
const http = require('http');
const path = require('path');

const { loadLibrary, mainVideo } = require('./library');
const { announceWithPasskey } = require('./passkey');
const { SeedVault } = require('./seedvault');
const { isLoopbackRequest, inContainer, hostAllowed } = require('./safety');
const { timingSafeEqual } = require('crypto');
const { currentToken } = require('./credentials');
const hnr = require('./hnr-guard');
const { DiskGuard, DEFAULT_RESERVE_BYTES } = require('./disk-policy');
const { UploadPolicy } = require('./upload-policy');
const { PlaybackLimiter, DEFAULT_GRACE_MS } = require('./play-limit');
const { Retention } = require('./retention-service');
const { manageSeed } = require('./seed-actions');
const { logger } = require('./logger');
const { rankPending, runLimited } = require('./resume-policy');
const { StreamMetrics } = require('./stream-metrics');
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const log = logger.child('ponte');
const tlog = logger.child('torrent');
const short = (hash) => `${String(hash).slice(0, 8)}…`;

let webTorrentModule;
function loadWebTorrent() {
  webTorrentModule ??= import('webtorrent').then((m) => m.default ?? m);
  return webTorrentModule;
}

const MIME = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.mov': 'video/quicktime',
};

function mimeFor(filePath) {
  return MIME[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

// Aceita "bytes=0-1023", "bytes=1000-" e "bytes=-500" (sufixo).
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return { invalid: true };

  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (end > size - 1) end = size - 1;
  }

  if (start < 0 || start > end || start >= size) return { invalid: true };
  return { start, end };
}

class Bridge {
  constructor({
    torrentDir,
    storeDir,
    port = 7010,
    host = '127.0.0.1',
    publicUrl = null,
    adminKey = null, // credencial das rotas administrativas (cabeçalho X-Admin-Token); sem ela elas recusam tudo
    credentials = null, // CredentialStore: token de instalação nas URLs de stream (?k=); sem ele /s e /a recusam tudo
    strictHost = false, // recusa Host que não seja IP/localhost (anti DNS rebinding)
    firstByteTimeoutMs = 60000,
    passkey = null,
    uploadLimit = -1,
    streamUploadLimit = -1, // teto de upload durante reprodução (BRIDGE_STREAM_UPLOAD_LIMIT); -1 = não reduz
    uploadRestoreMs = 15_000, // espera sem reprodução antes de voltar ao teto normal
    announceBase = null,
    vault = null,
    accountNotice = null,
    trackerCheck = null,
    backgroundMode = 'off',
    idleMs = 10 * 60 * 1000,
    minFreeBytes = DEFAULT_RESERVE_BYTES, // reserva absoluta de disco (DISK_RESERVE_GIB)
    reservePercent = 0, // reserva em % do volume (DISK_RESERVE_PERCENT); vale a maior das duas
    maxPlaybacks = 0, // reproduções lógicas simultâneas no total (PLAYBACK_MAX_SESSIONS); 0 = sem limite
    maxPlaybacksPerCredential = 0, // idem por credencial (PLAYBACK_MAX_PER_CREDENTIAL); 0 = sem limite
    playbackGraceMs = DEFAULT_GRACE_MS, // inatividade que encerra uma sessão de reprodução
    clock = Date.now, // relógio da quota (injetável nos testes)
    freeSpace = null, // injeção para testes: (dir) => livres | { free, total }
    afterSeed = 'delete',
    retention = null, // { mode, budgetBytes, maxTitles, minAgeDays } (RETENTION_*); sem isto, desligada
    keepAwake = null,
    resumeOnStart = true,
    resumeConcurrency = 1, // retomadas abertas ao mesmo tempo (RESUME_CONCURRENCY); 1 = uma por vez, como sempre foi
    monotonic = () => performance.now(), // relógio monotônico da medição de retomada (injetável nos testes)
    streamMetrics = {}, // ajustes da medição de stalls/seeks (stallMs, seekBytes; injetável nos testes)
    ascResolver = null,
    ascSizeHint = null, // (ascId) => bytes da listagem, para reservar espaço antes de baixar o .torrent
  }) {
    this.torrentDir = torrentDir;
    this.storeDir = storeDir;
    this.port = port;
    // Só loopback por padrão: a conta é pessoal (regra 2.2 do ASC).
    this.host = host;
    // Função opcional que devolve avisos da conta (ex.: inatividade, regra 2.6).
    this.accountNotice = accountNotice;
    // Função opcional `async (infoHashes) => void` que concilia o cofre com o
    // tracker (myHistory). Usada antes de liberar /cleanup.
    this.trackerCheck = trackerCheck;
    // Conclusão em segundo plano (§4.5 de docs/conformidade-regras.md):
    //  off  = só conclui quando o usuário pede (POST /complete);
    //  auto = conclui sozinho os freeleech que ficaram parados por `idleMs`.
    this.backgroundMode = backgroundMode;
    this.idleMs = idleMs;
    this.minFreeBytes = minFreeBytes;
    this.reservePercent = reservePercent;
    // Política única de disco para streaming, conclusão e retomada (src/disk-policy.js).
    this.disk = new DiskGuard({ dir: storeDir, reserveBytes: minFreeBytes, reservePercent, measure: freeSpace });
    // O que fazer quando o limite (72 h ou ratio 1.0) é cumprido e o tracker
    // confirma: delete = encerra e apaga os dados; stop = encerra e mantém os
    // dados; keep = continua semeando.
    this.afterSeed = afterSeed;
    // Retenção por orçamento (issue #27): desligada por padrão; ver src/retention-service.js.
    this.retention = new Retention(this, retention ?? {});
    // Opcional: objeto com update(boolean) que impede a suspensão do PC.
    this.keepAwake = keepAwake;
    // false = start() não espera os torrents pendentes abrirem (quem chama faz
    // resumePending() depois); a verificação de dezenas de GB atrasaria o painel.
    this.resumeOnStart = resumeOnStart;
    this.resumeConcurrency = Math.max(1, Math.floor(resumeConcurrency) || 1);
    this.monotonic = monotonic;
    // Só observa a reprodução (issue #33): não altera leitura antecipada, buffer nem timeouts.
    this.metrics = new StreamMetrics({ now: monotonic, log, ...streamMetrics });
    this.clock = clock;
    this.resumeRun = null; // retomada em andamento: chamadas concorrentes se juntam a ela
    this.resumeAgain = false;
    this.resumeStats = null;
    // `async (ascId) => ({ infoHash, fileIdx })`: baixa o .torrent do release SÓ no
    // momento do play (GET em /a/<id>) e o registra na biblioteca. Vem do provedor ASC.
    this.ascResolver = ascResolver;
    this.ascSizeHint = ascSizeHint;
    this.streams = new Map(); // infoHash -> streams HTTP abertos agora
    this.lastStreamEnd = new Map(); // infoHash -> ms do último stream encerrado
    this.completing = new Set(); // infoHash com o torrent inteiro selecionado
    this.noPeersWarned = new Set(); // infoHash já avisado de "sem peers" neste período
    // Histórico de tráfego para o painel: uma amostra a cada 15 s, 1 h no total.
    this.traffic = [];
    // Última leitura de /atividade: resumo da conta e obrigações abertas no tracker.
    this.account = null;
    this.trackerPending = [];
    this.publicUrl = publicUrl;
    this.credentials = credentials;
    // Respostas de vídeo abertas por credencial: a revogação as derruba na hora.
    this.sessions = new Map();
    // Quota de reproduções lógicas (src/play-limit.js): reserva antes de qualquer efeito de download.
    this.limiter = new PlaybackLimiter({ maxSessions: maxPlaybacks, maxPerCredential: maxPlaybacksPerCredential, graceMs: playbackGraceMs, now: clock });
    this.credentials?.on('revoked', (id) => this.dropSessions(id));
    this.adminKey = adminKey;
    this.strictHost = strictHost;
    this.firstByteTimeoutMs = firstByteTimeoutMs;
    // Credencial em memória: os .torrent em disco ficam sem token.
    this.passkey = passkey;
    this.uploadLimit = uploadLimit;
    // Teto reduzido durante reprodução (src/upload-policy.js). Inerte sem streamUploadLimit.
    this.uploadPolicy = new UploadPolicy({
      normal: uploadLimit, stream: streamUploadLimit, restoreMs: uploadRestoreMs, now: clock, log,
      apply: (rate) => (this.client ? this.client.throttleUpload(rate) : false),
      activeSessions: () => this.limiter.snapshot().active,
      seedPending: () => this.hasSeedObligation(),
    });
    // Base usada quando o .torrent foi gravado sem announce (`--strip`).
    this.announceBase = announceBase;
    // Contabilidade persistente da regra 13.1 (72 h de seed após concluir).
    this.vault = vault ?? new SeedVault({
      file: path.join(storeDir, '..', 'seed-vault.json'),
    });
    this.seedTimer = null;
    this.uploadTimer = null;
    this.lastTick = new Map();
    this.client = null;
    this.server = null;
    this.entries = new Map(); // infoHash -> entrada da biblioteca
    this.loading = new Map(); // infoHash -> Promise<torrent>
    this.startedAt = new Map(); // infoHash -> quando entrou no swarm (ms)
  }

  async start() {
    const WebTorrent = await loadWebTorrent();
    fs.mkdirSync(this.storeDir, { recursive: true });

    this.client = new WebTorrent({
      // Tracker privado exige swarm fechado: nada de DHT, LSD ou PEX.
      dht: false,
      lsd: false,
      utPex: false,
      // Não mexer no roteador (UPnP/PMP) só para semear.
      natUpnp: false,
      natPmp: false,
      // Porta fixa para peers conectarem de fora (útil em contêiner: publique-a com -p).
      // 0 = o sistema escolhe uma porta livre.
      torrentPort: Number(process.env.TORRENT_PORT) || 0,
      // Quanto a ponte sobe para o swarm: -1 = sem limite. Para limitar a
      // exposição (upload contabilizado na conta), use BRIDGE_UPLOAD_LIMIT.
      uploadLimit: this.uploadLimit,
    });

    this.client.on('error', (err) => {
      tlog.error(`erro no motor de streaming: ${err?.message ?? err}`);
    });

    for (const entry of await loadLibrary(this.torrentDir)) {
      this.entries.set(entry.infoHash, entry);
    }

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error(`falha ao atender ${req.method} ${String(req.url).split('?')[0]}: ${err?.message ?? err}`, { stack: err?.stack });
        if (!res.headersSent) {
          res.writeHead(err.status || 500, {
            'Content-Type': 'application/json; charset=utf-8',
            ...(err.expose && err.status === 503 ? { 'Retry-After': '60' } : {}),
          });
        }
        // Recusa de disco tem mensagem própria e segura; o resto continua genérico.
        if (!res.writableEnded) {
          res.end(JSON.stringify(err.expose
            ? { error: err.message, disco: err.detail }
            : { error: 'Falha ao preparar streaming' }));
        }
      });
    });

    // Stream de filme é longo: sem timeouts de socket.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 65000;

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });

    console.log(`[ponte] http://${this.host}:${this.port} — ${this.entries.size} torrent(s) na biblioteca`);
    if (this.host !== '127.0.0.1' && this.host !== '::1' && !inContainer()) {
      console.warn('[ponte] AVISO: escutando fora de loopback. A ponte é single-user, sem autenticação,' +
        ' e usa a SUA conta (regra 2.2 do ASC): nunca exponha à internet nem compartilhe com outras pessoas.');
    }

    // Contabilidade da regra 13.1: a cada minuto soma tempo de seed dos
    // torrents concluídos. Persistido, sobrevive a reinícios.
    this.seedTimer = setInterval(() => {
      const agora = Date.now();
      for (const torrent of this.client.torrents) {
        const entry = this.vault.get(torrent.infoHash);
        const anterior = this.lastTick.get(torrent.infoHash) ?? agora;
        this.lastTick.set(torrent.infoHash, agora);
        if (!entry?.completedAt || entry.satisfiedAt) continue;
        const delta = agora - anterior;
        if (delta > 0) this.vault.addSeedingTime(torrent.infoHash, delta);
      }
      this.keepAwake?.update(this.needsAwake());
    }, 60000);
    this.seedTimer.unref?.();

    this.completeTimer = setInterval(() => this.completionTick(), 30000);
    this.completeTimer.unref?.();

    // Restaura o teto de upload sozinho (sessões expiram sem evento) e reavalia o piso de seed pendente.
    this.uploadTimer = setInterval(() => this.uploadPolicy.evaluate(), 5000);
    this.uploadTimer.unref?.();

    this.sampleTimer = setInterval(() => this.sampleTraffic(), 15000);
    this.sampleTimer.unref?.();
    this.sampleTraffic();

    if (this.resumeOnStart) await this.resumePending();

    return this;
  }

  // O arquivo está completo em disco? (tamanho de cada arquivo do torrent.) Só
  // vale para torrents que o tracker já deu como concluídos; sem os dados não dá
  // para semear, e anunciar assim viraria um download novo.
  diskState(infoHash) {
    const lib = this.entries.get(infoHash);
    if (!lib?.files?.length) return null;
    let full = true;
    let any = false;
    for (const file of lib.files) {
      try {
        const size = fs.statSync(path.join(this.storeDir, file.path)).size;
        any = true;
        if (size < file.length) full = false;
      } catch { full = false; }
    }
    return full ? 'full' : any ? 'partial' : 'none';
  }

  // Espaço realmente ocupado em disco (blocos alocados, não o tamanho aparente:
  // o WebTorrent grava arquivos esparsos). Por filme, total da pasta de dados e
  // o que sobra fora de qualquer torrent da biblioteca (órfãos). Em cache por
  // 10 s: o painel consulta a cada 5 s.
  diskUsage(now = Date.now()) {
    if (this.duCache && now - this.duCache.at < 10_000) return this.duCache.value;
    const allocated = (p) => {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) return 0;
        return typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
      } catch { return 0; }
    };
    const perTitle = new Map();
    const known = new Set();
    for (const [hash, lib] of this.entries) {
      for (const file of lib.files ?? []) {
        const full = path.join(this.storeDir, file.path);
        known.add(full);
        const bytes = allocated(full);
        if (bytes) perTitle.set(hash, (perTitle.get(hash) ?? 0) + bytes);
      }
    }
    let total = 0;
    let orphan = 0;
    const walk = (dir) => {
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const item of list) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.isFile()) {
          const bytes = allocated(full);
          total += bytes;
          if (!known.has(full)) orphan += bytes;
        }
      }
    };
    walk(this.storeDir);
    const value = { perTitle, total, orphan };
    this.duCache = { at: now, value };
    return value;
  }

  setActivity({ summary, pending }) {
    this.account = summary;
    this.trackerPending = pending;
  }

  // Retoma pendências: se o processo caiu no meio das 72 h, volta a semear
  // sem intervenção, em vez de deixar o prazo de 12 dias correr. Idempotente:
  // chamada de novo depois de conciliar com o tracker, que pode revelar
  // obrigações que o cofre ainda não conhecia. Chamada durante uma retomada não abre uma
  // segunda fila: junta-se à que roda e pede uma nova passada (com a ordem refeita) ao final.
  resumePending() {
    if (this.resumeRun) {
      this.resumeAgain = true;
      return this.resumeRun;
    }
    this.resumeRun = (async () => {
      try {
        const run = { stats: null }; // as passadas de uma mesma retomada somam na mesma medição
        do {
          this.resumeAgain = false;
          await this.resumeOnce(run);
        } while (this.resumeAgain);
      } finally {
        this.resumeRun = null;
      }
    })();
    return this.resumeRun;
  }

  // Uma passada: ordena por risco de seed (src/resume-policy.js) e abre os torrents com no máximo
  // `resumeConcurrency` ao mesmo tempo. Cada abertura passa por getTorrent (admissão de disco
  // inclusive) e é medida; a falha de uma não interrompe as outras.
  async resumeOnce(run = { stats: null }) {
    const pendencias = this.vault.list().filter((e) => (
      (e.completedAt && !e.satisfiedAt) || (e.backgroundComplete && !e.completedAt)
      || (e.completedAt && e.satisfiedAt && (e.seedChoice === 'keep' || (this.afterSeed === 'manual' && !e.releasedAs && !['stop', 'delete'].includes(e.seedChoice))))
    ) && this.entries.has(e.infoHash)
      // Já no motor ou abrindo: nada a fazer, e a passada ociosa não apaga a medição da retomada real.
      && !this.loading.has(e.infoHash) && !this.client.torrents.some((t) => t.infoHash === e.infoHash));
    const ranked = rankPending(pendencias, { vault: this.vault, now: this.clock() });
    if (!ranked.length) return;

    const stats = run.stats ?? {
      running: true,
      runs: 0,
      concurrency: this.resumeConcurrency,
      startedAt: new Date(this.clock()).toISOString(),
      finishedAt: null,
      uptimeAtStartSeconds: Math.round(process.uptime()),
      queued: 0,
      opened: 0, failed: 0, deferred: 0, noData: 0, skipped: 0,
      bytes: 0, totalMs: null, firstOpenMs: null, slowestMs: 0,
      loopLagMaxMs: null,
      rssStartMB: Math.round(process.memoryUsage().rss / 1048576), rssPeakMB: 0,
      inFlight: new Map(),
      items: [],
    };
    stats.rssPeakMB = Math.max(stats.rssPeakMB, stats.rssStartMB);
    stats.runs += 1;
    stats.running = true;
    run.stats = stats;
    this.resumeStats = stats;
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    stats.queued += ranked.length;
    const prior = stats.totalMs ?? 0;
    const t0 = this.monotonic();
    const peak = () => { stats.rssPeakMB = Math.max(stats.rssPeakMB, Math.round(process.memoryUsage().rss / 1048576)); };
    log.info(`retomada: ${ranked.length} pendência(s), até ${this.resumeConcurrency} por vez`, {
      ordem: ranked.slice(0, 10).map((r) => `${short(r.infoHash)}:${r.className}`),
    });

    try {
      await runLimited(ranked, this.resumeConcurrency, async (item) => {
        const pendencia = item.entry;
        const hash = pendencia.infoHash;
        // Reavalia na vez dela: pode ter sido aberto por um play ou por outra passada.
        if (this.client.torrents.some((t) => t.infoHash === hash) || this.loading.has(hash)) { stats.skipped += 1; return; }
        // Obrigação concluída mas sem o arquivo completo: não anuncia (viraria um
        // download novo). Aparece no painel como "Sem arquivo para semear".
        if (pendencia.completedAt && !pendencia.backgroundComplete && this.diskState(hash) !== 'full') {
          if (!pendencia.noDataWarned) {
            console.warn(`[vault] sem o arquivo completo de "${String(pendencia.name).slice(0, 40)}": não dá para semear`);
            pendencia.noDataWarned = true;
          }
          stats.noData += 1;
          return;
        }
        const started = this.monotonic();
        stats.inFlight.set(hash, started);
        const record = { hash: short(hash), classe: item.className, horasAtePrazo: item.hoursToDeadline, prazo: item.deadlineSource };
        try {
          const torrent = await this.getTorrent(hash);
          record.resultado = 'ok';
          record.bytes = torrent?.length ?? null;
          stats.opened += 1;
          stats.bytes += record.bytes || 0;
          console.log(`[vault] retomando seed: ${String(pendencia.name).slice(0, 50)}`);
        } catch (err) {
          // Recusa de disco não derruba nada: o download não recomeça e a próxima rodada tenta de novo.
          record.resultado = err?.expose ? 'adiado' : 'erro';
          if (err?.expose) stats.deferred += 1; else stats.failed += 1;
          console.error(err?.expose
            ? `[vault] retomada adiada: ${err.message}`
            : '[vault] não foi possível retomar um seed pendente');
        } finally {
          stats.inFlight.delete(hash);
          record.ms = Math.round(this.monotonic() - started);
          stats.slowestMs = Math.max(stats.slowestMs, record.ms);
          if (stats.firstOpenMs === null && record.resultado === 'ok') stats.firstOpenMs = prior + Math.round(this.monotonic() - t0);
          if (stats.items.length < 100) stats.items.push(record);
          peak();
          log.info(`retomada: ${record.hash} ${record.resultado} em ${record.ms} ms`, {
            classe: record.classe, bytes: record.bytes ?? null, prazo: record.prazo,
          });
        }
      });
    } finally {
      lag.disable();
      stats.totalMs = prior + Math.round(this.monotonic() - t0);
      stats.loopLagMaxMs = Math.max(stats.loopLagMaxMs ?? 0, Number((lag.max / 1e6).toFixed(1)));
      stats.rssEndMB = Math.round(process.memoryUsage().rss / 1048576);
      stats.running = false;
      stats.finishedAt = new Date(this.clock()).toISOString();
      log.info(`retomada concluída em ${stats.totalMs} ms`, {
        abertos: stats.opened, falhas: stats.failed, adiados: stats.deferred, semArquivo: stats.noData,
        bytes: stats.bytes, maiorMs: stats.slowestMs, atrasoMaxLoopMs: stats.loopLagMaxMs,
      });
    }
  }

  // Medição da retomada para o painel: sem caminhos, nomes ou segredos (hash curto e números).
  // Os bytes são o TAMANHO dos torrents verificados (limite superior do que foi lido do disco).
  resumeSnapshot(now = this.monotonic()) {
    const s = this.resumeStats;
    if (!s) return null;
    const { inFlight, ...rest } = s;
    return {
      ...rest,
      items: s.items.map((i) => ({ ...i })),
      inFlight: [...inFlight].map(([hash, at]) => ({ hash: short(hash), ms: Math.round(now - at) })),
    };
  }

  // O que ainda falta gravar de um download admitido, para o orçamento de disco. Número = falta
  // isso; null = terminou (promessa cai); false = não está no motor; undefined = ainda abrindo.
  // Função de instância (arrow) porque é repassada ao DiskGuard.
  liveRemaining = (holder) => {
    if (!/^[0-9a-f]{40}$/.test(holder) || this.loading.has(holder)) return undefined;
    const t = (this.client?.torrents ?? []).find((x) => x.infoHash === holder);
    if (!t) return false;
    if (t.done || (t.progress ?? 0) >= 1) return null;
    if (!(t.length > 0)) return undefined;
    return Math.max(0, Math.round(t.length * (1 - (t.progress || 0))));
  };

  // Bytes que abrir este torrent ainda vai gravar: tamanho total menos o que já ocupa disco
  // (blocos alocados, não o tamanho aparente: o arquivo é esparso). No Windows (sem `blocks`)
  // vale o tamanho do arquivo. Streaming pode andar até o fim, então reserva o restante todo.
  neededBytes(infoHash) {
    const lib = this.entries.get(infoHash);
    const files = lib?.files ?? [];
    let total = 0;
    let onDisk = 0;
    for (const f of files) {
      total += f.length || 0;
      try {
        const st = fs.statSync(path.join(this.storeDir, f.path));
        if (st.isFile()) onDisk += Math.min(f.length || 0, typeof st.blocks === 'number' ? st.blocks * 512 : st.size);
      } catch { /* ainda não existe */ }
    }
    return Math.max(0, total - onDisk);
  }

  // Admissão de um torrent que ainda NÃO está no motor. Já completo em disco = só semear, sem
  // custo de espaço: não passa pela reserva. Lança DiskRefusal antes de qualquer efeito.
  admitTorrent(infoHash) {
    // Já no motor (ou abrindo): a admissão foi feita na abertura; novos Range/seek não pagam de novo.
    if (this.loading.has(infoHash) || (this.client?.torrents ?? []).some((t) => t.infoHash === infoHash)) return;
    // Só dispensa quem o cofre registra como CONCLUÍDO (e com os arquivos inteiros): o tamanho aparente
    // sozinho engana, pois um arquivo esparso de streaming que o player levou até o fim parece cheio.
    if (this.vault.get(infoHash)?.completedAt && this.diskState(infoHash) === 'full') return;
    this.disk.require({ holder: infoHash, need: this.neededBytes(infoHash), live: this.liveRemaining });
  }

  // Conclusão em segundo plano: depois que o usuário para de assistir, baixa o
  // resto do arquivo (prioridade baixa, nunca disputa com o player) para que a
  // obrigação de 72 h da regra 13.1 possa de fato ser paga. NÃO é um modo de
  // "nunca concluir": o único efeito é terminar o download.
  completionTick(now = Date.now()) {
    for (const torrent of this.client?.torrents ?? []) {
      // progress >= 1 cobre o instante em que o motor já verificou tudo mas ainda não emitiu `done`.
      if (torrent.done || (torrent.progress ?? 0) >= 1 || this.completing.has(torrent.infoHash) || !torrent.ready) continue;
      const entry = this.vault.get(torrent.infoHash);
      const requested = Boolean(entry?.backgroundComplete);

      if (!requested) {
        if (this.backgroundMode !== 'auto') continue;
        // Fora do freeleech, baixar tudo pesa no ratio (regra 2.7): só manual.
        if (this.isFreeleech(torrent.infoHash) !== true) continue;
        const idleSince = this.lastStreamEnd.get(torrent.infoHash)
          ?? this.startedAt.get(torrent.infoHash) ?? now;
        if ((this.streams.get(torrent.infoHash) ?? 0) > 0 || now - idleSince < this.idleMs) continue;
      }

      // Mesma política de disco do streaming e da retomada; sem medida confiável não começa
      // (fail-closed). Só impede NOVO download: o que já está em disco segue semeando.
      const restante = Math.max(0, (torrent.length || 0) - (torrent.downloaded || 0));
      const adm = this.disk.admit({ holder: torrent.infoHash, need: restante, live: this.liveRemaining });
      if (!adm.ok) {
        if (!entry?.noSpaceWarned) {
          console.warn(`[conclusão] não inicia "${String(torrent.name).slice(0, 40)}": ${adm.message}`);
          if (entry) entry.noSpaceWarned = true;
        }
        continue;
      }
      if (entry?.noSpaceWarned) entry.noSpaceWarned = false;

      // Prioridade 0: o streaming (prioridade crítica) sempre passa na frente.
      torrent.select(0, torrent.pieces.length - 1, 0);
      this.completing.add(torrent.infoHash);
      this.vault.setBackground(torrent.infoHash, true);
      console.log(`[conclusão] baixando o restante em segundo plano: ${String(torrent.name).slice(0, 50)}`);
    }
  }

  // Cumpriu o limite? Então não há motivo para ocupar disco nem rede. Só age
  // quando o TRACKER confirma (nunca pela estimativa local) e sem ninguém
  // assistindo. Devolve o que foi liberado.
  manageSeed(infoHash, action) {
    return manageSeed(this, infoHash, action);
  }

  async releaseSatisfied() {
    const released = [];
    if (['keep', 'manual'].includes(this.afterSeed) || !this.client) return released;
    for (const torrent of [...this.client.torrents]) {
      const hash = torrent.infoHash;
      const entry = this.vault.get(hash);
      if (!hnr.trackerConfirmed(entry) || entry.seedChoice === 'keep' || entry.seedChoice === 'stop') continue;
      if ((this.streams.get(hash) ?? 0) > 0 || this.retention.isRetiring(hash)) continue;
      await new Promise((resolve) => {
        torrent.destroy({ destroyStore: this.afterSeed === 'delete' }, () => resolve());
      });
      this.completing.delete(hash);
      this.startedAt.delete(hash);
      this.lastTick.delete(hash);
      this.vault.markReleased(hash, this.afterSeed);
      released.push({ infoHash: hash, name: entry.name, mode: this.afterSeed });
      console.log(`[liberar] limite cumprido e confirmado pelo tracker: "${String(entry.name).slice(0, 50)}"`
        + ` (${this.afterSeed === 'delete' ? 'rede e arquivos liberados' : 'rede liberada, arquivos mantidos'})`);
    }
    return released;
  }

  // Freeleech conhecido? O tracker (cofre) vale mais que o palpite da biblioteca.
  isFreeleech(infoHash) {
    return this.vault.get(infoHash)?.freeleech ?? this.entries.get(infoHash)?.freeleech ?? null;
  }

  // Pedido explícito do usuário (POST /complete). Abre o torrent se preciso:
  // é a mesma ação de dar play, então cria o snatch como um GET criaria.
  async requestCompletion(infoHash) {
    const entry = this.entries.get(infoHash);
    if (!entry) {
      const err = new Error('torrent não está na biblioteca');
      err.status = 404;
      throw err;
    }
    const torrent = await this.getTorrent(infoHash);
    this.vault.setBackground(infoHash, true);
    this.completionTick();
    return {
      infoHash,
      name: torrent.name,
      done: Boolean(torrent.done),
      freeleech: this.isFreeleech(infoHash),
      aviso: this.isFreeleech(infoHash) === true
        ? null
        : 'release não confirmado como freeleech: o download inteiro conta no seu ratio (regra 2.7)',
    };
  }

  // Há algo que não pode ser interrompido por suspensão? Seed cobrado com o
  // torrent no motor, ou download (conclusão em segundo plano) em andamento.
  needsAwake() {
    return (this.client?.torrents ?? []).some((t) => {
      const entry = this.vault.get(t.infoHash);
      if (!t.done) return this.completing.has(t.infoHash);
      return Boolean(entry?.completedAt && !entry.satisfiedAt);
    });
  }

  sampleTraffic(now = Date.now()) {
    this.traffic.push({
      t: now,
      up: Math.round(this.client?.uploadSpeed || 0),
      down: Math.round(this.client?.downloadSpeed || 0),
    });
    if (this.traffic.length > 240) this.traffic.splice(0, this.traffic.length - 240);
  }

  // Foto completa para o painel de monitoramento: cada filme individualmente,
  // o resumo geral e o histórico de tráfego. Só leitura, sem rede.
  // Vagas de reprodução para o diagnóstico: só contagens por credencial (id e nome), sem título nem IP.
  playbackSnapshot() {
    const snap = this.limiter.snapshot();
    const names = new Map((this.credentials?.list?.() ?? []).map((c) => [c.id, c.name]));
    return { ...snap, credentials: snap.credentials.map((c) => ({ ...c, name: names.get(c.credentialId) ?? null })), upload: this.uploadPolicy.snapshot() };
  }

  // Há obrigação de seed aberta (13.1): no cofre ou, quando o tracker foi lido, em seeds pendentes lá.
  hasSeedObligation() {
    return this.vault.summary().pendentes > 0 || (this.trackerPending?.length ?? 0) > 0;
  }

  snapshot(now = Date.now()) {
    const engine = new Map((this.client?.torrents ?? []).map((t) => [t.infoHash, t]));
    const active = new Set(engine.keys());
    const required = this.vault.requiredMs;
    const titles = [];

    const build = (infoHash, entry, lib) => {
      const torrent = engine.get(infoHash) ?? null;
      const tracker = entry?.tracker ?? null;
      const completed = Boolean(entry?.completedAt);
      const satisfied = Boolean(entry?.satisfiedAt);
      const seedMs = entry?.seedMs ?? 0;
      const deadline = entry ? this.vault.deadlineMs(infoHash) : null;
      const daysLeft = deadline === null ? null : (deadline - now) / 86_400_000;
      const warnings = entry ? hnr.warningsFor({ vault: this.vault, entry, active, now }) : [];
      const down = torrent?.downloaded || 0;
      const up = torrent?.uploaded || 0;
      const completando = this.completing.has(infoHash) || Boolean(entry?.backgroundComplete && !completed);

      let state;
      if (!entry) state = 'unstarted';
      else if (tracker?.hitAndRun) state = 'hnr';
      else if (completed && satisfied) state = 'done';
      else if (completed && seedMs >= required) state = 'awaiting';
      else if (completed) {
        // Sem o arquivo completo não há como semear: é outra ação (baixar de novo).
        state = torrent ? 'seeding' : this.diskState(infoHash) === 'full' || !lib ? 'paused' : 'missing';
      }
      else if (completando) state = 'completing';
      else state = 'partial';

      let risk = 'ok';
      if (state === 'hnr') risk = 'crit';
      else if (state === 'seeding' || state === 'paused' || state === 'missing' || state === 'awaiting') {
        const inactive = state === 'paused' || state === 'missing';
        if (daysLeft !== null && daysLeft <= 0) risk = 'crit';
        else if (inactive && daysLeft !== null && daysLeft <= 2) risk = 'crit';
        else if (inactive || (daysLeft !== null && daysLeft <= 4)) risk = 'warn';
      }
      // Snatch parcial: o site não o lista nas pendências (/atividade), então
      // não conta como risco. A informação do tracker fica visível na linha.

      return {
        infoHash,
        ascId: hnr.ascIdFromPath(entry?.torrentPath ?? lib?.torrentPath),
        name: String(entry?.displayName ?? entry?.name ?? lib?.title ?? lib?.name ?? infoHash),
        size: torrent?.length ?? lib?.size ?? null,
        freeleech: this.isFreeleech(infoHash),
        state,
        risk,
        active: Boolean(torrent),
        onDisk: this.diskState(infoHash),
        backgroundComplete: Boolean(entry?.backgroundComplete),
        released: entry?.releasedAs ?? null,
        seedChoice: entry?.seedChoice ?? null,
        progress: torrent ? Number((torrent.progress || 0).toFixed(4)) : (completed ? 1 : 0),
        downloaded: down,
        uploaded: up,
        ratio: down > 0 ? Number((up / down).toFixed(3)) : null,
        downSpeed: Math.round(torrent?.downloadSpeed || 0),
        upSpeed: Math.round(torrent?.uploadSpeed || 0),
        peers: torrent?.numPeers ?? 0,
        seededHours: Number((seedMs / 3_600_000).toFixed(2)),
        requiredHours: required / 3_600_000,
        completedAt: entry?.completedAt ? new Date(entry.completedAt).toISOString() : null,
        lastSeenAt: entry?.lastSeenAt ? new Date(entry.lastSeenAt).toISOString() : null,
        deadline: deadline === null ? null : new Date(deadline).toISOString(),
        daysLeft: daysLeft === null ? null : Number(daysLeft.toFixed(2)),
        hoursPerDayNeeded: completed && !satisfied && daysLeft !== null
          ? Number((((required - seedMs) / 3_600_000) / Math.max(daysLeft, 0.04)).toFixed(1))
          : 0,
        tracker: tracker
          ? {
            checkedAt: new Date(tracker.checkedAt).toISOString(),
            status: tracker.status,
            satisfied: tracker.satisfied,
            hitAndRun: tracker.hitAndRun,
            remainingHours: tracker.remainingMs === null
              ? null : Number((tracker.remainingMs / 3_600_000).toFixed(2)),
          }
          : null,
        warnings,
      };
    };

    const known = new Set();
    for (const entry of this.vault.list()) {
      known.add(entry.infoHash);
      titles.push(build(entry.infoHash, entry, this.entries.get(entry.infoHash)));
    }
    for (const [infoHash, lib] of this.entries) {
      if (!known.has(infoHash)) titles.push(build(infoHash, null, lib));
    }

    // Obrigações abertas no tracker sem .torrent local: aparecem como linhas virtuais.
    const have = new Set(titles.map((t) => t.ascId).filter(Boolean));
    for (const p of this.trackerPending) {
      if (p.local || have.has(p.ascId)) continue;
      const deadline = p.snapshot.deadlineMs;
      const daysLeft = deadline ? (deadline - now) / 86_400_000 : null;
      const remainingH = p.snapshot.remainingMs === null ? null : p.snapshot.remainingMs / 3_600_000;
      titles.push({
        infoHash: `asc-${p.ascId}`,
        ascId: p.ascId,
        name: p.name,
        size: null,
        freeleech: null,
        state: 'missing',
        risk: daysLeft !== null && daysLeft <= 2 ? 'crit' : 'warn',
        active: false,
        onDisk: null,
        noTorrent: true,
        backgroundComplete: false,
        progress: 1,
        downloaded: 0,
        uploaded: 0,
        ratio: null,
        downSpeed: 0,
        upSpeed: 0,
        peers: 0,
        seededHours: Number((required / 3_600_000 - (remainingH ?? 0)).toFixed(2)),
        requiredHours: required / 3_600_000,
        completedAt: p.snapshot.completedAtMs ? new Date(p.snapshot.completedAtMs).toISOString() : null,
        lastSeenAt: null,
        deadline: deadline ? new Date(deadline).toISOString() : null,
        daysLeft: daysLeft === null ? null : Number(daysLeft.toFixed(2)),
        hoursPerDayNeeded: remainingH !== null && daysLeft !== null
          ? Number((remainingH / Math.max(daysLeft, 0.04)).toFixed(1)) : 0,
        tracker: {
          checkedAt: new Date(now).toISOString(),
          status: p.snapshot.status,
          satisfied: false,
          hitAndRun: p.snapshot.hitAndRun,
          remainingHours: remainingH === null ? null : Number(remainingH.toFixed(2)),
        },
        warnings: [`${p.name}: o tracker cobra ${remainingH === null ? 'seed' : `${remainingH.toFixed(1)} h de seed`}, mas não há .torrent local. Abra o filme pelo catálogo ASC no Stremio para obter o .torrent.`],
      });
    }

    const du = this.diskUsage(now);
    for (const t of titles) t.diskBytes = du.perTitle.get(t.infoHash) ?? 0;

    const pending = titles.filter((t) => ['seeding', 'paused', 'missing', 'awaiting', 'hnr'].includes(t.state));
    const hoursPending = pending.reduce(
      (acc, t) => acc + Math.max(0, t.requiredHours - t.seededHours), 0);
    const disk = this.disk.status(this.liveRemaining);
    const freeBytes = disk.free;

    return {
      generatedAt: new Date(now).toISOString(),
      summary: {
        total: titles.length,
        pending: pending.length,
        hoursPending: Number(hoursPending.toFixed(1)),
        // Os torrents semeiam em paralelo: a máquina precisa ficar ligada pelo
        // maior pedido diário, não pela soma.
        machineHoursPerDay: Number(Math.max(0, ...pending.map((t) => t.hoursPerDayNeeded)).toFixed(1)),
        atRisk: titles.filter((t) => t.risk !== 'ok').length,
        critical: titles.filter((t) => t.risk === 'crit').length,
        done: titles.filter((t) => t.state === 'done').length,
        active: engine.size,
        peers: titles.reduce((acc, t) => acc + t.peers, 0),
        uploaded: titles.reduce((acc, t) => acc + t.uploaded, 0),
        downloaded: titles.reduce((acc, t) => acc + t.downloaded, 0),
        upSpeed: Math.round(this.client?.uploadSpeed || 0),
        downSpeed: Math.round(this.client?.downloadSpeed || 0),
        freeBytes,
        // Política de disco: reserva efetiva, comprometido com downloads e motivo de bloqueio.
        disk,
        diskUsed: du.total,
        // Sem uso para nenhuma obrigação: dados de filmes só em streaming ou nunca
        // concluídos, mais arquivos que não pertencem a torrent nenhum da biblioteca.
        diskReclaimable: du.orphan + titles
          .filter((t) => t.state === 'partial' || t.state === 'unstarted')
          .reduce((acc, t) => acc + t.diskBytes, 0),
        diskOrphan: du.orphan,
      },
      settings: {
        requiredHours: required / 3_600_000,
        backgroundMode: this.backgroundMode,
        idleMinutes: Math.round(this.idleMs / 60000),
        afterSeed: this.afterSeed,
        keepAwake: Boolean(this.keepAwake?.active),
        host: this.host,
        uploadLimit: this.uploadLimit,
        streamUploadLimit: this.uploadPolicy.stream,
        diskReserveBytes: this.minFreeBytes,
        diskReservePercent: this.reservePercent,
        resumeConcurrency: this.resumeConcurrency,
      },
      playback: this.playbackSnapshot(),
      resume: this.resumeSnapshot(),
      streaming: this.metrics.snapshot(),
      account: this.account
        ? {
          hitAndRuns: this.account.hitAndRuns,
          pendingSeeds: this.account.pendingSeeds,
          prisonUntil: this.account.prisonUntil,
          exempt: this.account.exempt,
          cleared: this.account.cleared,
        }
        : null,
      notices: [this.accountNotice?.()].filter(Boolean),
      titles,
      traffic: this.traffic,
    };
  }

  // Avisos de risco de HnR (prazo, torrent inativo, tracker sem conferência).
  hnrWarnings(now = Date.now()) {
    const active = new Set((this.client?.torrents ?? []).map((t) => t.infoHash));
    const out = hnr.warnings({ vault: this.vault, active, now });
    for (const p of this.trackerPending) {
      if (p.local) continue;
      out.push(`${String(p.name).slice(0, 50)}: obrigação aberta no tracker sem .torrent local (abra o filme pelo catálogo ASC no Stremio).`);
    }
    for (const entry of this.vault.list()) {
      if (entry.completedAt && !entry.satisfiedAt && !active.has(entry.infoHash)
        && this.entries.has(entry.infoHash) && this.diskState(entry.infoHash) !== 'full') {
        out.push(`${String(entry.name).slice(0, 50)}: o arquivo não está completo em disco; não dá para semear. É preciso baixar de novo (POST /complete).`);
      }
    }
    return out;
  }

  // URL de uma fonte que ainda não tem .torrent local: só vira download no play.
  lazyUrl(ascId) {
    const base = this.publicUrl || `http://127.0.0.1:${this.port}`;
    return `${base.replace(/\/$/, '')}/a/${ascId}${this.keyQuery()}`;
  }

  // Entrada da biblioteca de um release do ASC (arquivo asc-<id>.torrent), se já baixado.
  entryByAscId(ascId) {
    const suffix = `asc-${ascId}.torrent`;
    for (const entry of this.entries.values()) {
      if (String(entry.torrentPath ?? '').endsWith(suffix) && path.basename(entry.torrentPath) === suffix) return entry;
    }
    return null;
  }

  urlFor(infoHash, fileIdx = 0) {
    const base = this.publicUrl || `http://127.0.0.1:${this.port}`;
    return `${base.replace(/\/$/, '')}/s/${infoHash}/${fileIdx}${this.keyQuery()}`;
  }

  // O token é o da credencial que pediu a lista de fontes (contexto da requisição ao addon).
  // Fora desse contexto não há token: a URL sai sem ele e a ponte a recusa (fail-closed).
  keyQuery() {
    const token = currentToken();
    return token ? `?k=${token}` : '';
  }

  // Credencial ativa da requisição, ou null (sem token, errado ou revogado).
  keyOk(url) {
    return this.credentials?.verify(url.searchParams.get('k') ?? '') ?? null;
  }

  trackSession(credentialId, res) {
    if (!this.sessions.has(credentialId)) this.sessions.set(credentialId, new Set());
    const set = this.sessions.get(credentialId);
    set.add(res);
    res.once?.('close', () => { set.delete(res); if (set.size === 0) this.sessions.delete(credentialId); });
  }

  dropSessions(credentialId) {
    this.limiter.dropCredential(credentialId);
    this.uploadPolicy.evaluate(); // as vagas sumiram: o teto reduzido segue só pela espera de restauração
    const set = this.sessions.get(credentialId);
    if (!set) return;
    log.info(`credencial revogada: ${set.size} resposta(s) de vídeo aberta(s) encerrada(s)`);
    for (const res of [...set]) res.destroy?.();
    this.sessions.delete(credentialId);
  }

  // Reserva a vaga de reprodução de um GET ANTES de qualquer efeito (.torrent, snatch, abrir torrent).
  // Devolve o lease (liberado sozinho quando a resposta fecha, por qualquer motivo) ou null depois
  // de responder 429 com Retry-After. Registrar o 'close' aqui, de forma síncrona, evita contador
  // preso quando a resposta é destruída durante um await mais adiante.
  admitPlayback(res, credential, key) {
    const r = this.limiter.acquire(credential.id, key);
    if (!r.ok) {
      log.warn(`reprodução recusada: limite ${r.scope === 'global' ? 'global' : 'da credencial'} de ${r.limit} sessão(ões) atingido`);
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(r.retryAfter),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        error: r.scope === 'global'
          ? `Limite de ${r.limit} reprodução(ões) simultânea(s) atingido. Encerre outra ou tente de novo em instantes.`
          : `Limite de ${r.limit} reprodução(ões) simultânea(s) para este aparelho atingido. Encerre outra ou tente de novo em instantes.`,
        limite: r.scope, max: r.limit, retryAfter: r.retryAfter,
      }));
      return null;
    }
    const { lease } = r;
    // Só uma resposta de vídeo que começou (cabeçalhos enviados, < 400) mantém a vaga pela janela de inatividade.
    const done = () => {
      lease.release({ keep: Boolean(res.headersSent) && res.statusCode < 400 });
      this.uploadPolicy.evaluate(); // resposta de erro não segura vaga: não segura o teto reduzido
    };
    // Teto reduzido ANTES de transferir o fluxo (só há efeito se o operador configurou o de streaming).
    this.uploadPolicy.evaluate();
    if (res.destroyed) done(); else res.once('close', done);
    return lease;
  }

  adminOk(req) {
    if (!this.adminKey) return false;
    const given = Buffer.from(String(req.headers?.['x-admin-token'] ?? ''));
    const want = Buffer.from(this.adminKey);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  // Gestão das credenciais de instalação (rotas administrativas, já autenticadas por adminOk).
  // O token só aparece na resposta que o emite; a lista traz apenas id, nome e datas.
  handleCredentials(req, res, url) {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!this.credentials) return send(503, { error: 'credenciais indisponíveis' });
    const id = url.searchParams.get('id') ?? '';
    try {
      if (url.pathname === '/credentials' && req.method === 'GET') return send(200, { credentials: this.credentials.list() });
      if (url.pathname === '/credentials' && req.method === 'POST') {
        const status = ['1', 'true'].includes(url.searchParams.get('status') ?? '');
        return send(201, this.credentials.create({ name: url.searchParams.get('name'), status }));
      }
      if (url.pathname === '/credentials/revoke' && req.method === 'POST') {
        return this.credentials.revoke(id) ? send(200, { revoked: id }) : send(404, { error: 'credencial inexistente' });
      }
      if (url.pathname === '/credentials/rotate' && req.method === 'POST') {
        const next = this.credentials.rotate(id);
        return next ? send(201, { ...next, revoked: id }) : send(404, { error: 'credencial inexistente ou já revogada' });
      }
    } catch (err) {
      return send(400, { error: String(err?.message ?? err) });
    }
    return send(405, { error: 'método não permitido' });
  }

  async getTorrent(infoHash) {
    // Título em remoção pela retenção: nada o reabre até terminar (evita corrida play x apagar).
    if (this.retention.isRetiring(infoHash)) {
      const err = new Error('Título em manutenção (retenção de disco); tente de novo em instantes.');
      err.status = 503;
      err.expose = true;
      throw err;
    }
    if (this.loading.has(infoHash)) return this.loading.get(infoHash);

    const already = await this.client.get(infoHash);
    if (this.loading.has(infoHash)) return this.loading.get(infoHash);
    if (already) {
      // O motor registra o infoHash antes de terminar de ler o .torrent: nesse
      // intervalo `files` ainda é null. Esperar o 'ready' evita 500 quando o
      // player dispara HEAD e GET quase juntos.
      if (already.ready) return already;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout ao abrir o torrent')), 30000);
        already.once('ready', () => { clearTimeout(timer); resolve(); });
        already.once('error', () => { clearTimeout(timer); reject(new Error('falha ao abrir o torrent')); });
      });
      return already;
    }

    const entry = this.entries.get(infoHash);
    if (!entry) {
      const err = new Error('torrent não está na biblioteca');
      err.status = 404;
      throw err;
    }

    // Antes de qualquer efeito (abrir, anunciar, gravar): sem folga ou sem medida, recusa.
    this.admitTorrent(infoHash);

    const task = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout ao abrir o torrent')), 30000);
      try {
        const base = entry.announceBase || this.announceBase;
        const announce = this.passkey && base
          ? [announceWithPasskey(base, this.passkey)]
          : undefined;
        const pending = this.client.add(entry.torrentPath, {
          path: this.storeDir,
          // Sem deselect o WebTorrent baixaria o torrent inteiro sozinho.
          deselect: true,
          strategy: 'sequential',
          destroyStoreOnDestroy: false,
          // A credencial entra aqui, só em memória, e nunca vai para o disco.
          ...(announce ? { announce } : {}),
        }, (torrent) => {
          clearTimeout(timer);
          if (!this.startedAt.has(torrent.infoHash)) {
            this.startedAt.set(torrent.infoHash, Date.now());
          }
          // Nunca logar torrent.announce direto: contém a passkey (o logger também redige).
          tlog.info(`torrent aberto: "${String(torrent.name).slice(0, 60)}" (${short(torrent.infoHash)}, ${torrent.files?.length ?? '?'} arquivo(s), ${torrent.done ? 'completo' : `${(torrent.progress * 100).toFixed(1)}%`})`);
          torrent.on('error', (err) => tlog.error(`erro no torrent ${short(torrent.infoHash)}: ${err?.message ?? err}`));
          // O motor repete "noPeers" a cada ~30 s: avisa uma vez por período sem peers e
          // deixa as repetições em debug (senão o filtro de avisos fica inútil).
          torrent.on('noPeers', (type) => {
            if (this.noPeersWarned.has(torrent.infoHash)) tlog.debug(`ainda sem peers em ${short(torrent.infoHash)} (${type})`);
            else { this.noPeersWarned.add(torrent.infoHash); tlog.warn(`sem peers em ${short(torrent.infoHash)} (${type})`); }
          });
          torrent.on('wire', () => {
            if (this.noPeersWarned.delete(torrent.infoHash)) tlog.info(`peers voltaram em ${short(torrent.infoHash)} (${torrent.numPeers})`);
            else tlog.debug(`peer conectado em ${short(torrent.infoHash)} (${torrent.numPeers} no total)`);
          });

          // Regra 13.1: a obrigação de 72 h nasce quando o download CONCLUI.
          this.vault.markSeen(torrent.infoHash, {
            torrentPath: entry.torrentPath,
            announceBase: base ?? null,
            name: torrent.name ?? entry.name,
            freeleech: entry.freeleech ?? null,
          });
          // Conclusão em segundo plano pedida antes de um reinício: retoma.
          if (this.vault.get(torrent.infoHash)?.backgroundComplete) this.completionTick();
          const onDone = () => {
            this.vault.markCompleted(torrent.infoHash);
          };
          if (torrent.done) onDone();
          else torrent.once('done', onDone);

          resolve(torrent);
        });
        pending.on('warning', (err) => tlog.warn(`aviso de conectividade em ${short(infoHash)}: ${err?.message ?? err}`));
        pending.once('error', (err) => {
          tlog.error(`falha ao abrir ${short(infoHash)}: ${err?.message ?? err}`);
          clearTimeout(timer);
          reject(new Error('Falha ao abrir torrent'));
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }).finally(() => this.loading.delete(infoHash));

    this.loading.set(infoHash, task);
    return task;
  }

  // Estado de cumprimento da regra 13.1. A fonte de verdade é o cofre
  // persistente; o ratio é medido no próprio motor.
  seedState(torrent) {
    const entry = this.vault.get(torrent.infoHash);
    const downloaded = torrent.downloaded || 0;
    const uploaded = torrent.uploaded || 0;
    const ratio = downloaded > 0 ? uploaded / downloaded : 0;
    if (ratio >= 1) this.vault.markRatioMet(torrent.infoHash, ratio);

    const seedMs = entry?.seedMs ?? 0;
    const completed = Boolean(entry?.completedAt) || Boolean(torrent.done);
    const satisfied = Boolean(entry?.satisfiedAt);
    return {
      concluded: completed,
      hoursSeeding: Number((seedMs / 3_600_000).toFixed(2)),
      uploaded,
      downloaded,
      ratio: Number(ratio.toFixed(3)),
      ratioMet: ratio >= 1,
      // Sem conclusão não há obrigação (regra 13.1): streaming parcial é isento.
      obligation: completed && !satisfied,
      met: !completed || satisfied,
      missingHours: completed && !satisfied
        ? Number(((this.vault.requiredMs - seedMs) / 3_600_000).toFixed(2))
        : 0,
      deadline: entry ? new Date(this.vault.deadlineMs(torrent.infoHash)).toISOString() : null,
      // Conferência com o myHistory do tracker: quando existe, ela manda.
      tracker: entry?.tracker
        ? {
          checkedAt: new Date(entry.tracker.checkedAt).toISOString(),
          satisfied: entry.tracker.satisfied,
          hitAndRun: entry.tracker.hitAndRun,
          remainingHours: entry.tracker.remainingMs === null
            ? null : Number((entry.tracker.remainingMs / 3_600_000).toFixed(2)),
        }
        : null,
      progress: Number((torrent.progress || 0).toFixed(4)),
      completando: this.completing.has(torrent.infoHash),
      // Horas de seed por dia (relógio) para cumprir o prazo: orienta quantas
      // horas/noite a máquina precisa ficar ligada.
      hoursPerDayNeeded: completed && !satisfied && entry
        ? Number((((this.vault.requiredMs - seedMs) / 3_600_000)
          / Math.max((this.vault.deadlineMs(torrent.infoHash) - Date.now()) / 86_400_000, 0.04)).toFixed(1))
        : 0,
      awaitingTracker: Boolean(entry?.tracker && !entry.satisfiedAt && entry.seedMs >= this.vault.requiredMs),
    };
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const started = Date.now();
    if (!['/health', '/status', '/seed-status'].includes(url.pathname)) {
      res.once?.('close', () => {
        const range = req.headers?.range ? ` range=${req.headers.range}` : '';
        const msg = `${req.method} ${url.pathname.replace(/[0-9a-f]{40}/i, (h) => short(h))}${range} → ${res.statusCode} (${Date.now() - started} ms${res.writableFinished ? '' : ', interrompido'})`;
        if (res.statusCode >= 500) log.error(msg); else if (res.statusCode >= 400) log.warn(msg); else log.debug(msg);
      });
    }

    if (this.strictHost && !hostAllowed(req.headers?.host)) {
      log.warn(`pedido recusado: Host inesperado (${String(req.headers?.host).slice(0, 60)})`);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Host não permitido' }));
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, torrents: this.client.torrents.length }));
      return;
    }

    // Rotas administrativas: exigem o token administrativo (cabeçalho, nunca na URL),
    // sem Origin (navegadores o enviam em POST/fetch entre origens) e, fora do
    // contêiner, vindas de loopback. No contêiner o endereço de origem é o do gateway
    // ou de outro contêiner, então só o token vale; ele é independente da chave ?k=.
    const admin = ['/cleanup', '/seed-status', '/status', '/complete', '/credentials', '/credentials/revoke', '/credentials/rotate', '/playback', '/retention', '/retention/run'].includes(url.pathname);
    if (admin && (!this.adminOk(req) || req.headers?.origin || !(inContainer() || isLoopbackRequest(req)))) {
      log.warn(`rota administrativa recusada: ${req.method} ${url.pathname} (origem ${req.socket?.remoteAddress ?? '?'}${req.headers?.origin ? `, Origin ${req.headers.origin}` : ''})`);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'rota administrativa: exige token administrativo, fora de navegador' }));
      return;
    }

    if (['/credentials', '/credentials/revoke', '/credentials/rotate'].includes(url.pathname)) {
      this.handleCredentials(req, res, url);
      return;
    }

    if (url.pathname === '/cleanup' && req.method === 'POST') {
      // Regra 13.1 do ASC: depois de baixar, semear por 72 h ou até o ratio
      // 1.0 no torrent, o que vier primeiro. Encerrar antes disso é o caminho
      // para hit-and-run (13.3/13.4), então só remove quem já cumpriu.
      // Não há atalho para pular a checagem (o antigo ?force=1 foi removido).
      const victim = url.searchParams.get('hash');
      log.info(`cleanup pedido${victim ? ` para ${short(victim)}` : ' para todos'}`);
      const targets = victim
        ? this.client.torrents.filter((t) => t.infoHash === victim.toLowerCase())
        : this.client.torrents;

      if (targets.some((t) => this.retention.isRetiring(t.infoHash))) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Conteúdo em manutenção; tente novamente depois.' }));
        return;
      }
      const blocked = [];
      // O tracker decide: confirma antes de liberar (falha de rede não libera).
      await this.trackerCheck?.(targets.map((t) => t.infoHash)).catch(() => {});
      for (const t of targets) {
        const state = this.seedState(t);
        if (!state.met) blocked.push({ infoHash: t.infoHash, ...state });
      }
      if (blocked.length > 0) {
        log.warn(`cleanup recusado: ${blocked.length} torrent(s) com obrigação de seed pendente (regra 13.1)`);
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          removed: 0,
          blocked,
          hint: 'regra 13.1: 72 h de seed ou ratio 1.0 no torrent',
        }, null, 2));
        return;
      }

      await Promise.all(targets.map((t) => new Promise((resolve) => {
        t.destroy({ destroyStore: true }, () => resolve());
      })));
      for (const t of targets) this.startedAt.delete(t.infoHash);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      log.info(`cleanup concluído: ${targets.length} torrent(s) removido(s)`);
      res.end(JSON.stringify({ removed: targets.length }));
      return;
    }

    // Retenção por orçamento (issue #27). GET = prévia (só leitura). POST /retention/run?plan=<id>
    // = execução confirmada do plano que a prévia emitiu; o tracker é relido antes de qualquer remoção.
    if (url.pathname === '/retention' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.retention.preview(), null, 2));
      return;
    }
    if (url.pathname === '/retention/run' && req.method === 'POST') {
      log.info('retenção: execução pedida');
      try {
        const out = await this.retention.run(url.searchParams.get('plan'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out, null, 2));
      } catch (err) {
        if (!err.body) throw err;
        res.writeHead(err.status || 409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message, ...err.body }));
      }
      return;
    }

    if (url.pathname === '/complete' && req.method === 'POST') {
      const hash = String(url.searchParams.get('hash') ?? '').toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(hash)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'informe ?hash=<infoHash de 40 hex>' }));
        return;
      }
      log.info(`conclusão em segundo plano pedida para ${short(hash)}`);
      const result = await this.requestCompletion(hash);
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    if (url.pathname === '/seed-status') {
      const body = {
        resumo: this.vault.summary(),
        ativos: this.client.torrents.map((t) => ({ infoHash: t.infoHash, ...this.seedState(t) })),
        // Pendências que já saíram do motor mas cujo prazo de 12 dias corre.
        pendencias: this.vault.list().filter((e) => e.completedAt && !e.satisfiedAt),
        avisos: [this.accountNotice?.(), ...this.hnrWarnings()].filter(Boolean),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    if (url.pathname === '/playback' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.playbackSnapshot()));
      return;
    }

    if (url.pathname === '/status') {
      const body = this.client.torrents.map((t) => ({
        infoHash: t.infoHash,
        name: t.name,
        length: t.length,
        downloaded: t.downloaded,
        uploaded: t.uploaded,
        progress: Number(t.progress.toFixed(6)),
        peers: t.numPeers,
        private: Boolean(t.private),
        done: t.done,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    const m = /^\/s\/([0-9a-fA-F]{40})(?:\/(\d+))?$/.exec(url.pathname);
    const lazy = /^\/a\/(\d{1,9})$/.exec(url.pathname);
    // Quem não tem a chave (por exemplo, uma página web que adivinhou /a/<id>) não
    // dispara download nem anúncio no tracker com a sua conta.
    // A verificação é feita a cada GET/HEAD/Range, então URL guardada em cache pelo player
    // não contorna a revogação.
    const credential = (m || lazy) ? this.keyOk(url) : null;
    if ((m || lazy) && !credential) {
      log.warn(`${req.method} ${url.pathname.replace(/[0-9a-f]{40}/i, (h) => short(h))} recusado: credencial ausente, inválida ou revogada`);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'credencial ausente, inválida ou revogada: reabra a fonte pelo Stremio' }));
      return;
    }
    if (credential) this.trackSession(credential.id, res);
    if (!m && !lazy) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'rota desconhecida' }));
      return;
    }

    let infoHash = m ? m[1].toLowerCase() : null;
    let fileIdx = m ? (m[2] === undefined ? 0 : Number(m[2])) : 0;

    // Vídeo só por GET/HEAD: outro método não pode contornar a quota nem disparar download.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD, OPTIONS' });
      res.end(JSON.stringify({ error: 'método não permitido' }));
      return;
    }

    // Quota de reproduções: só o GET (HEAD nunca ocupa vaga) e antes de qualquer efeito.
    let lease = null;
    if (req.method === 'GET') {
      let key;
      if (m) {
        key = `s:${infoHash}:${fileIdx}`;
      } else {
        const local = this.entryByAscId(lazy[1]);
        const main = local ? mainVideo(local.files) : null;
        key = local && main ? `s:${local.infoHash}:${main.index}` : `a:${lazy[1]}`;
      }
      lease = this.admitPlayback(res, credential, key);
      if (!lease) return;
    }

    // /a/<id>: fonte listada pelo Stremio sem .torrent local. Só o GET (o play)
    // baixa o .torrent; HEAD e sondagens nunca baixam nem anunciam.
    if (lazy) {
      const ascId = lazy[1];
      const local = this.entryByAscId(ascId);
      const main = local ? mainVideo(local.files) : null;
      if (local && main) {
        infoHash = local.infoHash;
        fileIdx = main.index;
      } else if (req.method === 'HEAD') {
        // Sem .torrent não há tamanho exato: responde sem Content-Length.
        res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
        res.end();
        return;
      } else {
        if (!this.ascResolver) {
          res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'download sob demanda indisponível' }));
          return;
        }
        // Reserva espaço ANTES de baixar o .torrent (que cria o snatch): o tamanho vem da listagem;
        // sem ele, exige ao menos a reserva livre (o tamanho real é conferido ao abrir o torrent).
        const holder = `asc:${ascId}`;
        try {
          this.disk.require({ holder, need: this.ascSizeHint?.(ascId) || 0, live: this.liveRemaining });
          ({ infoHash, fileIdx } = await this.ascResolver(ascId));
        } catch (err) {
          const status = Number.isInteger(err?.status) ? err.status : 502;
          log.warn(`play de #${ascId} recusado (${status}): ${err?.message ?? err}`);
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(status === 503 && err?.detail ? { 'Retry-After': '60' } : {}) });
          res.end(JSON.stringify({ error: err?.message || 'Não foi possível preparar o filme.', ...(err?.detail ? { disco: err.detail } : {}) }));
          return;
        } finally {
          this.disk.release(holder);
        }
        // Credencial revogada (ou cliente que saiu) enquanto o .torrent era preparado: não abre o torrent.
        if (res.destroyed) return;
        lease?.rekey(`s:${infoHash}:${fileIdx}`);
        // Troca a promessa provisória pela do torrent sem deixar brecha entre as duas.
        this.admitTorrent(infoHash);
      }
    }

    // HEAD não assiste nada, mas o player sonda antes de tocar. Abrir o
    // torrent aqui criaria um snatch (e o prazo de 12 dias) sem o usuário ver
    // um único segundo. Responde só com os metadados já lidos do .torrent.
    if (req.method === 'HEAD') {
      const meta = this.entries.get(infoHash)?.files?.[fileIdx];
      if (!meta) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'arquivo inexistente no torrent' }));
        return;
      }
      const headRange = parseRange(req.headers.range, meta.length);
      if (headRange && headRange.invalid) {
        res.writeHead(416, { 'Content-Range': `bytes */${meta.length}`, 'Content-Length': '0' });
        res.end();
        return;
      }
      const headHeaders = {
        'Content-Type': mimeFor(meta.path),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(headRange ? headRange.end - headRange.start + 1 : meta.length),
        'Cache-Control': 'no-store',
      };
      if (headRange) headHeaders['Content-Range'] = `bytes ${headRange.start}-${headRange.end}/${meta.length}`;
      res.writeHead(headRange ? 206 : 200, headHeaders);
      res.end();
      return;
    }

    const torrent = await this.getTorrent(infoHash);
    // A resposta pode ter sido encerrada durante a espera (revogação ou cliente que saiu): o 'close'
    // já passou e não limparia o contador de streams abertos, que travaria conclusão e ociosidade.
    if (res.destroyed) return;
    // Conta streams abertos: a conclusão em segundo plano só começa com o
    // player parado (e nunca disputa banda com ele).
    this.streams.set(infoHash, (this.streams.get(infoHash) ?? 0) + 1);
    this.vault.markUsed(infoHash); // último uso, para a retenção por idade
    log.debug(`stream aberto em ${short(infoHash)} (${this.streams.get(infoHash)} aberto(s))`);
    res.once('close', () => {
      this.streams.set(infoHash, Math.max(0, (this.streams.get(infoHash) ?? 1) - 1));
      this.lastStreamEnd.set(infoHash, Date.now());
      this.vault.markUsed(infoHash);
      log.debug(`stream encerrado em ${short(infoHash)} (${this.streams.get(infoHash)} aberto(s))`);
    });
    const file = torrent?.files?.[fileIdx];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'arquivo inexistente no torrent' }));
      return;
    }

    const size = file.length;
    const range = parseRange(req.headers.range, size);
    if (range && range.invalid) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
      res.end();
      return;
    }

    // Sem Range, o player quer do início; responder 200 é o esperado.
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const chunkSize = end - start + 1;

    const headers = {
      'Content-Type': mimeFor(file.path),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunkSize),
      'Cache-Control': 'no-store',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

    // Espera o primeiro pedaço antes de responder: se não houver peer, o player
    // recebe 504 em vez de um 206 pendurado para sempre.
    const trace = this.metrics.begin(`${infoHash}:${fileIdx}`, { start });
    res.once('close', () => trace.finish(res.writableFinished ? 'ok' : 'fechado'));
    const stream = file.createReadStream({ start, end });
    const iterator = stream[Symbol.asyncIterator]();

    let first;
    try {
      let timer;
      trace.waiting();
      first = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('sem peers suficientes para o trecho')),
            this.firstByteTimeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (err) {
      trace.timeout();
      // Responde primeiro: com next() pendente, o return() de um iterador assíncrono só termina
      // depois do next(), então esperar por ele aqui impediria o 504 de sair (issue #52).
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message, peers: torrent.numPeers }));
      iterator.return?.().catch(() => {}); // solta a seleção de peças em segundo plano
      return;
    }

    trace.received(first.value?.length ?? 0);
    res.writeHead(range ? 206 : 200, headers);

    // Player fez seek ou fechou: cancela a seleção de peças desse intervalo.
    const onClose = () => {
      iterator.return?.().catch(() => {});
    };
    res.on('close', onClose);

    try {
      if (first.value) res.write(first.value);
      if (!first.done) {
        for (;;) {
          trace.waiting();
          const { value, done } = await iterator.next();
          if (done) { trace.received(0); break; }
          trace.received(value.length);
          if (!res.write(value)) {
            await new Promise((resolve) => res.once('drain', resolve));
          }
        }
      }
      res.end();
    } catch {
      // Seek no meio do stream: encerra sem alarde.
      res.destroy();
    } finally {
      res.off('close', onClose);
    }
  }

  async stop() {
    if (this.seedTimer) clearInterval(this.seedTimer);
    if (this.completeTimer) clearInterval(this.completeTimer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    this.keepAwake?.stop();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    if (this.client) await new Promise((resolve) => this.client.destroy(resolve));
  }
}

module.exports = { Bridge, parseRange, mimeFor };
