// Retenção por orçamento (issue #27): prévia e execução confirmada, sobre a ponte.
//
// Não é um segundo caminho de limpeza. Reaproveita a mesma noção de "liberado" de
// releaseSatisfied()/cleanup: o título só é candidato se o TRACKER confirmou o seed (13.1). A
// retenção acrescenta condições (sem uso, parado há dias, arquivos seguros) e nunca relaxa as
// anteriores. Falta de dado = não remove (fail-closed).
//
// Modos (RETENTION_MODE): off (padrão) não calcula nem remove; preview habilita a prévia e a
// execução MANUAL e confirmada (plano emitido pela prévia). Não existe modo automático: remover
// arquivos sem alguém ter visto a lista foi considerado arriscado demais para esta versão.
//
// Execução: (1) relê o tracker à força para os candidatos da prévia, e falha inteira se não der;
// (2) recalcula tudo; (3) para cada título, na ordem da prévia, reconfere de forma síncrona e só
// então o marca como "em manutenção" (play recebe 503 até terminar); (4) encerra o torrent sem
// apagar pelo motor e remove somente os arquivos que o .torrent lista, um a um, dentro do store.

const crypto = require('crypto');
const { logger } = require('./logger');
const hnr = require('./hnr-guard');
const retention = require('./retention');

const log = logger.child('retencao');
const short = (hash) => `${String(hash).slice(0, 8)}…`;
const PLAN_TTL_MS = 10 * 60_000;
const MAX_PLANS = 5;

function fmtBytes(n) {
  if (n >= retention.GIB) return `${(n / retention.GIB).toFixed(1)} GiB`;
  return `${(n / 1024 ** 2).toFixed(0)} MiB`;
}

class Retention {
  constructor(bridge, { mode = 'off', budgetBytes = 0, maxTitles = 0, minAgeDays = 30 } = {}) {
    this.bridge = bridge;
    this.mode = mode === 'preview' ? 'preview' : 'off';
    this.budgetBytes = Math.max(0, Number(budgetBytes) || 0);
    this.maxTitles = Math.max(0, Math.trunc(Number(maxTitles) || 0));
    this.minAgeDays = Math.max(1, Number(minAgeDays) || 30);
    this.retiring = new Set(); // infoHash em remoção agora: play recusa com 503
    this.plans = new Map(); // id -> { hashes, at }
    this.busy = false;
  }

  isRetiring(infoHash) { return this.retiring.has(infoHash); }

  policy() {
    return { mode: this.mode, budgetGiB: this.budgetBytes / retention.GIB, maxTitles: this.maxTitles, minAgeDays: this.minAgeDays };
  }

  get now() { return this.bridge.vault.now(); }

  // Avalia UM título (síncrono: nenhuma espera entre ler o estado e agir sobre ele).
  // `since`: instante a partir do qual a conferência do tracker conta como "fresca" (null = só prévia).
  evaluate(infoHash, rootReal, since = null) {
    const b = this.bridge;
    const lib = b.entries.get(infoHash);
    const entry = b.vault.get(infoHash);
    const files = (lib?.files ?? []).map((f) => f.path);
    let bytes = 0;
    let unsafe = null;
    for (const rel of files) {
      const info = retention.inspectFile(rootReal, rel);
      if (!info.ok) { unsafe = info.reason; break; }
      bytes += info.bytes;
    }
    const base = { infoHash, name: String(entry?.displayName ?? entry?.name ?? lib?.title ?? lib?.name ?? infoHash).slice(0, 80), bytes, files, lastUse: 0, eligible: false, reason: null };
    if (unsafe) return { ...base, reason: `arquivo-inseguro:${unsafe}` };
    if (bytes === 0) return { ...base, reason: 'sem-dados-em-disco' };
    if (!entry) return { ...base, reason: 'sem-registro-no-cofre' };
    const t = this.now;
    const lastUse = Math.max(entry.lastUsedAt ?? 0, entry.satisfiedAt ?? 0, entry.completedAt ?? 0, entry.firstSeenAt ?? 0, b.lastStreamEnd.get(infoHash) ?? 0);
    base.lastUse = lastUse;
    // Obrigação e confirmação do tracker: as mesmas de releaseSatisfied().
    if (!entry.completedAt) return { ...base, reason: 'incompleto' };
    if (entry.tracker?.hitAndRun) return { ...base, reason: 'hit-and-run' };
    if (!hnr.trackerConfirmed(entry)) return { ...base, reason: 'obrigacao-aberta' };
    const ascId = hnr.ascIdFromPath(entry.torrentPath ?? lib?.torrentPath);
    if (!ascId) return { ...base, reason: 'sem-id-no-tracker' };
    if ((b.trackerPending ?? []).some((p) => String(p.ascId) === ascId)) return { ...base, reason: 'tracker-ainda-cobra' };
    if (since !== null && !(entry.tracker.checkedAt >= since)) return { ...base, reason: 'tracker-nao-revalidado' };
    // Uso pendente.
    if ((b.streams.get(infoHash) ?? 0) > 0) return { ...base, reason: 'reproducao-ativa' };
    if (b.limiter.hasKeyPrefix(`s:${infoHash}:`)) return { ...base, reason: 'sessao-recente' };
    if (b.loading.has(infoHash) || this.retiring.has(infoHash)) return { ...base, reason: 'em-andamento' };
    if (b.completing.has(infoHash) || (entry.backgroundComplete && !entry.satisfiedAt)) return { ...base, reason: 'conclusao-em-andamento' };
    const torrent = b.client?.torrents?.find((x) => x.infoHash === infoHash);
    if (torrent && (!torrent.ready || !torrent.done)) return { ...base, reason: 'em-andamento' };
    // Conteúdo recém-confirmado ou usado há pouco.
    if (t - (entry.satisfiedAt ?? 0) < retention.SAFETY_MS) return { ...base, reason: 'recem-confirmado' };
    if (t - lastUse < this.minAgeDays * retention.DAY_MS) return { ...base, reason: 'uso-recente' };
    // Arquivo compartilhado com outro título da biblioteca: quem mais o usa pode ter obrigação.
    for (const [other, olib] of b.entries) {
      if (other === infoHash) continue;
      const theirs = new Set((olib.files ?? []).map((f) => retention.safeRelative(f.path)));
      if (files.some((f) => theirs.has(retention.safeRelative(f)))) return { ...base, reason: 'arquivo-compartilhado' };
    }
    return { ...base, eligible: true };
  }

