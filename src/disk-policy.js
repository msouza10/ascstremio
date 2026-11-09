// Política de disco (issue #26): uma reserva de espaço livre e um orçamento coordenado que valem
// para TODO novo download (streaming sob demanda, conclusão em segundo plano e retomada).
//
// Regras:
//  - Reserva efetiva = a MAIOR entre a reserva absoluta (bytes) e o percentual do volume. Os dois
//    limites coexistem e o mais conservador vence; o percentual exige conhecer o tamanho do volume.
//  - Admissão: livre - reserva - já comprometido por outros downloads >= bytes que este precisa.
//    A conta é síncrona, então dois pedidos simultâneos nunca aprovam a mesma folga.
//  - Medição indisponível = estado "desconhecido": novos downloads são RECUSADOS (fail-closed);
//    seed e arquivos que já existem nunca são tocados por esta política.
//  - Nada aqui apaga arquivo: a retenção é outra funcionalidade (issue #27).

const fs = require('fs');
const path = require('path');

const GIB = 1024 ** 3;
const DEFAULT_RESERVE_BYTES = 2 * GIB;
// Histerese do alerta: entra em "baixo" ao esgotar a folga e só sai com folga renovada,
// para o painel não piscar a cada amostra.
const MIN_HYSTERESIS_BYTES = 256 * 1024 ** 2;
// Uma promessa de espaço cujo torrent ainda não apareceu no motor (o .torrent está chegando ou
// o torrent abrindo) não pode ser descartada logo: expira sozinha depois deste prazo.
const GRACE_MS = 90_000;

class DiskRefusal extends Error {
  constructor(code, message, status, detail) {
    super(message);
    this.name = 'DiskRefusal';
    this.code = code; // 'sem-espaco' | 'medicao-indisponivel'
    this.status = status; // 507 (sem espaço) ou 503 (não deu para medir)
    this.expose = true; // a mensagem é segura e útil para o player/painel
    this.detail = detail;
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const abs = Math.abs(n);
  if (abs >= GIB) return `${(n / GIB).toFixed(1)} GiB`;
  return `${(n / 1024 ** 2).toFixed(0)} MiB`;
}

// Mede o volume que contém `dir` (o BRIDGE_STORE, inclusive disco externo ou montagem).
// Se a pasta ainda não existe, mede o ancestral existente (é o volume onde ela será criada).
// Devolve { free, total }; lança se não houver medida confiável.
function statDir(dir, statfs = fs.statfsSync) {
  let atual = path.resolve(dir);
  for (;;) {
    try {
      const s = statfs(atual);
      const free = Number(s.bavail) * Number(s.bsize);
      const total = Number(s.blocks) * Number(s.bsize);
      if (!Number.isFinite(free) || free < 0) throw new Error('medida inválida');
      // Alguns sistemas (FUSE, rede) respondem tudo zero: não é "disco cheio", é "não sei".
      if (free === 0 && total === 0) throw new Error('sistema de arquivos não informa o espaço');
      return { free, total: Number.isFinite(total) && total > 0 ? total : null };
    } catch (err) {
      const pai = path.dirname(atual);
      if (err?.code === 'ENOENT' && pai !== atual) { atual = pai; continue; }
      throw err;
    }
  }
}

class DiskGuard {
  // `measure(dir)` pode devolver número (só livres) ou { free, total }; lança se não medir.
  constructor({ dir, reserveBytes = DEFAULT_RESERVE_BYTES, reservePercent = 0, measure = null }) {
    for (const [nome, v] of [['reserveBytes', reserveBytes], ['reservePercent', reservePercent]]) {
      if (!Number.isFinite(v) || v < 0) throw new RangeError(`${nome} inválido`);
    }
    if (reservePercent > 100) throw new RangeError('reservePercent inválido');
    this.dir = dir;
    this.reserveBytes = reserveBytes;
    this.reservePercent = reservePercent;
    this.measureFn = measure ?? ((d) => statDir(d));
    this.commitments = new Map(); // holder -> { bytes prometidos na admissão, at }
    this.low = false; // estado do alerta, com histerese
  }

  // { known, free, total, reserve, error }.
  measure() {
    try {
      const m = this.measureFn(this.dir);
      const free = typeof m === 'number' ? m : m.free;
      const total = typeof m === 'number' ? null : (m.total ?? null);
      if (!Number.isFinite(free) || free < 0) throw new Error('medida inválida');
      const reserve = this.effectiveReserve(total);
      // Percentual sem tamanho do volume: não dá para honrar o limite → desconhecido.
      if (reserve === null) return { known: false, free, total, reserve: null, error: 'tamanho do volume indisponível para a reserva percentual' };
      return { known: true, free, total, reserve, error: null };
    } catch (err) {
      return { known: false, free: null, total: null, reserve: null, error: String(err?.message ?? err) };
    }
  }

