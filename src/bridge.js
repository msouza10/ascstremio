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
const hnr = require('./hnr-guard');
const { logger } = require('./logger');
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
    accessKey = null, // chave nas URLs de stream (?k=): barra CSRF e páginas web que adivinham /a/<id>
    strictHost = false, // recusa Host que não seja IP/localhost (anti DNS rebinding)
    firstByteTimeoutMs = 60000,
    passkey = null,
    uploadLimit = -1,
    announceBase = null,
    vault = null,
    accountNotice = null,
    trackerCheck = null,
    backgroundMode = 'off',
    idleMs = 10 * 60 * 1000,
    minFreeBytes = 2 * 1024 ** 3,
    freeSpace = null,
    afterSeed = 'delete',
    keepAwake = null,
    resumeOnStart = true,
    ascResolver = null,
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
    this.freeSpace = freeSpace ?? ((dir) => {
      const s = fs.statfsSync(dir);
      return s.bavail * s.bsize;
    });
    // O que fazer quando o limite (72 h ou ratio 1.0) é cumprido e o tracker
    // confirma: delete = encerra e apaga os dados; stop = encerra e mantém os
    // dados; keep = continua semeando.
    this.afterSeed = afterSeed;
    // Opcional: objeto com update(boolean) que impede a suspensão do PC.
    this.keepAwake = keepAwake;
    // false = start() não espera os torrents pendentes abrirem (quem chama faz
    // resumePending() depois); a verificação de dezenas de GB atrasaria o painel.
    this.resumeOnStart = resumeOnStart;
    // `async (ascId) => ({ infoHash, fileIdx })`: baixa o .torrent do release SÓ no
    // momento do play (GET em /a/<id>) e o registra na biblioteca. Vem do provedor ASC.
    this.ascResolver = ascResolver;
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
    this.accessKey = accessKey;
    this.strictHost = strictHost;
    this.firstByteTimeoutMs = firstByteTimeoutMs;
    // Credencial em memória: os .torrent em disco ficam sem token.
    this.passkey = passkey;
    this.uploadLimit = uploadLimit;
    // Base usada quando o .torrent foi gravado sem announce (`--strip`).
    this.announceBase = announceBase;
    // Contabilidade persistente da regra 13.1 (72 h de seed após concluir).
    this.vault = vault ?? new SeedVault({
      file: path.join(storeDir, '..', 'seed-vault.json'),
    });
    this.seedTimer = null;
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
          res.writeHead(err.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (!res.writableEnded) res.end(JSON.stringify({ error: 'Falha ao preparar streaming' }));
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
  // obrigações que o cofre ainda não conhecia.
  async resumePending() {
    const pendencias = this.vault.list().filter((e) => (
      (e.completedAt && !e.satisfiedAt) || (e.backgroundComplete && !e.completedAt)
    ));
    for (const pendencia of pendencias) {
      if (!this.entries.has(pendencia.infoHash)) continue;
      if (this.client.torrents.some((t) => t.infoHash === pendencia.infoHash)) continue;
      // Obrigação concluída mas sem o arquivo completo: não anuncia (viraria um
      // download novo). Aparece no painel como "Sem arquivo para semear".
      if (pendencia.completedAt && !pendencia.backgroundComplete && this.diskState(pendencia.infoHash) !== 'full') {
        if (!pendencia.noDataWarned) {
          console.warn(`[vault] sem o arquivo completo de "${String(pendencia.name).slice(0, 40)}": não dá para semear`);
          pendencia.noDataWarned = true;
        }
        continue;
      }
      try {
        await this.getTorrent(pendencia.infoHash);
        console.log(`[vault] retomando seed: ${String(pendencia.name).slice(0, 50)}`);
      } catch {
        console.error('[vault] não foi possível retomar um seed pendente');
      }
    }
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

      const restante = Math.max(0, (torrent.length || 0) - (torrent.downloaded || 0));
      let livre = Infinity;
      try { livre = this.freeSpace(this.storeDir); } catch { /* sem como medir: segue */ }
      if (livre < restante + this.minFreeBytes) {
        if (!entry?.noSpaceWarned) {
          console.warn(`[conclusão] espaço insuficiente para concluir "${String(torrent.name).slice(0, 40)}"`
            + ` (faltam ${(restante / 1024 ** 3).toFixed(1)} GB, livres ${(livre / 1024 ** 3).toFixed(1)} GB)`);
          if (entry) entry.noSpaceWarned = true;
        }
        continue;
      }

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
  async releaseSatisfied() {
    const released = [];
    if (this.afterSeed === 'keep' || !this.client) return released;
    for (const torrent of [...this.client.torrents]) {
      const hash = torrent.infoHash;
      const entry = this.vault.get(hash);
      if (!entry?.satisfiedAt || !entry.tracker?.satisfied) continue;
      if ((this.streams.get(hash) ?? 0) > 0) continue;
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
    let freeBytes = null;
    try { freeBytes = this.freeSpace(this.storeDir); } catch { /* sem como medir */ }

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
      },
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

  keyQuery() { return this.accessKey ? `?k=${this.accessKey}` : ''; }

  keyOk(url) {
    if (!this.accessKey) return true;
    const given = Buffer.from(url.searchParams.get('k') ?? '');
    const want = Buffer.from(this.accessKey);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async getTorrent(infoHash) {
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

    // Rotas administrativas: só desta máquina e nunca a partir de uma página web
    // (navegadores enviam Origin em POST/fetch entre origens, o que bloquearia
    // um site qualquer de disparar /cleanup?force=1 no seu computador).
    const admin = ['/cleanup', '/seed-status', '/status', '/complete'].includes(url.pathname);
    if (admin && (!isLoopbackRequest(req) || req.headers?.origin)) {
      log.warn(`rota administrativa recusada: ${req.method} ${url.pathname} (origem ${req.socket?.remoteAddress ?? '?'}${req.headers?.origin ? `, Origin ${req.headers.origin}` : ''})`);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'rota administrativa: só local, fora de navegador' }));
      return;
    }

    if (url.pathname === '/cleanup' && req.method === 'POST') {
      // Regra 13.1 do ASC: depois de baixar, semear por 72 h ou até o ratio
      // 1.0 no torrent, o que vier primeiro. Encerrar antes disso é o caminho
      // para hit-and-run (13.3/13.4), então só remove quem já cumpriu.
      // use ?force=1 para ignorar a checagem (assumindo o risco).
      const victim = url.searchParams.get('hash');
      const force = url.searchParams.get('force') === '1';
      log.info(`cleanup pedido${victim ? ` para ${short(victim)}` : ' para todos'}${force ? ' com force=1' : ''}`);
      const targets = victim
        ? this.client.torrents.filter((t) => t.infoHash === victim.toLowerCase())
        : this.client.torrents;

      const blocked = [];
      if (!force) {
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
      }

      await Promise.all(targets.map((t) => new Promise((resolve) => {
        t.destroy({ destroyStore: true }, () => resolve());
      })));
      for (const t of targets) this.startedAt.delete(t.infoHash);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      log.info(`cleanup concluído: ${targets.length} torrent(s) removido(s)${force ? ' (force)' : ''}`);
      res.end(JSON.stringify({ removed: targets.length, forced: force }));
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
    if ((m || lazy) && !this.keyOk(url)) {
      log.warn(`${req.method} ${url.pathname.replace(/[0-9a-f]{40}/i, (h) => short(h))} recusado: chave de acesso ausente ou errada`);
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'chave de acesso ausente: reabra a fonte pelo Stremio' }));
      return;
    }
    if (!m && !lazy) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'rota desconhecida' }));
      return;
    }

    let infoHash = m ? m[1].toLowerCase() : null;
    let fileIdx = m ? (m[2] === undefined ? 0 : Number(m[2])) : 0;

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
        try {
          ({ infoHash, fileIdx } = await this.ascResolver(ascId));
        } catch (err) {
          const status = Number.isInteger(err?.status) ? err.status : 502;
          log.warn(`play de #${ascId} recusado (${status}): ${err?.message ?? err}`);
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err?.message || 'Não foi possível preparar o filme.' }));
          return;
        }
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
    // Conta streams abertos: a conclusão em segundo plano só começa com o
    // player parado (e nunca disputa banda com ele).
    this.streams.set(infoHash, (this.streams.get(infoHash) ?? 0) + 1);
    log.debug(`stream aberto em ${short(infoHash)} (${this.streams.get(infoHash)} aberto(s))`);
    res.once('close', () => {
      this.streams.set(infoHash, Math.max(0, (this.streams.get(infoHash) ?? 1) - 1));
      this.lastStreamEnd.set(infoHash, Date.now());
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
    const stream = file.createReadStream({ start, end });
    const iterator = stream[Symbol.asyncIterator]();

    let first;
    try {
      let timer;
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
      await iterator.return?.().catch(() => {});
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message, peers: torrent.numPeers }));
      return;
    }

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
          const { value, done } = await iterator.next();
          if (done) break;
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
    this.keepAwake?.stop();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    if (this.client) await new Promise((resolve) => this.client.destroy(resolve));
  }
}

module.exports = { Bridge, parseRange, mimeFor };
