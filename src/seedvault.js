// Cofre de seed: guarda em disco quanto cada torrent já semeou, para que a
// regra 13.1 do ASC (72 h após concluir, ou ratio 1.0) seja cumprida mesmo
// com reinícios do processo.
//
// Por que persistir: a obrigação começa quando o download CONCLUI (regra 13.1)
// e dura 72 h, mas a conta só é punida se ficar mais de 12 dias sem semear
// (regra 13.3). Ou seja, o tempo pode ser acumulado em janelas — e um contador
// em memória zera a cada `npm start`, fazendo o usuário achar que cumpriu.
//
// Nada aqui fala com a rede: é contabilidade local. A verdade final é
// myHistory.remainingSeedTime, que o addon consegue ler do tracker.

const fs = require('fs');
const path = require('path');
const log = require('./logger').logger.child('vault');
const label = (e) => String(e?.displayName ?? e?.name ?? e?.infoHash ?? '?').slice(0, 50);

const DEFAULT_REQUIRED_HOURS = 72;

class SeedVault {
  constructor({ file, requiredHours = DEFAULT_REQUIRED_HOURS, now = () => Date.now() }) {
    this.file = file;
    this.requiredMs = requiredHours * 3600 * 1000;
    this.now = now;
    this.entries = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const entry of raw.entries ?? []) {
        if (entry && entry.infoHash) this.entries.set(entry.infoHash, { ...entry });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[vault] estado anterior ilegível; começando vazio');
      }
    }
  }

  save() {
    const payload = { version: 1, requiredHours: this.requiredMs / 3600000, entries: this.list() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Registra que o torrent entrou no swarm (cria o registro se não existir).
  markSeen(infoHash, meta = {}) {
    const existing = this.entries.get(infoHash);
    if (!existing) log.info(`registrado no cofre: ${String(meta.name ?? infoHash).slice(0, 50)}`, { infoHash });
    const current = existing ?? {
      infoHash,
      firstSeenAt: this.now(),
      seedMs: 0,
      completedAt: null,
      satisfiedAt: null,
      ratioMet: false,
      torrentPath: null,
      announceBase: null,
      name: null,
    };
    Object.assign(current, {
      ...meta,
      lastSeenAt: this.now(),
    });
    this.entries.set(infoHash, current);
    this.save();
    return current;
  }

  // Marca que o usuário pediu para concluir o download em segundo plano. É
  // persistido para o próximo start retomar a conclusão.
  setBackground(infoHash, enabled) {
    const entry = this.entries.get(infoHash);
    if (!entry) return null;
    if (entry.backgroundComplete !== Boolean(enabled)) log.info(`conclusão em segundo plano ${enabled ? 'ativada' : 'desativada'} para "${label(entry)}"`, { infoHash });
    entry.backgroundComplete = Boolean(enabled);
    this.save();
    return entry;
  }

  // Título legível dado pelo tracker (o nome do arquivo costuma ser "The.Skin.I.Live.In.2011...").
  setDisplayName(infoHash, name) {
    const entry = this.entries.get(infoHash);
    const clean = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    if (!entry || !clean || entry.displayName === clean) return entry ?? null;
    entry.displayName = clean;
    this.save();
    return entry;
  }

  // Marca se o release é freeleech (informado pela página do torrent no tracker).
  setFreeleech(infoHash, value) {
    const entry = this.entries.get(infoHash);
    if (!entry || entry.freeleech === value) return entry ?? null;
    entry.freeleech = value;
    this.save();
    return entry;
  }

  // Registra que o torrent já cumpriu o limite e foi liberado (rede e, conforme
  // a política, disco).
  markReleased(infoHash, mode) {
    const entry = this.entries.get(infoHash);
    if (!entry) return null;
    entry.releasedAt = this.now();
    entry.releasedAs = mode;
    log.info(`liberado (${mode}): "${label(entry)}"`, { infoHash });
    this.save();
    return entry;
  }

  // Último uso (reprodução) do título, para a retenção por idade. Atualiza em memória sempre e
  // grava no máximo uma vez por minuto: um seek não pode virar uma escrita do cofre inteiro.
  markUsed(infoHash) {
    const entry = this.entries.get(infoHash);
    if (!entry) return null;
    const agora = this.now();
    const antes = entry.lastUsedAt ?? 0;
    entry.lastUsedAt = agora;
    if (agora - antes >= 60_000) this.save();
    return entry;
  }

  // Só chamado quando o motor confirma 100% — é o gatilho da regra 13.1.
  markCompleted(infoHash) {
    const entry = this.entries.get(infoHash) ?? this.markSeen(infoHash);
    if (!entry.completedAt) {
      entry.completedAt = this.now();
      log.info(`download concluído: obrigação de ${this.requiredMs / 3_600_000} h aberta para "${label(entry)}"`, { infoHash });
    }
    this.save();
    return entry;
  }

  // Acumula tempo de seed. Só conta se o download foi concluído.
  addSeedingTime(infoHash, ms) {
    const entry = this.entries.get(infoHash);
    if (!entry || !entry.completedAt || entry.satisfiedAt || ms <= 0) return entry ?? null;
    entry.seedMs += ms;
    entry.lastSeenAt = this.now();
    if (entry.seedMs >= this.requiredMs) {
      entry.seedMs = this.requiredMs;
      // Torrent conferido no tracker: só ele declara a obrigação cumprida
      // (o tempo local pode incluir announces que não foram creditados).
      if (!entry.tracker) { entry.satisfiedAt = this.now(); log.info(`obrigação cumprida (estimativa local) em "${label(entry)}"`, { infoHash }); }
      else log.info(`tempo local de ${this.requiredMs / 3_600_000} h completo em "${label(entry)}"; aguardando o tracker confirmar`, { infoHash });
    }
    this.save();
    return entry;
  }

  // Alternativa legítima da 13.1: ratio 1.0 no próprio torrent.
  markRatioMet(infoHash, ratio) {
    const entry = this.entries.get(infoHash);
    if (!entry) return null;
    if (ratio >= 1) {
      if (!entry.ratioMet) log.info(`ratio 1.0 atingido em "${label(entry)}" (${ratio.toFixed(2)})`, { infoHash });
      entry.ratioMet = true;
      if (!entry.tracker) entry.satisfiedAt = entry.satisfiedAt ?? this.now();
      this.save();
    }
    return entry;
  }

  // Grava o `myHistory` do tracker e alinha o cofre a ele: o tracker vence.
  // `snapshot` vem de hnr-guard.normalizeHistory.
  setTracker(infoHash, snapshot) {
    const entry = this.entries.get(infoHash);
    if (!entry || !snapshot) return null;
    const before = { sat: Boolean(entry.satisfiedAt), hnr: Boolean(entry.tracker?.hitAndRun), done: Boolean(entry.completedAt) };
    entry.tracker = { ...snapshot, checkedAt: this.now() };
    if (snapshot.completedAtMs !== null) {
      // Concluído (talvez em outra sessão ou cliente): a obrigação existe.
      entry.completedAt = entry.completedAt ?? snapshot.completedAtMs;
      if (snapshot.satisfied) {
        entry.satisfiedAt = entry.satisfiedAt ?? this.now();
        entry.seedMs = this.requiredMs;
      } else {
        entry.satisfiedAt = null;
        if (snapshot.remainingMs !== null) {
          entry.seedMs = Math.min(this.requiredMs, Math.max(0, this.requiredMs - snapshot.remainingMs));
        }
      }
    }
    this.save();
    const resumo = { status: snapshot.status, restanteH: snapshot.remainingMs === null ? null : Number((snapshot.remainingMs / 3_600_000).toFixed(2)), cumprido: snapshot.satisfied, hitAndRun: snapshot.hitAndRun };
    if (snapshot.hitAndRun && !before.hnr) log.error(`hit-and-run registrado pelo tracker em "${label(entry)}"`, { infoHash, ...resumo });
    else if (Boolean(entry.satisfiedAt) !== before.sat) log.info(`tracker ${entry.satisfiedAt ? 'confirmou o cumprimento' : 'reabriu a obrigação'} de "${label(entry)}"`, { infoHash, ...resumo });
    else if (!before.done && entry.completedAt) log.info(`tracker mostra "${label(entry)}" como concluído`, { infoHash, ...resumo });
    else log.debug(`tracker conferido: "${label(entry)}"`, { infoHash, ...resumo });
    return entry;
  }

  setSeedChoice(infoHash, choice) {
    const entry = this.entries.get(infoHash);
    if (!entry) return;
    entry.seedChoice = choice;
    this.save();
  }

  get(infoHash) {
    return this.entries.get(infoHash) ?? null;
  }

  list() {
    return [...this.entries.values()].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  }

  // Precisa continuar semeando? (concluído e ainda não satisfeito)
  needsSeed(infoHash) {
    const entry = this.entries.get(infoHash);
    return Boolean(entry && entry.completedAt && !entry.satisfiedAt);
  }

  // Quanto falta, em ms.
  remainingMs(infoHash) {
    const entry = this.entries.get(infoHash);
    if (!entry || !entry.completedAt) return this.requiredMs;
    if (entry.satisfiedAt) return 0;
    return Math.max(0, this.requiredMs - entry.seedMs);
  }

  // Prazo da regra 13.3: 12 dias após o último contato, o que não cumprir vira HnR.
  deadlineMs(infoHash, graceDays = 12) {
    const entry = this.entries.get(infoHash);
    if (!entry) return null;
    // O tracker informa o prazo exato (último announce + 12 dias).
    if (entry.tracker?.deadlineMs) return entry.tracker.deadlineMs;
    return (entry.lastSeenAt ?? entry.firstSeenAt) + graceDays * 86400000;
  }

  summary() {
    const pendentes = this.list().filter((e) => e.completedAt && !e.satisfiedAt);
    return {
      total: this.entries.size,
      pendentes: pendentes.length,
      horasPendentes: Number(
        (pendentes.reduce((acc, e) => acc + (this.requiredMs - e.seedMs), 0) / 3600000).toFixed(2),
      ),
      satisfeitos: this.list().filter((e) => e.satisfiedAt).length,
    };
  }
}

module.exports = { SeedVault, DEFAULT_REQUIRED_HOURS };