  effectiveReserve(total) {
    if (this.reservePercent > 0 && !(total > 0)) return null;
    const pct = this.reservePercent > 0 ? (total * this.reservePercent) / 100 : 0;
    return Math.max(this.reserveBytes, Math.ceil(pct));
  }

  // Soma o que os OUTROS downloads ainda vão ocupar. `live(holder)` devolve o que falta agora
  // (número), `null` se o download terminou (a promessa cai), `false` se o torrent não está no
  // motor (cai depois do prazo de tolerância) ou `undefined` se não sabe (vale o prometido).
  // O que já foi gravado já aparece em "livre", então só entra o que falta.
  committed(live = null, except = null, now = Date.now()) {
    let total = 0;
    for (const [holder, c] of [...this.commitments]) {
      const agora = live ? live(holder) : undefined;
      if (agora === null || (agora === false && now - c.at > GRACE_MS)) { this.commitments.delete(holder); continue; }
      if (holder === except) continue;
      total += Number.isFinite(agora) ? Math.max(0, agora) : c.bytes;
    }
    return total;
  }

  // Aprova (e já reserva) ou recusa. `need` = bytes novos que o download ainda vai gravar.
  // Chamada síncrona de ponta a ponta: é isso que torna o orçamento coordenado.
  admit({ holder, need, live = null, reserve = true }) {
    const m = this.measure();
    const committed = this.committed(live, holder);
    const base = { need, committed, free: m.free, total: m.total, reserve: m.reserve };
    if (!m.known) {
      this.updateLow(null);
      return { ok: false, code: 'medicao-indisponivel', ...base, available: null,
        message: `Não foi possível medir o espaço livre do disco (${m.error}). Novos downloads ficam bloqueados até a medição voltar; o que já está em disco segue semeando.` };
    }
    const available = m.free - m.reserve - committed;
    this.updateLow(available, m.reserve);
    if (available < need) {
      return { ok: false, code: 'sem-espaco', ...base, available,
        message: `Espaço insuficiente: este download precisa de ${fmtBytes(need)}, mas há ${fmtBytes(Math.max(0, available))} utilizáveis `
          + `(${fmtBytes(m.free)} livres, reserva ${fmtBytes(m.reserve)}, ${fmtBytes(committed)} já comprometidos com outros downloads). Libere espaço ou ajuste a reserva.` };
    }
    if (reserve && holder) this.commitments.set(holder, { bytes: Math.max(0, need), at: Date.now() });
    return { ok: true, code: 'ok', ...base, available: available - need, message: null };
  }

  // Aprova ou lança DiskRefusal (para o chamador recusar antes de qualquer efeito).
  require(args) {
    const r = this.admit(args);
    if (!r.ok) throw new DiskRefusal(r.code, r.message, r.code === 'sem-espaco' ? 507 : 503, publicDetail(r));
    return r;
  }

  release(holder) { this.commitments.delete(holder); }

  updateLow(available, reserve = 0) {
    if (available === null) return;
    const margem = Math.max(MIN_HYSTERESIS_BYTES, reserve * 0.1);
    if (!this.low && available <= 0) this.low = true;
    else if (this.low && available >= margem) this.low = false;
  }

  // Foto para o painel: limite, livres, reservas e motivo. Sem efeitos (não reserva nada).
  status(live = null) {
    const m = this.measure();
    const committed = this.committed(live, null);
    if (!m.known) {
      return { state: 'unknown', blocked: true, free: m.free, total: m.total, reserveBytes: this.reserveBytes,
        reservePercent: this.reservePercent, reserve: null, committed, available: null,
        reason: `medição indisponível: ${m.error}` };
    }
    const available = m.free - m.reserve - committed;
    this.updateLow(available, m.reserve);
    return { state: this.low ? 'low' : 'ok', blocked: this.low, free: m.free, total: m.total,
      reserveBytes: this.reserveBytes, reservePercent: this.reservePercent, reserve: m.reserve, committed, available,
      reason: this.low ? `espaço abaixo da reserva (${fmtBytes(m.reserve)}) somada ao que os downloads em curso ainda vão ocupar` : null };
  }
}

// Detalhe seguro para devolver ao player: números, nunca caminhos.
function publicDetail(r) {
  return { code: r.code, needBytes: r.need, freeBytes: r.free, reserveBytes: r.reserve, committedBytes: r.committed, availableBytes: r.available };
}

module.exports = { DiskGuard, DiskRefusal, statDir, publicDetail, fmtBytes, GIB, DEFAULT_RESERVE_BYTES };
