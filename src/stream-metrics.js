// Medição leve da reprodução (issue #33): tempo até o primeiro byte, stalls, seeks e 504 por timeout.
// Mede antes de ajustar: o módulo NÃO muda antecipação de leitura, buffer nem timeouts, só observa.
// É puro: relógio e log são injetados, não toca disco nem rede e não guarda segredo, caminho, nome
// de arquivo, IP nem infoHash (a chave da sessão é opaca para quem lê o snapshot e os logs).
//
// Definições (as mesmas do docs/manutencao.md):
//   primeiro byte  tempo entre abrir a resposta de vídeo e o primeiro trecho vindo do torrent;
//   stall          espera >= stallMs por dados do torrent DEPOIS do primeiro byte, durante a mesma
//                  resposta. A espera pelo cliente HTTP (backpressure/drain) NÃO conta: o gargalo
//                  seria o player ou a rede local, não o swarm;
//   seek           nova resposta (Range) cujo início fica a mais de seekBytes da posição onde a
//                  resposta anterior do mesmo arquivo parou (avanço ou recuo);
//   504            primeiro trecho não chegou em firstByteTimeoutMs (comportamento atual da ponte).

const MiB = 1024 * 1024;
const BUCKETS_MS = Object.freeze([100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000]);
const KINDS = Object.freeze(['inicial', 'continuo', 'avanco', 'recuo']);

class Histogram {
  constructor() {
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.counts = new Array(BUCKETS_MS.length + 1).fill(0);
  }

  add(ms) {
    const v = Math.max(0, Math.round(ms));
    this.count++;
    this.sum += v;
    if (v > this.max) this.max = v;
    let i = BUCKETS_MS.findIndex((b) => v <= b);
    if (i < 0) i = BUCKETS_MS.length;
    this.counts[i]++;
  }

  // Percentil ESTIMADO pelo limite superior da faixa (nunca acima do máximo observado).
  percentile(p) {
    if (!this.count) return null;
    const alvo = Math.ceil(this.count * p);
    let acc = 0;
    for (let i = 0; i < this.counts.length; i++) {
      acc += this.counts[i];
      if (acc >= alvo) return i < BUCKETS_MS.length ? Math.min(BUCKETS_MS[i], this.max) : this.max;
    }
    return this.max;
  }

  snapshot() {
    return {
      count: this.count,
      totalMs: this.sum,
      maxMs: this.max,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      // Contagem por faixa: [<=100, <=250, ..., <=60000, acima].
      buckets: [...this.counts],
    };
  }
}

// Uma resposta de vídeo. Os métodos são baratos e idempotentes onde importa (finish).
class StreamTrace {
  constructor(owner, session, info) {
    this.owner = owner;
    this.session = session;
    this.kind = info.kind;
    this.start = info.start;
    this.openedAt = owner.now();
    this.waitingSince = null;
    this.firstByteMs = null;
    this.bytes = 0;
    this.stalls = 0;
    this.stallMs = 0;
    this.maxStallMs = 0;
    this.done = false;
  }

  // Chamar logo antes de pedir o próximo trecho ao torrent.
  waiting() {
    if (!this.done) this.waitingSince = this.owner.now();
  }

  // Chamar quando um trecho do torrent chegou (bytes = tamanho dele).
  received(bytes) {
    if (this.done) return;
    const t = this.owner.now();
    if (this.firstByteMs === null) {
      this.firstByteMs = t - this.openedAt;
      this.owner.ttfb.add(this.firstByteMs);
      this.session.ttfbMaxMs = Math.max(this.session.ttfbMaxMs, this.firstByteMs);
    } else if (this.waitingSince !== null) {
      this.closeStall(t - this.waitingSince, false);
    }
    this.waitingSince = null;
    this.bytes += bytes;
    this.session.pos = this.start + this.bytes;
    this.owner.bytes += bytes;
  }

  closeStall(ms, abandoned) {
    if (ms < this.owner.stallThresholdMs) return;
    this.stalls++;
    this.stallMs += ms;
    this.maxStallMs = Math.max(this.maxStallMs, ms);
    this.session.stalls++;
    this.owner.stallHist.add(ms);
    if (abandoned) this.owner.abandonedStalls++;
  }

  // O primeiro trecho não chegou a tempo e a ponte respondeu 504.
  timeout() {
    if (this.done) return;
    this.owner.timeouts++;
    this.session.timeouts++;
    this.finish('504');
  }