  // Calcula o plano completo. Síncrono.
  compute(since = null) {
    const rootReal = retention.realRoot(this.bridge.storeDir);
    const items = [...this.bridge.entries.keys()].map((h) => this.evaluate(h, rootReal, since));
    const sel = retention.select(items, { budgetBytes: this.budgetBytes, maxTitles: this.maxTitles });
    return { items, sel };
  }

  publicCandidate(c) {
    return {
      infoHash: c.infoHash, nome: c.name, bytes: c.bytes, motivo: c.motivo,
      ultimoUso: new Date(c.lastUse).toISOString(), idadeDias: Number(((this.now - c.lastUse) / retention.DAY_MS).toFixed(1)),
    };
  }

  // Prévia: só leitura, sem rede e sem remover. Se há o que fazer e a meta é alcançável, devolve um
  // `plano` (id) que a execução exige.
  preview() {
    const base = { modo: this.mode, politica: this.policy(), geradoEm: new Date(this.now).toISOString() };
    if (this.mode === 'off') return { ...base, desligada: true, candidatos: [], bytesEstimados: 0, executavel: false, plano: null, avisos: ['retenção desligada (RETENTION_MODE=off)'] };
    let comp;
    try { comp = this.compute(null); } catch (err) {
      log.warn(`prévia indisponível: ${err?.message ?? err}`);
      return { ...base, candidatos: [], bytesEstimados: 0, executavel: false, plano: null, avisos: ['não foi possível ler o armazenamento; nada será removido'] };
    }
    const { items, sel } = comp;
    const avisos = [];
    if (sel.note === 'sem-limite') avisos.push('defina RETENTION_BUDGET_GIB ou RETENTION_MAX_TITLES: sem limite a retenção não seleciona nada');
    if (sel.note === 'dentro-do-orcamento') avisos.push('a biblioteca já cabe no orçamento; nada a remover');
    if (sel.note === 'inalcancavel') {
      avisos.push(`orçamento inalcançável só com títulos elegíveis (faltam ${fmtBytes(sel.missingBytes)} e ${sel.missingTitles} título(s)); nenhuma execução é oferecida`);
    }
    const orfao = this.bridge.diskUsage?.(this.now)?.orphan ?? 0;
    if (orfao > 0) avisos.push(`${fmtBytes(orfao)} em arquivos fora da biblioteca ocupam o armazenamento; a retenção não os remove (orfandade não autoriza exclusão)`);
    const executavel = sel.candidates.length > 0 && sel.reached;
    let plano = null;
    if (executavel) {
      plano = crypto.randomBytes(6).toString('hex');
      for (const [id, p] of this.plans) if (this.now - p.at > PLAN_TTL_MS) this.plans.delete(id);
      while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value);
      this.plans.set(plano, { hashes: sel.candidates.map((c) => c.infoHash), at: this.now });
    }
    const protegidos = items.filter((i) => !i.eligible && (i.bytes > 0 || String(i.reason).startsWith('arquivo-inseguro'))).slice(0, 200)
      .map((i) => ({ infoHash: i.infoHash, nome: i.name, bytes: i.bytes, motivo: i.reason }));
    return {
      ...base,
      totalBytes: sel.totalBytes, totalTitulos: sel.totalTitles,
      candidatos: sel.candidates.map((c) => this.publicCandidate(c)),
      bytesEstimados: sel.bytes, alvoAtingido: sel.reached, executavel, plano,
      validadeMinutos: PLAN_TTL_MS / 60_000,
      protegidos, avisos,
      observacao: 'bytes são estimativas (blocos alocados); a execução relê o tracker e reconfere cada título',
    };
  }

  fail(status, error, extra = {}) {
    const err = new Error(error);
    err.status = status;
    err.expose = true;
    Object.assign(err, { body: { removidos: [], ignorados: [], bytesLiberados: 0, ...extra } });
    return err;
  }

  // Execução confirmada. Lança erro com `status`/`body` quando não deve remover nada.
  async run(planId) {
    if (this.mode === 'off') throw this.fail(409, 'retenção desligada (RETENTION_MODE=off)');
    if (this.busy) throw this.fail(409, 'já existe uma retenção em andamento');
    const plan = this.plans.get(String(planId ?? ''));
    if (!plan || this.now - plan.at > PLAN_TTL_MS) {
      this.plans.delete(String(planId ?? ''));
      throw this.fail(409, 'plano inexistente ou expirado: gere uma nova prévia e confirme com o plano mostrado');
    }
    this.plans.delete(String(planId));
    this.busy = true;
    try {
      return await this.execute(plan);
    } finally { this.busy = false; }
  }

  async execute(plan) {
    const b = this.bridge;
    // (1) O tracker decide: releitura forçada. Qualquer falha cancela tudo (fail-closed).
    const since = this.now;
    let res;
    try { res = await b.trackerCheck?.(plan.hashes, { force: true }); } catch (err) {
      log.warn(`retenção cancelada: tracker não consultado (${err?.message ?? err})`);
      throw this.fail(503, 'tracker indisponível: nada foi removido');
    }
    if (!res || res.failed) {
      log.warn('retenção cancelada: a conferência do tracker falhou');
      throw this.fail(503, 'tracker ou sessão indisponível: nada foi removido');
    }
    // (2) Recalcula com o dado fresco. A seleção da prévia vale como LISTA e ORDEM; o que mudou sai.
    const removidos = [];
    const ignorados = [];
    const falhas = [];
    let rootReal;
    try { rootReal = retention.realRoot(b.storeDir); } catch { throw this.fail(500, 'armazenamento ilegível: nada foi removido'); }
    const comp = this.compute(since);
    let bytes = comp.sel.totalBytes;
    let titles = comp.sel.totalTitles;
    const acima = () => (this.budgetBytes > 0 && bytes > this.budgetBytes) || (this.maxTitles > 0 && titles > this.maxTitles);
    for (const hash of plan.hashes) {
      if (!acima()) break;
      // (3) Reconferência síncrona imediatamente antes de agir, com a marca de manutenção logo depois.
      const item = this.evaluate(hash, rootReal, since);
      if (!item.eligible) { ignorados.push({ infoHash: hash, motivo: item.reason }); continue; }
      this.retiring.add(hash);
      try {
        const r = await this.retire(item);
        if (r.erro) { falhas.push({ infoHash: hash, motivo: r.erro }); continue; }
        bytes -= item.bytes;
        titles -= 1;
        removidos.push({ infoHash: hash, nome: item.name, bytes: r.bytes, falhasDeArquivo: r.failed.length });
        if (r.failed.length) falhas.push({ infoHash: hash, motivo: 'alguns arquivos permaneceram', detalhes: r.failed });
      } finally { this.retiring.delete(hash); }
    }
    b.duCache = null;
    const bytesLiberados = removidos.reduce((a, r) => a + r.bytes, 0);
    log.info(`retenção concluída: ${removidos.length} título(s) removido(s), ${fmtBytes(bytesLiberados)}; ${ignorados.length} ignorado(s)`);
    return { removidos, ignorados, falhas, bytesLiberados, alvoAtingido: !acima() };
  }

  // Encerra o torrent (sem apagar pelo motor) e remove os arquivos listados. Só com o torrent
  // encerrado de verdade os arquivos são tocados.
  async retire(item) {
    const b = this.bridge;
    const hash = item.infoHash;
    const torrent = b.client?.torrents?.find((x) => x.infoHash === hash);
    if (torrent) {
      try {
        await new Promise((resolve, reject) => {
          try { torrent.destroy({ destroyStore: false }, (err) => (err ? reject(err) : resolve())); } catch (e) { reject(e); }
        });
      } catch (err) {
        log.warn(`retenção: não foi possível encerrar ${short(hash)}: ${err?.message ?? err}`);
        return { erro: 'falha-ao-encerrar-o-torrent' };
      }
      b.completing.delete(hash);
      b.startedAt.delete(hash);
      b.lastTick.delete(hash);
    }
    const r = retention.removeFiles(b.storeDir, item.files);
    if (r.removed > 0) b.vault.markReleased(hash, 'retencao');
    log.info(`retenção: "${item.name.slice(0, 50)}" (${short(hash)}) ${r.removed} arquivo(s), ${fmtBytes(r.bytes)}${r.failed.length ? `, ${r.failed.length} permaneceram (${[...new Set(r.failed.map((f) => f.reason))].join(', ')})` : ''}`);
    return r;
  }
}

module.exports = { Retention, PLAN_TTL_MS };
