// Proteção contra hit-and-run (regras 13.1, 13.3 a 13.5 do ASC).
//
// O cofre local (`seedvault.js`) é uma ESTIMATIVA: conta tempo com o torrent
// ativo, mesmo que o announce tenha falhado ou o tracker ainda não tenha
// creditado. A verdade é `myHistory` na página do torrent. Este módulo lê esse
// registro, concilia com o cofre (o tracker vence) e gera avisos de risco.
//
// Só lê dados da própria conta, uma página por torrent, pela fila serializada
// do AscClient (intervalo mínimo entre chamadas).

const log = require('./logger').logger.child('hnr');

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WARN_DEADLINE_DAYS = 4;
const STALE_TRACKER_MS = 6 * HOUR_MS;

// Medido em myHistory real: `deadline` e `lastAnnouncedAt` vêm como
// 'YYYY-MM-DD HH:MM:SS' SEM fuso, e o site opera em UTC. Sem tratar isso o
// Date.parse leria como horário local e o prazo mudaria em horas.
// Também aceita ISO com fuso, epoch em segundos e em ms.
const SITE_LOCAL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const text = String(value).trim();
  const parsed = Date.parse(SITE_LOCAL.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) ? null : n;
}

// `myHistory` -> resumo mínimo. `null` quando a conta não tem registro do torrent.
function normalizeHistory(history) {
  if (!history || typeof history !== 'object') return null;
  const completedAtMs = toMs(history.completedAt);
  const remainingSeedS = toNumber(history.remainingSeedTime);
  const hitAndRunAtMs = toMs(history.hitAndRunAt);
  const forgiven = toMs(history.forgivenAt) !== null;
  return {
    status: typeof history.status === 'string' ? history.status : null,
    completedAtMs,
    seedTimeS: toNumber(history.seedTime),
    remainingMs: remainingSeedS === null ? null : Math.max(0, remainingSeedS * 1000),
    deadlineMs: toMs(history.deadline),
    // Perdoado pela staff encerra a pendência; HnR sem perdão segue valendo.
    hitAndRun: hitAndRunAtMs !== null && !forgiven,
    forgiven,
    // Cumprido = concluiu e o tracker não deve mais nenhum segundo de seed.
    satisfied: forgiven || (completedAtMs !== null && remainingSeedS === 0),
  };
}

// Id do torrent no ASC, a partir de `asc-<id>.torrent`; null para outros nomes.
function ascIdFromPath(torrentPath) {
  const m = /(?:^|[\\/])asc-(\d+)\.torrent$/.exec(String(torrentPath ?? ''));
  return m ? m[1] : null;
}

// O tracker confirmou o cumprimento (13.1)? É a condição única para liberar disco ou rede:
// releaseSatisfied() e a retenção por orçamento usam esta mesma função.
function trackerConfirmed(entry) {
  return Boolean(entry?.satisfiedAt && entry.tracker?.satisfied);
}

// Concilia o cofre com o tracker. Devolve contagens, sem logar nada sensível.
async function reconcile({ asc, vault, only = null, force = false }) {
  const result = { checked: 0, failed: 0, semRegistro: 0, ajustados: 0 };
  for (const entry of vault.list()) {
    if (only && !only.includes(entry.infoHash)) continue;
    const id = ascIdFromPath(entry.torrentPath);
    if (!id) continue;
    // Já confirmado pelo tracker: não há o que revalidar (a retenção, antes de remover, força a releitura).
    if (!force && entry.tracker?.satisfied && entry.satisfiedAt) continue;
    try {
      log.debug(`conferindo o torrent ${id} no tracker`);
      const page = await asc.history(id);
      if (typeof page?.freeleech === 'boolean') vault.setFreeleech(entry.infoHash, page.freeleech);
      if (page?.name) vault.setDisplayName(entry.infoHash, page.name);
      const snapshot = normalizeHistory(page?.history);
      result.checked++;
      if (!snapshot) { result.semRegistro++; continue; }
      const before = `${entry.satisfiedAt}|${entry.completedAt}|${entry.seedMs}`;
      vault.setTracker(entry.infoHash, snapshot);
      const after = vault.get(entry.infoHash);
      if (before !== `${after.satisfiedAt}|${after.completedAt}|${after.seedMs}`) result.ajustados++;
    } catch (error) {
      result.failed++;
      log.warn(`conciliação interrompida no torrent ${id}: ${error?.message ?? error}`);
      // Sessão expirada, desafio do site etc.: interrompe em vez de insistir.
      break;
    }
  }
  return result;
}