  // outcome: 'ok' (resposta completa), 'fechado' (player fechou/seek), 'erro' ou '504'.
  finish(outcome = 'ok') {
    if (this.done) return;
    // Fechou esperando dados por mais que o limite: o stall existiu, mesmo sem a chegada.
    if (this.waitingSince !== null && this.firstByteMs !== null) {
      this.closeStall(this.owner.now() - this.waitingSince, true);
    }
    this.done = true;
    this.waitingSince = null;
    this.owner.active.delete(this);
    this.session.open = Math.max(0, this.session.open - 1);
    this.session.lastAt = this.owner.now();
    this.owner.outcomes[outcome] = (this.owner.outcomes[outcome] ?? 0) + 1;
    const fields = {
      sessao: this.session.id,
      seek: this.kind,
      resultado: outcome,
      primeiroByteMs: this.firstByteMs === null ? null : Math.round(this.firstByteMs),
      bytes: this.bytes,
      stalls: this.stalls,
      stallTotalMs: Math.round(this.stallMs),
      stallMaxMs: Math.round(this.maxStallMs),
    };
    const notable = this.stalls > 0 || outcome === '504' || this.kind === 'avanco' || this.kind === 'recuo';
    this.owner.log?.[notable ? 'info' : 'debug']?.('reprodução: resposta encerrada', fields);
  }
}

class StreamMetrics {
  constructor({ now = () => performance.now(), log = null, stallMs = 2000, seekBytes = 4 * MiB, maxSessions = 32, idleMs = 30 * 60_000 } = {}) {
    this.now = now;
    this.log = log;
    this.stallThresholdMs = stallMs;
    this.seekBytes = seekBytes;
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.sessions = new Map(); // chave opaca -> estado da sessão de reprodução
    this.active = new Set();
    this.nextId = 1;
    this.requests = 0;
    this.kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
    this.outcomes = {};
    this.timeouts = 0;
    this.abandonedStalls = 0;
    this.bytes = 0;
    this.ttfb = new Histogram();
    this.stallHist = new Histogram();
  }

  // `key` identifica o arquivo (a ponte passa algo como infoHash:índice). Ele fica só na memória,
  // nunca vai ao snapshot nem ao log: lá aparece um número de sessão sequencial.
  begin(key, { start } = {}) {
    this.prune();
    let session = this.sessions.get(key);
    let kind = 'inicial';
    if (session) {
      const delta = start - session.pos;
      kind = Math.abs(delta) <= this.seekBytes ? 'continuo' : delta > 0 ? 'avanco' : 'recuo';
      this.sessions.delete(key); // reinsere no fim: o Map guarda a ordem de uso
    } else {
      session = { id: this.nextId++, pos: start, requests: 0, seeks: 0, stalls: 0, timeouts: 0, ttfbMaxMs: 0, open: 0, lastAt: 0 };
    }
    this.sessions.set(key, session);
    session.requests++;
    session.open++;
    session.lastAt = this.now();
    session.pos = start;
    if (kind === 'avanco' || kind === 'recuo') session.seeks++;
    this.requests++;
    this.kinds[kind]++;
    const trace = new StreamTrace(this, session, { kind, start });
    this.active.add(trace);
    return trace;
  }

  // Descarta sessões ociosas (sem resposta aberta) e limita a memória; o resumo vai ao log.
  prune() {
    const t = this.now();
    for (const [key, s] of this.sessions) {
      if (s.open !== 0) continue;
      if (t - s.lastAt > this.idleMs || this.sessions.size > this.maxSessions) {
        this.sessions.delete(key);
        this.log?.info?.('reprodução: sessão encerrada', {
          sessao: s.id, respostas: s.requests, seeks: s.seeks, stalls: s.stalls, timeouts504: s.timeouts, primeiroByteMaxMs: Math.round(s.ttfbMaxMs),
        });
      }
    }
  }

  snapshot() {
    const t = this.now();
    let stalledNow = 0;
    for (const tr of this.active) {
      if (tr.waitingSince !== null && tr.firstByteMs !== null && t - tr.waitingSince >= this.stallThresholdMs) stalledNow++;
    }
    return {
      thresholds: { stallMs: this.stallThresholdMs, seekBytes: this.seekBytes, bucketsMs: [...BUCKETS_MS] },
      responses: this.requests,
      open: this.active.size,
      stalledNow,
      kinds: { ...this.kinds },
      outcomes: { ...this.outcomes },
      timeouts504: this.timeouts,
      bytes: this.bytes,
      firstByte: this.ttfb.snapshot(),
      stalls: { ...this.stallHist.snapshot(), abandoned: this.abandonedStalls },
      sessions: [...this.sessions.values()].slice(-8).map((s) => ({
        id: s.id, responses: s.requests, seeks: s.seeks, stalls: s.stalls, timeouts504: s.timeouts, firstByteMaxMs: Math.round(s.ttfbMaxMs), open: s.open,
      })),
    };
  }
}

module.exports = { StreamMetrics, Histogram, BUCKETS_MS, KINDS };