// Lê /atividade: adota no cofre as obrigações que o tracker já tem e que a ponte
// ainda não conhecia (ex.: concluídas numa sessão anterior ao cofre) e lista as
// que não têm .torrent local. Só lê dados da própria conta.
async function syncActivity({ asc, vault, entries }) {
  const activity = await asc.activity();
  const local = new Map();
  for (const entry of entries.values()) {
    const id = ascIdFromPath(entry.torrentPath);
    if (id) local.set(id, entry);
  }
  const pending = [];
  let adopted = 0;
  for (const row of activity.pending) {
    const ascId = String(row?.torrent?.id ?? '');
    if (!/^\d+$/.test(ascId)) continue;
    const snapshot = normalizeHistory(row);
    if (!snapshot) continue;
    const entry = local.get(ascId) ?? null;
    if (entry) {
      if (!vault.get(entry.infoHash)) {
        vault.markSeen(entry.infoHash, {
          name: entry.title ?? entry.name ?? String(row.torrent.name),
          torrentPath: entry.torrentPath,
          freeleech: entry.freeleech ?? null,
        });
        adopted++;
      }
      vault.setTracker(entry.infoHash, snapshot);
      vault.setDisplayName(entry.infoHash, row.torrent?.name);
    }
    pending.push({
      ascId,
      name: String(row.torrent?.name ?? `torrent ${ascId}`),
      infoHash: entry?.infoHash ?? null,
      local: Boolean(entry),
      snapshot,
    });
  }
  log.debug(`atividade lida: ${pending.length} obrigação(ões) aberta(s), ${adopted} adotada(s) agora`, { hitAndRuns: activity.summary?.hitAndRuns, pendingSeeds: activity.summary?.pendingSeeds, prisonUntil: activity.summary?.prisonUntil });
  return { summary: activity.summary, pending, adopted };
}

// Avisos de risco de um torrent, em texto. `active` = infoHashes ativos no motor.
function warningsFor({ vault, entry, active = new Set(), now = Date.now() }) {
  const out = [];
  {
    const label = String(entry.displayName ?? entry.name ?? entry.infoHash).slice(0, 50);
    const tracker = entry.tracker;
    if (tracker?.hitAndRun) {
      out.push(`${label}: o tracker registrou hit-and-run. Parar de semear de novo é reincidência (regra 13.5): continue semeando.`);
    }
    if (!entry.completedAt || entry.satisfiedAt) return out;

    const faltamH = Math.max(0, (vault.requiredMs - entry.seedMs) / HOUR_MS);
    const prazo = vault.deadlineMs(entry.infoHash);
    const dias = prazo === null ? null : (prazo - now) / DAY_MS;
    const inativo = !active.has(entry.infoHash);

    if (entry.seedMs >= vault.requiredMs) {
      out.push(`${label}: tempo local cumprido, aguardando o tracker confirmar (mantenha ativo até a próxima conciliação).`);
    } else if (dias !== null && dias <= 0) {
      out.push(`${label}: prazo de 12 dias vencido com ${faltamH.toFixed(1)} h de seed pendentes. Risco de HnR agora (regra 13.3).`);
    } else if (inativo) {
      out.push(`${label}: ${faltamH.toFixed(1)} h de seed pendentes e o torrent NÃO está ativo${dias !== null ? `; prazo em ${dias.toFixed(1)} dia(s)` : ''}.`);
    } else if (dias !== null && dias <= WARN_DEADLINE_DAYS) {
      out.push(`${label}: ${faltamH.toFixed(1)} h pendentes e prazo em ${dias.toFixed(1)} dia(s).`);
    }
    if (!tracker || now - tracker.checkedAt > STALE_TRACKER_MS) {
      if (entry.torrentPath && ascIdFromPath(entry.torrentPath)) {
        out.push(`${label}: sem conferência recente com o tracker (entre de novo no addon se a sessão expirou).`);
      }
    }
  }
  return out;
}

function warnings({ vault, active = new Set(), now = Date.now() }) {
  return vault.list().flatMap((entry) => warningsFor({ vault, entry, active, now }));
}

module.exports = {
  toMs,
  normalizeHistory,
  ascIdFromPath,
  trackerConfirmed,
  reconcile,
  syncActivity,
  warnings,
  warningsFor,
  WARN_DEADLINE_DAYS,
  STALE_TRACKER_MS,
};
